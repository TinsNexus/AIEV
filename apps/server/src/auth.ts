import crypto from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { nanoid } from "nanoid";
import {
  addAuditEntry,
  clearLoginAttempt,
  countUsers,
  deleteSession,
  getLoginAttempt,
  getSessionByHash,
  getUserById,
  getUserByUsername,
  insertSession,
  pruneExpiredSessions,
  setUserPassword,
  touchSession,
  touchUserLogin,
  upsertLoginAttempt,
  type UserRole,
  type UserRow,
} from "./db.js";
import { HttpError, cookieValue, isLocalRequest, nowIso, secretEquals } from "./util.js";
import { apiToken, isAllowedWebOrigin } from "./config.js";
import { isKnownUploadToken } from "./routes/uploadSession.js";

/**
 * Lõi auth (đăng nhập) + authz (vai trò).
 *
 * File này CHỈ có logic; SQL nằm ở db.ts, còn route HTTP và bảng chính sách
 * gắn vào middleware là bước sau. Chưa có gì ở đây được nối vào index.ts, nên
 * thêm file này KHÔNG đổi hành vi hệ thống đang chạy.
 *
 * Vì sao tự viết chứ không kéo passport/lucia/next-auth: hệ thống này chỉ cần
 * mật khẩu + phiên trong SQLite, mà mọi thư viện kia đều kéo theo hàng chục
 * dependency và một mô hình vòng đời riêng - trong khi người dùng cài dự án
 * này từ GitHub trên máy Windows, mỗi dependency native là một cửa hỏng cài đặt.
 */

// ------------------------------------------------------------- Vai trò

/** admin > editor > viewer - so sánh bằng số, đừng so bằng chuỗi */
const ROLE_RANK: Record<UserRole, number> = { viewer: 1, editor: 2, admin: 3 };

export const ROLES: UserRole[] = ["viewer", "editor", "admin"];

export function isRole(value: unknown): value is UserRole {
  return typeof value === "string" && value in ROLE_RANK;
}

/** Vai trò `have` có đủ mạnh cho yêu cầu `need` không? */
export function roleAtLeast(have: UserRole, need: UserRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

// -------------------------------------------------------- Băm mật khẩu

/**
 * scrypt của `node:crypto` - CỐ Ý không dùng bcrypt/argon2.
 *
 * Cả hai thư viện kia đều là native module phải biên dịch lúc cài. Dự án này
 * người dùng cài từ GitHub và phần lớn chạy trên Windows (xem CLAUDE.md mục 3),
 * nơi `npm ci` không có sẵn build tools - thêm một native dep nữa là thêm một
 * kiểu hỏng cài đặt mà mình phải đi vá. scrypt có sẵn trong Node 22, là hàm
 * dẫn xuất khoá chống ASIC/GPU đúng chuẩn, đủ tốt cho đúng việc này.
 *
 * Định dạng lưu: `scrypt$N$r$p$<salt base64>$<hash base64>` - có kèm tham số
 * nên sau này chỉnh N lên vẫn xác thực được hash cũ (xem needsRehash).
 */
// 2^15. ĐO THẬT trên VPS này: ~286ms một lần băm. Chậm là cố ý (đó là điểm của
// hàm băm mật khẩu), nhưng nhớ hệ quả: mỗi lần thử đăng nhập tốn ~0,3s CPU, nên
// rate limit ở dưới không phải phần trang trí - thiếu nó là có đường DoS.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
// 128 * N * r = 32MB, đúng bằng maxmem mặc định của Node nên nó ném lỗi
// "memory limit exceeded". Phải nới tay, đừng hạ N để lách.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const PASSWORD_MIN_LENGTH = 10;

/**
 * Mật khẩu có dùng được không - trả về câu lỗi tiếng Việt, hoặc null nếu đạt.
 *
 * Cố ý chỉ ép ĐỘ DÀI, không ép "phải có hoa/thường/số/ký tự đặc biệt": luật
 * kiểu đó đẩy người dùng tới `Matkhau@1` - ngắn, dễ đoán, và họ ghi ra giấy.
 * Độ dài là thứ thực sự làm chi phí dò tăng theo hàm mũ.
 */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Mật khẩu phải dài ít nhất ${PASSWORD_MIN_LENGTH} ký tự`;
  }
  if (password.length > 200) return "Mật khẩu quá dài (tối đa 200 ký tự)";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Chặn hash bịa đặt với tham số khổng lồ biến việc xác thực thành DoS
  if (N > 1 << 20 || r > 32 || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** Hash sinh bằng tham số CŨ hơn hiện tại → nên băm lại lúc user đăng nhập thành công */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < SCRYPT_N || Number(parts[2]) < SCRYPT_R || Number(parts[3]) < SCRYPT_P;
}

/**
 * Băm giả để tiêu tốn đúng lượng thời gian như một lần xác thực thật.
 *
 * Không có nó thì "tài khoản không tồn tại" trả lời nhanh hơn hẳn "sai mật
 * khẩu", và kẻ tấn công bấm giờ là dò ra được danh sách tên đăng nhập có thật.
 */
let dummyHashPromise: Promise<string> | null = null;
async function burnVerifyTime(password: string): Promise<void> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("tisorr-dummy-password");
  await verifyPassword(password, await dummyHashPromise);
}

// ------------------------------------------------------------- IP thật

/**
 * IP của client. Mặc định KHÔNG tin `X-Forwarded-For`.
 *
 * Đằng sau nginx (aaPanel) thì socket luôn là 127.0.0.1, nên rate limit theo
 * IP sẽ gộp cả thiên hạ vào một khoá và một kẻ dò mật khẩu khoá được toàn bộ
 * người dùng khác. Nhưng tin XFF một cách vô điều kiện còn tệ hơn: ai cũng tự
 * đặt header đó được, tức là tự cấp cho mình IP mới sau mỗi lần đoán sai.
 *
 * Cách đúng là ĐẾM SỐ PROXY: đặt TRUST_PROXY_HOPS=1 khi đứng sau đúng một
 * reverse proxy mình kiểm soát, rồi lấy phần tử thứ 1 TỪ PHẢI SANG - đó là
 * giá trị do chính proxy đó ghi, phần bên trái có thể do client bịa.
 */
export function clientIp(req: Request): string {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  const socketIp = req.socket.remoteAddress ?? "";
  if (!Number.isInteger(hops) || hops <= 0) return socketIp;
  const raw = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;
  const idx = chain.length - hops;
  return chain[idx >= 0 ? idx : 0] ?? socketIp;
}

// -------------------------------------------------------------- Phiên

/** Tên cookie phiên. HttpOnly - khác hẳn cookie token cũ (`xts_token`) mà JS đọc được. */
export const SESSION_COOKIE = "xts_sid";

/** Hạn tuyệt đối: hết là phải đăng nhập lại, dù vẫn đang dùng liên tục */
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** Hạn trượt: không đụng tới trong ngần này thì phiên chết */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Chỉ ghi lại lastSeenAt khi đã quá mốc này - không thì mỗi request là một lần ghi đĩa */
const SESSION_TOUCH_MS = 5 * 60 * 1000;

/** Session id thật chỉ nằm trong cookie; DB giữ SHA-256 của nó */
function hashSessionId(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex");
}

export interface AuthContext {
  user: UserRow;
  /** Hash của phiên (khoá trong bảng sessions), không phải id trong cookie */
  sessionHash: string;
  /** Nguồn xác thực - bước sau sẽ thêm "loopback" và "machine-token" */
  via: "session";
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/** Tạo phiên mới, trả về id THẬT để đặt vào cookie (không lưu lại ở đâu khác) */
export function createSession(user: UserRow, req: Request): { token: string; expiresAt: string } {
  const token = nanoid(40);
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_ABSOLUTE_MS).toISOString();
  insertSession({
    id: hashSessionId(token),
    userId: user.id,
    createdAt: nowIso(),
    expiresAt,
    idleExpiresAt: new Date(now + SESSION_IDLE_MS).toISOString(),
    lastSeenAt: nowIso(),
    ip: clientIp(req),
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
  });
  return { token, expiresAt };
}

/**
 * Đọc cookie phiên → tài khoản, hoặc null. Có tác dụng phụ có chủ đích: phiên
 * hết hạn thì xoá khỏi DB, phiên còn sống thì gia hạn trượt.
 */
export function sessionFromRequest(req: Request): AuthContext | null {
  const raw = cookieFromHeader(req, SESSION_COOKIE);
  if (!raw) return null;
  const hash = hashSessionId(raw);
  const row = getSessionByHash(hash);
  if (!row) return null;

  const now = Date.now();
  if (Date.parse(row.expiresAt) <= now || Date.parse(row.idleExpiresAt) <= now) {
    deleteSession(hash);
    return null;
  }

  const user = getUserById(row.userId);
  // Tài khoản bị xoá hoặc bị khoá giữa chừng - phiên phải chết theo NGAY, không
  // đợi hết hạn, nếu không thì "vô hiệu hoá tài khoản" chẳng có tác dụng gì.
  if (!user || user.status !== "active") {
    deleteSession(hash);
    return null;
  }

  if (now - Date.parse(row.lastSeenAt) > SESSION_TOUCH_MS) {
    touchSession(hash, new Date(now + SESSION_IDLE_MS).toISOString());
  }
  return { user, sessionHash: hash, via: "session" };
}

export function revokeSession(sessionHash: string): void {
  deleteSession(sessionHash);
}

/**
 * Đọc cookie theo tên. KHÔNG dùng cookieValue() của util.ts: hàm đó trả về ""
 * cho cả "không có cookie" lẫn "cookie rỗng", ở đây cần phân biệt rõ.
 */
function cookieFromHeader(req: Request, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

/** Request này đang đi trên HTTPS? (sau nginx thì phải nhìn X-Forwarded-Proto) */
function isHttps(req: Request): boolean {
  if (req.protocol === "https") return true;
  const proto = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(proto) ? proto[0] : (proto ?? "")).split(",")[0]?.trim();
  return first === "https";
}

/**
 * Set-Cookie cho phiên.
 *
 * SameSite=Lax chứ không Strict: Strict thì mở dashboard từ một link bên ngoài
 * (email, chat) sẽ hiện ra màn hình đăng nhập dù đang có phiên sống - trông
 * như mất phiên. Lax đã đủ chặn CSRF cho các request đổi dữ liệu (POST/DELETE
 * cross-site không kèm cookie).
 */
export function sessionCookieHeader(req: Request, token: string, maxAgeSec: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.setHeader(
    "Set-Cookie",
    sessionCookieHeader(req, token, Math.floor(SESSION_ABSOLUTE_MS / 1000)),
  );
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader("Set-Cookie", sessionCookieHeader(req, "", 0));
}

// ------------------------------------------------------- Chống dò mật khẩu

const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_FAILS = 8;
const THROTTLE_LOCK_MS = 15 * 60 * 1000;

/**
 * Khoá theo CẢ HAI chiều, mỗi chiều chặn một kiểu tấn công khác nhau:
 * - `user:<tên>` chặn dò mật khẩu của một tài khoản từ nhiều IP (botnet).
 * - `ip:<địa chỉ>` chặn một máy quét lần lượt qua nhiều tài khoản.
 */
function attemptKeys(username: string, ip: string): string[] {
  return [`user:${username.toLowerCase()}`, `ip:${ip}`];
}

/** Còn bị khoá thì trả về số giây phải chờ, không thì 0 */
export function lockedSeconds(username: string, ip: string): number {
  let worst = 0;
  for (const key of attemptKeys(username, ip)) {
    const row = getLoginAttempt(key);
    if (!row?.lockedUntil) continue;
    const left = Date.parse(row.lockedUntil) - Date.now();
    if (left > worst) worst = left;
  }
  return worst > 0 ? Math.ceil(worst / 1000) : 0;
}

export function recordLoginFailure(username: string, ip: string): void {
  const now = Date.now();
  for (const key of attemptKeys(username, ip)) {
    const row = getLoginAttempt(key);
    // Cửa sổ cũ đã trôi qua → đếm lại từ đầu, không cộng dồn vô hạn đời đời
    const inWindow = row && now - Date.parse(row.windowStart) < THROTTLE_WINDOW_MS;
    const fails = (inWindow ? row.fails : 0) + 1;
    upsertLoginAttempt({
      key,
      fails,
      windowStart: inWindow ? row.windowStart : new Date(now).toISOString(),
      lockedUntil:
        fails >= THROTTLE_MAX_FAILS ? new Date(now + THROTTLE_LOCK_MS).toISOString() : null,
    });
  }
}

export function clearLoginFailures(username: string, ip: string): void {
  for (const key of attemptKeys(username, ip)) clearLoginAttempt(key);
}

// -------------------------------------------------------------- Đăng nhập

export type LoginResult =
  | { ok: true; user: UserRow; token: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "locked"; retryAfterSec: number };

/**
 * Kiểm tra tên/mật khẩu rồi mở phiên. KHÔNG đụng tới res - việc đặt cookie để
 * route tự làm (setSessionCookie), để hàm này test được mà không cần Response.
 */
export async function login(
  username: string,
  password: string,
  req: Request,
): Promise<LoginResult> {
  const ip = clientIp(req);
  const locked = lockedSeconds(username, ip);
  if (locked > 0) return { ok: false, reason: "locked", retryAfterSec: locked };

  const user = getUserByUsername(username);
  if (!user) {
    // Tiêu đúng lượng thời gian như một lần xác thực thật (xem burnVerifyTime)
    await burnVerifyTime(password);
    recordLoginFailure(username, ip);
    return { ok: false, reason: "invalid" };
  }

  const okPassword = await verifyPassword(password, user.passwordHash);
  if (!okPassword) {
    recordLoginFailure(username, ip);
    return { ok: false, reason: "invalid" };
  }

  // Sai mật khẩu và bị khoá là hai câu trả lời khác nhau, nhưng "đúng mật khẩu
  // mà tài khoản bị vô hiệu hoá" thì nói thẳng được: kẻ tấn công đã có mật khẩu
  // rồi, giấu thêm cũng không bảo vệ được gì, mà người dùng thật thì cần biết.
  if (user.status !== "active") return { ok: false, reason: "disabled" };

  clearLoginFailures(username, ip);
  // Đăng nhập là dịp duy nhất còn cầm mật khẩu thô để nâng cấp tham số băm
  if (needsRehash(user.passwordHash)) {
    setUserPassword(user.id, await hashPassword(password));
  }
  touchUserLogin(user.id);
  pruneExpiredSessions();
  const { token } = createSession(user, req);
  audit(req, user, "auth.login");
  return { ok: true, user, token };
}

export function logout(req: Request): void {
  const ctx = req.auth ?? sessionFromRequest(req);
  if (!ctx) return;
  audit(req, ctx.user, "auth.logout");
  revokeSession(ctx.sessionHash);
}

// ------------------------------------------------- Tài khoản admin đầu tiên

/** Chưa có tài khoản nào → hệ thống đang ở trạng thái cần dựng admin đầu tiên */
export function needsSetup(): boolean {
  return countUsers() === 0;
}

/**
 * Mã setup dùng một lần cho màn hình tạo admin đầu tiên.
 *
 * VÌ SAO phải có: dashboard này chạy trên domain công khai. Để `/setup` mở tự
 * do thì ai quét thấy trước sẽ tự phong mình làm admin - và admin ở đây có tab
 * Chat/AI chạy Bash trên server. Mã được in ra log lúc boot
 * (`journalctl -u tisorr-studio` hoặc `start/server.log`), tức là chỉ người có
 * quyền đọc log trên máy chủ mới dựng được admin đầu tiên.
 *
 * Sinh lại mỗi lần khởi động, và mất tác dụng ngay khi đã có một tài khoản.
 */
let cachedSetupCode: string | null = null;
export function setupCode(): string {
  if (!cachedSetupCode) cachedSetupCode = nanoid(24);
  return cachedSetupCode;
}

/** So khớp mã setup theo thời gian hằng */
export function setupCodeMatches(code: string): boolean {
  const expected = setupCode();
  if (code.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(code, "utf8"), Buffer.from(expected, "utf8"));
}

/** Quên mã cũ sau khi đã dùng - không để nó còn giá trị trong suốt đời tiến trình */
export function resetSetupCode(): void {
  cachedSetupCode = null;
}

// ----------------------------------------------------------- Danh tính

/**
 * Máy/CLI (loopback trực tiếp, XTS_API_TOKEN) có được coi là admin không?
 *
 * Mặc định CÓ, và đó là thứ giữ cho hệ thống dùng được: agent Claude, script
 * `start/`, health check của `deploy/deploy.sh` đều gọi API mà không có tài
 * khoản nào để đăng nhập. Ai có shell trên máy chủ thì đằng nào cũng toàn
 * quyền, nên đây không phải chỗ hở thêm.
 *
 * Đặt XTS_DISABLE_MACHINE_TOKEN=1 trong .env để tắt đường token dùng chung khi
 * đã tạo xong tài khoản thật và muốn mọi người phải đăng nhập.
 */
const MACHINE_TOKEN_DISABLED = process.env.XTS_DISABLE_MACHINE_TOKEN === "1";

export type Identity =
  | { kind: "session"; ctx: AuthContext }
  /** Loopback trực tiếp hoặc token dùng chung - quyền ngang admin */
  | { kind: "machine" }
  /** Token phiên QR (`?k=`) - chỉ đủ cho trang /m trên điện thoại */
  | { kind: "upload" }
  | null;

function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Ai đang gọi? Dùng chung cho middleware phân quyền (index.ts) và
 * GET /api/auth/me - phải là MỘT hàm, vì hai nơi trả lời khác nhau về cùng một
 * request là đúng kiểu lỗi "web đá người dùng về màn hình đăng nhập trong khi
 * họ vẫn gọi API được".
 */
export function identify(req: Request): Identity {
  const ctx = sessionFromRequest(req);
  if (ctx) return { kind: "session", ctx };

  // Đường loopback KHÔNG cần token, nên nó là đích của CSRF: một trang web bất
  // kỳ nạn nhân đang mở có thể bắn `fetch('http://localhost:6869/api/...',
  // { mode: 'no-cors' })`. Trình duyệt chặn ĐỌC phản hồi, nhưng request VẪN
  // chạy - đủ để gọi các POST không cần body (`/api/update/apply` chạy
  // update.sh, `/api/tunnel/start` mở tunnel công khai).
  //
  // Trình duyệt luôn gửi `Origin` cho request khác GET/HEAD (kể cả no-cors và
  // form submit), và JS không ghi đè được nó. Nên: có `Origin` lạ → KHÔNG được
  // hưởng quyền loopback. Client không phải trình duyệt (curl, agent, script
  // start) không gửi `Origin` → không ảnh hưởng.
  const origin = req.headers.origin;
  const originAllowed =
    typeof origin !== "string" || origin === "" || isAllowedWebOrigin(origin);
  if (originAllowed && isLocalRequest(req)) return { kind: "machine" };

  if (!MACHINE_TOKEN_DISABLED) {
    const token = apiToken();
    const header = req.headers["x-xts-token"];
    if (typeof header === "string" && secretEquals(header, token)) return { kind: "machine" };
    if (secretEquals(cookieValue(req, "xts_token"), token)) return { kind: "machine" };
    if (secretEquals(queryString(req.query?.t), token)) return { kind: "machine" };
  }

  const k = queryString(req.query?.k);
  if (k && isKnownUploadToken(k)) return { kind: "upload" };

  return null;
}

/** Vai trò hiệu lực của một danh tính - máy/CLI ngang admin, xem ghi chú trên */
export function effectiveRole(id: Identity): UserRole | null {
  if (!id) return null;
  if (id.kind === "session") return id.ctx.user.role;
  if (id.kind === "machine") return "admin";
  return null; // upload token không mang vai trò, đi đường riêng
}

// ------------------------------------------------------------ Middleware

/**
 * Bắt buộc đã đăng nhập. CHƯA được nối vào index.ts - việc gắn vào bảng chính
 * sách theo route là bước 3, làm cùng lúc với đường loopback và machine token.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const ctx = sessionFromRequest(req);
  if (!ctx) {
    throw new HttpError(401, "UNAUTHORIZED", "Cần đăng nhập");
  }
  req.auth = ctx;
  next();
}

/** Bắt buộc vai trò tối thiểu. Luôn đặt SAU requireAuth trong chuỗi middleware. */
export function requireRole(need: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.auth;
    if (!ctx) throw new HttpError(401, "UNAUTHORIZED", "Cần đăng nhập");
    if (!roleAtLeast(ctx.user.role, need)) {
      throw new HttpError(403, "FORBIDDEN", `Thao tác này cần quyền ${need}`);
    }
    next();
  };
}

// ----------------------------------------------------------------- Audit

/** Ghi một dòng nhật ký "ai làm gì" - dùng cho login, đổi quyền, chạy agent, xoá project */
export function audit(
  req: Request,
  user: UserRow | null,
  action: string,
  target = "",
  detail = "",
): void {
  addAuditEntry({
    userId: user?.id ?? null,
    username: user?.username ?? "",
    action,
    target,
    ip: clientIp(req),
    detail,
  });
}
