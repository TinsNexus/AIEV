import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { audit, hashPassword, isRole, validatePassword } from "../auth.js";
import {
  countActiveAdmins,
  createUser,
  deleteSessionsForUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  listAuditEntries,
  listUsers,
  setUserDisplayName,
  setUserPassword,
  setUserRole,
  setUserStatus,
  userToApi,
  type UserRole,
} from "../db.js";
import { HttpError } from "../util.js";

/**
 * Quản lý tài khoản. Toàn nhánh /api/users là admin - khai báo ở policy.ts,
 * không lặp lại requireRole ở đây (một nguồn sự thật cho phân quyền).
 *
 * Nguyên tắc xuyên suốt file: KHÔNG cho phép tự khoá mình ra ngoài. Hạ vai
 * trò, vô hiệu hoá hay xoá admin cuối cùng đều bị chặn - dựng lại admin đầu
 * tiên đòi mã setup in trong log server, không phải thứ làm được từ giao diện.
 */

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

/** Ai gọi route này - middleware ở index.ts đã gắn req.auth cho phiên đăng nhập */
function actor(req: Request) {
  return req.auth?.user ?? null;
}

/**
 * Chặn thao tác làm mất người quản trị cuối cùng.
 * `target` là user sắp bị hạ quyền / khoá / xoá.
 */
function guardLastAdmin(target: { id: string; role: UserRole; status: string }): void {
  if (target.role !== "admin" || target.status !== "active") return;
  if (countActiveAdmins() > 1) return;
  throw new HttpError(
    409,
    "LAST_ADMIN",
    "Đây là admin đang hoạt động cuối cùng - hãy cấp quyền admin cho người khác trước",
  );
}

// GET /api/users
router.get("/", (_req: Request, res: Response) => {
  res.json({ users: listUsers().map(userToApi) });
});

// POST /api/users  { username, password, role, displayName? }
router.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const role = body.role;

  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "INVALID_USERNAME", "Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số và . _ -");
  }
  if (!isRole(role)) throw new HttpError(400, "INVALID_ROLE", "Vai trò không hợp lệ");
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
    role,
  });
  audit(req, actor(req), "user.create", user.username, `role=${role}`);
  res.status(201).json({ user: userToApi(user) });
});

// PATCH /api/users/:id  { role?, status?, displayName? }
router.patch("/:id", (req: Request, res: Response) => {
  const target = getUserById(String(req.params.id));
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const me = actor(req);

  if (body.role !== undefined) {
    if (!isRole(body.role)) throw new HttpError(400, "INVALID_ROLE", "Vai trò không hợp lệ");
    if (body.role !== target.role) {
      if (target.role === "admin") guardLastAdmin(target);
      setUserRole(target.id, body.role);
      // Vai trò đổi thì phiên đang mở phải mất hiệu lực NGAY: nếu không, người
      // vừa bị hạ quyền vẫn giữ quyền cũ tới khi họ tự đăng xuất.
      deleteSessionsForUser(target.id);
      audit(req, me, "user.role", target.username, `${target.role} → ${body.role}`);
    }
  }

  if (body.status !== undefined) {
    const status = body.status;
    if (status !== "active" && status !== "disabled") {
      throw new HttpError(400, "INVALID_STATUS", "Trạng thái không hợp lệ");
    }
    if (status !== target.status) {
      if (status === "disabled") {
        guardLastAdmin(target);
        if (me && me.id === target.id) {
          throw new HttpError(409, "SELF_DISABLE", "Không thể tự vô hiệu hoá tài khoản của mình");
        }
      }
      setUserStatus(target.id, status);
      if (status === "disabled") deleteSessionsForUser(target.id);
      audit(req, me, "user.status", target.username, status);
    }
  }

  if (typeof body.displayName === "string") {
    const name = body.displayName.trim();
    if (name) setUserDisplayName(target.id, name);
  }

  res.json({ user: userToApi(getUserById(target.id)!) });
});

// POST /api/users/:id/password  { newPassword } - admin đặt lại hộ người khác
router.post("/:id/password", async (req: Request, res: Response) => {
  const target = getUserById(String(req.params.id));
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const pwError = validatePassword(newPassword);
  if (pwError) throw new HttpError(400, "WEAK_PASSWORD", pwError);

  setUserPassword(target.id, await hashPassword(newPassword));
  // Đặt lại mật khẩu hộ = giả định tài khoản có vấn đề → cắt hết phiên cũ
  deleteSessionsForUser(target.id);
  audit(req, actor(req), "user.password-reset", target.username);
  res.status(204).end();
});

// DELETE /api/users/:id
router.delete("/:id", (req: Request, res: Response) => {
  const target = getUserById(String(req.params.id));
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản");
  const me = actor(req);
  if (me && me.id === target.id) {
    throw new HttpError(409, "SELF_DELETE", "Không thể tự xoá tài khoản của mình");
  }
  guardLastAdmin(target);
  deleteUser(target.id);
  audit(req, me, "user.delete", target.username);
  res.status(204).end();
});

// GET /api/users/audit/log?limit=100 - nhật ký "ai làm gì"
//
// Đặt dưới /api/users chứ không phải /api/audit để cả cụm quản trị người dùng
// nằm gọn sau MỘT dòng luật admin trong policy.ts.
router.get("/audit/log", (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 100);
  res.json({ entries: listAuditEntries(Number.isFinite(limit) ? limit : 100) });
});

export default router;
