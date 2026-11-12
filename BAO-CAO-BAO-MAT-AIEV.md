# Báo cáo bảo mật & kế hoạch vá — AIEV

**Repo:** `notivn/AIEV` @ `31f4b36` · **Ngày:** 07/08/2026
**Phạm vi:** `apps/server` (middleware xác thực, routes), `.claude/settings.json`, luồng token của `apps/web`
**Phương pháp:** đọc mã nguồn + dựng server thật, bắn request thô để xác nhận từng lỗi trước và sau khi vá

---

## 1. Tóm tắt điều hành

| # | Lỗi | Mức | Trạng thái |
|---|---|---|---|
| **F-1** | DNS rebinding → lộ `apiToken` → RCE | 🔴 Critical | ✅ Đã vá & xác nhận |
| **F-2** | CSRF trên đường loopback (chạy `update.sh`, mở tunnel) | 🟠 High | ✅ Đã vá & xác nhận |
| **F-3** | Allowlist `.claude/settings.json` bỏ qua được bằng `node -e` / `curl` | 🟡 Medium | ⚠️ Giảm thiểu, không vá triệt để được |
| **F-4** | Không có test cho lớp xác thực | 🟡 Medium | ✅ Đã thêm `scripts/security-smoke.mjs` |

**Kết quả đo được:** bộ kiểm 8 mục — code gốc **3/8 PASS**, sau vá **8/8 PASS**.

Điểm quan trọng: `POST /api/update/apply` trên code gốc trả **202** khi bị bắn từ `Origin` lạ, tức là script update **thật sự chạy**. Đây không phải lỗi lý thuyết.

---

## 2. F-1 — DNS rebinding làm lộ API token (Critical)

### Vị trí
`apps/server/src/util.ts:36` — `isLocalRequest()`
`apps/server/src/routes/health.ts:70` — nơi trao token

### Nguyên nhân
`isLocalRequest()` kết luận "request đến từ chính máy này" dựa trên hai thứ:
1. socket là `127.0.0.1` / `::1`
2. không có header `x-forwarded-*`

Thiếu điều kiện thứ ba: **header `Host`**. Đó chính là chỗ DNS rebinding chui vào.

### Chuỗi khai thác

```
1. Kẻ tấn công dựng evil.example, phục vụ HTTP trên đúng cổng 6869, DNS TTL = 0
2. Nạn nhân (đang chạy AIEV) mở http://evil.example:6869/
3. DNS rebind: evil.example → 127.0.0.1
4. Trang gọi fetch('/api/health')
      → trình duyệt coi là SAME-ORIGIN: không preflight, không gửi Origin,
        CORS không chặn, JS ĐỌC ĐƯỢC body
      → server: socket loopback ✓, không x-forwarded-* ✓  →  trả apiToken
5. Có token → POST /api/chat → agent chạy với permissionMode "acceptEdits"
   + tool Bash  →  RCE dưới quyền người dùng
```

`SECURITY.md` của chính repo liệt kê *"khiến server trao token cho máy ở xa"* là in-scope — đây đúng là ca đó.

### Vì sao `Host` là chốt chặn đúng
`Host` là thứ duy nhất trong request còn giữ tên miền mà **trình duyệt nghĩ nó đang gọi**. Trang đã rebind vẫn gửi `Host: evil.example:6869`. Và `Host` là *forbidden header name* — JS không ghi đè được. Nên kiểm ở đây là kiểm đúng chỗ, không né được.

### Bản vá
`apps/server/src/util.ts`: thêm `hostIsLoopback(req)`, yêu cầu `Host` ∈ {`localhost`, `127.0.0.1`, `[::1]`} **và** cổng khớp `SERVER_PORT`; gọi nó ở cuối `isLocalRequest()`.

Sửa một chỗ, ăn cả ba nơi dùng: middleware ở `index.ts`, `/api/health`, và `routes/assets.ts:223`.

### Không gây hồi quy
- Dashboard trên chính máy → `Host: localhost:6869` ✓
- Điện thoại LAN upload thẳng backend → socket là IP LAN, vốn đã không phải loopback, vẫn đi bằng token `?k=` ✓
- Qua proxy Next / tunnel → đã bị loại bởi `x-forwarded-*`, không đổi ✓
- `curl`/agent/script start → `Host: localhost:6869` ✓

**Lưu ý duy nhất:** client HTTP/1.0 không gửi `Host` sẽ bị 401. Không có client nào như vậy trong repo.

---

## 3. F-2 — CSRF trên đường loopback (High)

### Vị trí
`apps/server/src/index.ts:143` — nhánh `if (isLocalRequest(req))` cho qua không cần token

### Nguyên nhân
Đường loopback không đòi token, nên bất kỳ trang web nào nạn nhân đang mở đều bắn được:

```js
fetch('http://localhost:6869/api/update/apply', { method: 'POST', mode: 'no-cors' })
```

Trình duyệt chặn **đọc** phản hồi, nhưng request **vẫn chạy**. Phần lớn endpoint thoát nạn nhờ `express.json()` chỉ parse `application/json` (buộc phải preflight), nhưng các POST **không cần body** thì lọt hết:

| Endpoint | Hậu quả | Đo được trên code gốc |
|---|---|---|
| `POST /api/update/apply` | `spawn("bash", ["update/update.sh"])` — git pull + npm install + restart | **202 (đã chạy)** |
| `POST /api/tunnel/start` | mở Cloudflare tunnel phơi máy ra internet | 409 (chỉ vì container không có `cloudflared`) |

### Bản vá
Trình duyệt **luôn** gửi `Origin` cho request khác GET/HEAD — kể cả `no-cors` và form submit — và JS không ghi đè được. Nên: có `Origin` lạ thì không được hưởng quyền loopback.

```ts
const origin = req.headers.origin;
const originAllowed =
  typeof origin !== "string" || origin === "" || isAllowedWebOrigin(origin);
if (originAllowed && isLocalRequest(req)) { next(); return; }
```

### Vì sao đặt ở nhánh loopback chứ không chặn cứng toàn cục
Dashboard mở qua Cloudflare Tunnel có `Origin: https://<domain>` — không nằm trong allowlist. Nhưng nó đi bằng **token**, và token thì không lấy được từ origin khác:
- header `x-aiev-token` → cần preflight → CORS chặn
- cookie `aiev_token` → đã là `SameSite=Lax` → không gửi cross-site trên POST
- query `?t=` → phải biết token từ trước

Nên đường token vẫn an toàn, và tunnel không gãy.

*(Ghi nhận: cookie đã có `SameSite=Lax` sẵn trong `apps/web/src/lib/api.ts` — làm đúng rồi, không cần sửa.)*

---

## 4. F-3 — Allowlist của agent không phải hàng rào (Medium)

### Hiện trạng
`.claude/settings.json` deny `Read(./.env)`, `Read(~/.ssh/**)`… nhưng allow:

```
Bash(node:*)   Bash(python:*)   Bash(curl:*)
```

`node -e "console.log(require('fs').readFileSync('.env','utf8'))"` đọc thẳng `.env`, vòng qua toàn bộ deny list. `curl` là kênh gửi ra.

### Vì sao không vá thẳng được
Chính các skill trong repo **cần** những lệnh đó để gọi API cục bộ:
- `video-pipeline/SKILL.md:61,87,88` — `curl -X POST http://localhost:6869/api/...`
- `video-pipeline/SKILL.md:137` — `node -e "fetch(url, {...})"` (workaround cho lỗi mất dấu tiếng Việt của curl trên Git Bash)
- `ai-illustrations/SKILL.md:27` — `curl` gọi `/api/illustrations`

Siết `node`/`curl` là gãy pipeline. Không có sandbox OS thì deny list chỉ là gờ giảm tốc.

### Điều đã làm đúng
`apps/server/src/editPrompt.ts:45-53` có rào prompt-injection tường minh: khai báo transcript/brief/tên file là **dữ liệu, không phải chỉ thị**, cấm đọc `.env`/`~/.claude`/`~/.ssh` và cấm gửi dữ liệu ra mạng. Đây là lớp phòng thủ chính hiện tại.

### Khuyến nghị (không phải vá, là chọn lựa)
1. **Sửa `SECURITY.md` cho khớp thực tế.** Hiện tài liệu ngụ ý allowlist là ranh giới; nên nói thẳng: prompt injection thành công = compromise, allowlist chỉ giảm tai nạn chứ không chống tấn công có chủ đích.
2. **Đưa secret ra khỏi tầm `cwd` của agent** — đọc key từ `~/.aiev/env` thay vì `<repo>/.env`. Không chặn được `node -e` nhưng bỏ được đường "đọc file ngay dưới chân".
3. **Thay `curl` bằng script bọc sẵn** trong `scripts/` chỉ gọi được `localhost:6869` — vừa giữ pipeline chạy, vừa bỏ được một kênh exfil tiện tay. `node -e` vẫn còn, nên đây là giảm bề mặt chứ không phải đóng.
4. **Nếu muốn hàng rào thật:** chạy agent trong container/`bwrap` với egress allowlist. Đây là thay đổi kiến trúc, không nằm trong đợt vá này.

---

## 5. F-4 — Không có test cho lớp xác thực

78k dòng, CI chỉ có `typecheck` + `build`. Middleware xác thực là chỗ sai thì mất trắng, mà lại không có gì canh.

**Đã thêm:** `scripts/security-smoke.mjs` — kiểm hộp đen 8 mục, chạy bằng `node:http` thô (fetch không set được `Host`, mà giả `Host` mới đúng là thứ cần thử).

```bash
npm run dev          # cần server 6869 đang chạy
node scripts/security-smoke.mjs
```

| Mục kiểm | Gốc | Sau vá |
|---|---|---|
| health từ Host loopback vẫn trả apiToken | PASS | PASS |
| API thường từ loopback vẫn 200 | PASS | PASS |
| health với Host lạ KHÔNG trả apiToken | **FAIL — token bị lộ** | PASS |
| API thường với Host lạ bị 401 | **FAIL** | PASS |
| Host loopback nhưng sai cổng bị 401 | **FAIL** | PASS |
| `POST /api/update/apply` Origin lạ bị 401 | **FAIL — nhận 202** | PASS |
| `POST /api/tunnel/start` Origin lạ bị 401 | **FAIL** | PASS |
| POST Origin dashboard hợp lệ không bị chặn | PASS | PASS |
| | **3/8** | **8/8** |

---

## 6. Kế hoạch triển khai

### Bước 1 — Áp patch (đã sẵn sàng)
```bash
git checkout -b security/loopback-hardening
git apply aiev-security-fix.patch
cp security-smoke.mjs scripts/
```
Chỉ chạm 2 file: `apps/server/src/util.ts` (+47), `apps/server/src/index.ts` (+20). Không đụng frontend, không đụng schema DB.

### Bước 2 — Xác minh
```bash
npm run typecheck                      # đã chạy: server PASS sạch
npm run dev
node scripts/security-smoke.mjs        # kỳ vọng 8/8
```

### Bước 3 — Hồi quy thủ công (những đường script không kiểm được)
- [ ] Mở dashboard `http://localhost:6868` → vào được, không đòi token
- [ ] Tạo project + upload file từ dashboard
- [ ] Mở QR "Kết nối điện thoại" → upload từ điện thoại LAN
- [ ] Nếu có tunnel: mở dashboard qua domain với `?t=<token>`
- [ ] Chạy một phiên chat agent ngắn

### Bước 4 — Đưa vào CI
Thêm job chạy server nền rồi bắn `security-smoke.mjs`. Đây là lưới an toàn cho lần refactor middleware sau — không có nó thì lỗi F-1 quay lại lúc nào không biết.

### Bước 5 — Tài liệu
- Cập nhật `SECURITY.md`: bỏ/sửa lại phần ngụ ý allowlist là hàng rào (mục F-3.1)
- Ghi vào comment `isLocalRequest` lý do có kiểm `Host` — đã làm trong patch, cùng văn phong với comment `safeFetch.ts`

### Bước 6 — Sau khi vá xong
Cân nhắc **public advisory**. Ai đã clone repo vẫn đang chạy bản thủng, và F-1 dẫn thẳng tới RCE. Repo có bật private reporting rồi, nên chỉ cần một GHSA + dòng ghi chú trong README là đủ.

---

## 7. Việc còn lại (ngoài phạm vi đợt này)

| Việc | Lý do |
|---|---|
| Test unit cho `safeFetch`, `reframe`, `color` | Logic thuần, dễ test, sai thì đau |
| Thêm eslint/prettier hoặc biome | `CONTRIBUTING.md` đã mời PR nhưng không có chuẩn tự động |
| Tách `apps/web/src/lib/api.ts` (3.635 dòng, 366 export) theo domain | Khó review, dễ merge conflict |
| Bóc state của `translate-video/[id]/page.tsx` (2.520 dòng, 46 hook) ra custom hooks | Như trên |
| Script CI kiểm key parity `en.ts` ↔ `vi.ts` | Hiện lệch 7 dòng |
| Giữ lại lịch sử git thay vì squash về 1 commit | Không bisect được khi có hồi quy |

---

## Phụ lục — Ghi chú về những thứ repo đã làm đúng

Để cân bằng: các lỗi trên là *ngoại lệ*, không phải mặt bằng chung của codebase.

- `safeFetch.ts` chống SSRF bằng ghim IP sau resolve + validate lại từng hop redirect — đúng chuẩn, và comment giải thích rõ tại sao không được lược bớt. Mỉa mai là chống rebinding rất kỹ ở đây nhưng sót ở lớp auth.
- `strict: true` cả 3 workspace, **0 chỗ dùng `any`** trên 78k dòng.
- SQL toàn prepared statement; `spawn` toàn truyền mảng args, không `shell: true`.
- `/media`: whitelist thư mục, `dotfiles: "deny"`, `nosniff`, ép download `.html/.xml`, CSP sandbox cho SVG.
- `secretEquals` dùng `timingSafeEqual`; `upsertEnvVar` chặn `\r\n` chống env injection.
- Error handler không rò stack/đường dẫn ra client.
