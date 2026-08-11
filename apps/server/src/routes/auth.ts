import { Router, type Request, type Response, type NextFunction } from "express";
import { nanoid } from "nanoid";
import {
  audit,
  clearSessionCookie,
  clientIp,
  createSession,
  effectiveRole,
  hashPassword,
  identify,
  login,
  logout,
  needsSetup,
  requireAuth,
  resetSetupCode,
  sessionFromRequest,
  setSessionCookie,
  setupCodeMatches,
  validatePassword,
  verifyPassword,
} from "../auth.js";
import {
  createUser,
  deleteSessionsForUser,
  getUserByUsername,
  setUserPassword,
  userToApi,
} from "../db.js";
import { HttpError } from "../util.js";

/**
 * Đăng nhập / đăng xuất / phiên hiện tại / dựng admin đầu tiên.
 *
 * Toàn bộ nhánh /api/auth được MIỄN middleware token chung ở index.ts - phải
 * vậy, vì đây chính là chỗ người dùng đi qua khi CHƯA có gì trong tay. Đổi lại,
 * mỗi route ở đây tự lo phần kiểm tra của mình, và không route nào được tin
 * vào việc "đã lọt tới đây nghĩa là đã xác thực".
 */

const router = Router();

// ------------------------------------------------------------ Rate limit

/**
 * Giới hạn theo IP, đếm trong bộ nhớ (mất khi restart - chấp nhận được).
 *
 * Khác với phần khoá tài khoản ở auth.ts: chỗ kia đếm LẦN SAI của một tài
 * khoản, ở đây đếm SỐ REQUEST bất kể đúng sai. Cần cả hai, vì kẻ tấn công đổi
 * tên đăng nhập liên tục thì mỗi tên là một khoá khoá mới toanh - không có
 * hàng rào theo IP thì họ bơm request vô hạn, mà mỗi lần lại tốn ~0,3s CPU băm.
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    b.count++;
    if (b.count > max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      throw new HttpError(429, "TOO_MANY_REQUESTS", `Thử lại sau ${retry} giây`);
    }
    next();
  };
}

// Dọn bucket hết hạn định kỳ để Map không phình theo số IP từng ghé qua
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

/**
 * Trần số lần băm mật khẩu chạy ĐỒNG THỜI.
 *
 * scrypt cố tình ngốn CPU (~0,3s/lần đo trên VPS này). Không có trần thì 100
 * request đăng nhập song song đủ chiếm hết CPU và làm đứng cả render queue -
 * rate limit theo IP không cứu được, vì attacker có nhiều IP.
 */
const MAX_CONCURRENT_HASHING = 4;
let hashingNow = 0;

function gateHashing(_req: Request, res: Response, next: NextFunction): void {
  if (hashingNow >= MAX_CONCURRENT_HASHING) {
    throw new HttpError(503, "BUSY", "Máy chủ đang bận xử lý đăng nhập, thử lại sau giây lát");
  }
  hashingNow++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    hashingNow--;
  };
  // "finish" bắn khi đã gửi xong response; "close" bắn cả khi client ngắt giữa
  // chừng. Phải nghe CẢ HAI: chỉ nghe "finish" thì mỗi lần người dùng đóng tab
  // lúc đang đăng nhập là rò một slot, đủ vài lần là kẹt vĩnh viễn ở 503.
  res.on("finish", release);
  res.on("close", release);
  next();
}

// ------------------------------------------------------------- Endpoints

/**
 * GET /api/auth/me - trạng thái phiên. CỐ Ý trả 200 kể cả khi chưa đăng nhập:
 * web dashboard gọi đây lúc khởi động để biết nên hiện màn hình đăng nhập hay
 * màn hình dựng admin đầu tiên, mà 401 thì client phải bắt lỗi mới đọc được.
 */
router.get("/me", (req: Request, res: Response) => {
  const id = identify(req);
  const role = effectiveRole(id);
  // Máy/CLI (loopback, XTS_API_TOKEN) KHÔNG có bản ghi user nhưng vẫn có quyền
  // admin - phải báo authenticated, nếu không web sẽ đá người đang dùng link
  // `?t=` về màn hình đăng nhập trong khi API của họ vẫn chạy ngon.
  if (!id || !role) {
    res.json({
      authenticated: false,
      needsSetup: needsSetup(),
      via: null,
      role: null,
      user: null,
    });
    return;
  }
  res.json({
    authenticated: true,
    needsSetup: needsSetup(),
    via: id.kind,
    role,
    user: id.kind === "session" ? userToApi(id.ctx.user) : null,
  });
});

// POST /api/auth/login  { username, password }
router.post(
  "/login",
  rateLimit("login", 20, 60_000),
  gateHashing,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      throw new HttpError(400, "MISSING_CREDENTIALS", "Thiếu tên đăng nhập hoặc mật khẩu");
    }

    const result = await login(username, password, req);
    if (!result.ok) {
      if (result.reason === "locked") {
        res.setHeader("Retry-After", String(result.retryAfterSec));
        throw new HttpError(
          429,
          "LOGIN_LOCKED",
          `Sai quá nhiều lần. Thử lại sau ${result.retryAfterSec} giây`,
        );
      }
      if (result.reason === "disabled") {
        throw new HttpError(403, "ACCOUNT_DISABLED", "Tài khoản đã bị vô hiệu hoá");
      }
      // Sai tên và sai mật khẩu trả về CÙNG một câu - đừng để kẻ dò biết
      // tên nào có thật (bên auth.ts còn cân cả thời gian trả lời cho khớp).
      throw new HttpError(401, "INVALID_CREDENTIALS", "Tên đăng nhập hoặc mật khẩu không đúng");
    }

    setSessionCookie(req, res, result.token);
    res.json({ user: userToApi(result.user) });
  },
);

// POST /api/auth/logout - idempotent, chưa đăng nhập gọi cũng 204
router.post("/logout", (req: Request, res: Response) => {
  logout(req);
  clearSessionCookie(req, res);
  res.status(204).end();
});

/**
 * POST /api/auth/setup  { code, username, password, displayName? }
 * Dựng admin đầu tiên. Chỉ chạy được khi CHƯA có tài khoản nào và mã khớp mã
 * in ra log lúc boot (xem setupCode() trong auth.ts).
 */
router.post(
  "/setup",
  rateLimit("setup", 10, 60_000),
  gateHashing,
  async (req: Request, res: Response) => {
    if (!needsSetup()) {
      throw new HttpError(409, "SETUP_DONE", "Hệ thống đã có tài khoản - dùng màn hình đăng nhập");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

    if (!setupCodeMatches(code)) {
      audit(req, null, "auth.setup.badcode");
      throw new HttpError(403, "BAD_SETUP_CODE", "Mã cài đặt không đúng");
    }
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw new HttpError(
        400,
        "INVALID_USERNAME",
        "Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số và . _ -",
      );
    }
    const pwError = validatePassword(password);
    if (pwError) throw new HttpError(400, "WEAK_PASSWORD", pwError);
    if (getUserByUsername(username)) {
      throw new HttpError(409, "USERNAME_TAKEN", "Tên đăng nhập đã tồn tại");
    }

    const user = createUser({
      id: `u_${nanoid(16)}`,
      username,
      displayName: displayName || username,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    // Mã đã dùng xong - không để nó còn giá trị tới hết đời tiến trình
    resetSetupCode();
    audit(req, user, "auth.setup", user.username);

    // Đăng nhập luôn: bắt người vừa đặt mật khẩu gõ lại ngay là vô nghĩa
    const { token } = createSession(user, req);
    setSessionCookie(req, res, token);
    res.status(201).json({ user: userToApi(user) });
  },
);

/**
 * POST /api/auth/password  { currentPassword, newPassword }
 * Tự đổi mật khẩu của mình. Đổi xong thu hồi MỌI phiên rồi cấp phiên mới:
 * đổi mật khẩu thường là vì nghi bị lộ, mà phiên cũ còn sống thì kẻ kia vẫn ở
 * trong nhà.
 */
router.post(
  "/password",
  rateLimit("password", 10, 60_000),
  gateHashing,
  requireAuth,
  async (req: Request, res: Response) => {
    const ctx = req.auth!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (!(await verifyPassword(currentPassword, ctx.user.passwordHash))) {
      audit(req, ctx.user, "auth.password.failed");
      throw new HttpError(403, "WRONG_PASSWORD", "Mật khẩu hiện tại không đúng");
    }
    const pwError = validatePassword(newPassword);
    if (pwError) throw new HttpError(400, "WEAK_PASSWORD", pwError);

    setUserPassword(ctx.user.id, await hashPassword(newPassword));
    deleteSessionsForUser(ctx.user.id);
    audit(req, ctx.user, "auth.password.changed");

    const { token } = createSession(ctx.user, req);
    setSessionCookie(req, res, token);
    res.status(204).end();
  },
);

export default router;
