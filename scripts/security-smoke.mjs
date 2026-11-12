#!/usr/bin/env node
/**
 * Kiểm tra hai lớp phòng thủ của middleware xác thực (apps/server/src/index.ts):
 *
 *   1. DNS rebinding - `Host` không phải loopback thì KHÔNG được coi là local,
 *      và `/api/health` KHÔNG được trả `apiToken`.
 *   2. CSRF - request có `Origin` lạ thì KHÔNG được hưởng quyền loopback.
 *
 * Chạy khi server 6869 đang chạy:  node scripts/security-smoke.mjs
 * Thoát mã 0 = tất cả PASS, mã 1 = có FAIL.
 *
 * Dùng node:http chứ không dùng fetch: `Host` là forbidden header, fetch không
 * cho ghi đè - mà giả `Host` mới đúng là thứ cần thử ở đây.
 */
import http from "node:http";

const PORT = Number(process.env.SERVER_PORT || 6869);
const HOST_LOCAL = `localhost:${PORT}`;

/** Gửi một request thô, trả { status, body } */
function req({ method = "GET", path = "/", host = HOST_LOCAL, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: PORT, method, path, headers: { host, ...headers } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

async function main() {
  console.log(`Kiểm tra backend tại http://127.0.0.1:${PORT}\n`);

  // --- 1. Đường loopback hợp lệ vẫn phải chạy được (chống vá quá tay) ---
  const good = await req({ path: "/api/health" });
  let token = "";
  try {
    token = JSON.parse(good.body).apiToken ?? "";
  } catch {
    /* body không phải JSON */
  }
  check("health từ Host loopback vẫn trả apiToken", good.status === 200 && token.length > 0);
  check("API thường từ loopback vẫn 200", (await req({ path: "/api/projects" })).status === 200);

  // --- 2. DNS rebinding ---
  const rebind = await req({ path: "/api/health", host: `evil.example:${PORT}` });
  const leaked = rebind.body.includes("apiToken");
  check("health với Host lạ KHÔNG trả apiToken", !leaked, leaked ? "TOKEN BỊ LỘ" : "");
  check(
    "API thường với Host lạ bị 401",
    (await req({ path: "/api/projects", host: `evil.example:${PORT}` })).status === 401,
  );
  check(
    "Host loopback nhưng SAI CỔNG bị 401",
    (await req({ path: "/api/projects", host: "localhost:1234" })).status === 401,
  );

  // --- 3. CSRF qua đường loopback ---
  for (const path of ["/api/update/apply", "/api/tunnel/start"]) {
    const res = await req({
      method: "POST",
      path,
      headers: { origin: "http://evil.example", "content-type": "text/plain" },
    });
    check(`POST ${path} với Origin lạ bị 401`, res.status === 401, `nhận ${res.status}`);
  }
  const sameOrigin = await req({
    method: "POST",
    path: "/api/tunnel/stop",
    headers: { origin: "http://localhost:6868", "content-type": "application/json" },
    body: "{}",
  });
  check(
    "POST với Origin dashboard hợp lệ KHÔNG bị chặn",
    sameOrigin.status !== 401,
    `nhận ${sameOrigin.status}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Không chạy được kiểm tra:", err.message);
  console.error("Server 6869 đã chạy chưa? (npm run dev)");
  process.exit(2);
});
