import type { UserRole } from "./db.js";

/**
 * Bảng chính sách: đường nào cần vai trò nào.
 *
 * VÌ SAO một bảng tập trung chứ không rắc requireRole() vào 35 router: rắc vào
 * từng file thì không ai rà lại nổi "ai được làm gì" trong một lần đọc, và
 * route mới thêm sau này sẽ MẶC ĐỊNH KHÔNG có bảo vệ - kiểu sót nguy hiểm nhất
 * vì nó im lặng. Ở đây ngược lại: không khớp luật nào là TỪ CHỐI.
 *
 * Luật xét theo THỨ TỰ, luật đầu tiên khớp thì thắng - nên luật hẹp phải đứng
 * trên luật rộng. Hai luật bắt trọn ở cuối ("GET = viewer", "còn lại = editor")
 * chỉ an toàn nhờ mọi nhánh admin đã được liệt kê phía trên chúng.
 */

/** "public" = không cần đăng nhập; còn lại là vai trò tối thiểu */
export type Access = UserRole | "public";

interface Rule {
  /** Bỏ trống = áp cho mọi method */
  methods?: string[];
  re: RegExp;
  access: Access;
}

const RULES: Rule[] = [
  // ---- Công khai: đây là chỗ người chưa có gì trong tay phải đi qua
  { re: /^\/api\/health(\/|$)/, access: "public" },
  { re: /^\/api\/auth(\/|$)/, access: "public" },

  // ---- Admin: chạy lệnh trên máy, đụng khoá bí mật, hoặc mở cửa ra Internet
  //
  // Chat/AI chạy Claude agent có quyền Bash => ngang quyền root trên máy chủ.
  { re: /^\/api\/chat(\/|$)/, access: "admin" },
  // Khoá API của Gemini/Anthropic - đọc được là dùng được tiền của chủ máy
  { re: /^\/api\/connections(\/|$)/, access: "admin" },
  // Chạy script cập nhật (git pull + build + restart)
  { re: /^\/api\/update(\/|$)/, access: "admin" },
  // Mở tunnel = phơi dashboard ra Internet
  { re: /^\/api\/tunnel(\/|$)/, access: "admin" },
  // Cài đặt gói, dựng venv Python
  { re: /^\/api\/doctor(\/|$)/, access: "admin" },
  // Mở trình quản lý file trên chính máy chủ
  { re: /^\/api\/reveal(\/|$)/, access: "admin" },
  // Quản lý tài khoản + nhật ký audit
  { re: /^\/api\/users(\/|$)/, access: "admin" },
  // Skill là CHỈ DẪN cho agent - sửa được skill là lái được việc agent làm,
  // nên quyền ghi ngang với quyền chạy lệnh. Đọc thì để viewer xem.
  { methods: ["GET"], re: /^\/api\/skills(\/|$)/, access: "viewer" },
  { re: /^\/api\/skills(\/|$)/, access: "admin" },
  // Xoá hẳn một project (khớp ĐÚNG /api/projects/<id>, không có đoạn nào sau).
  // Phải tách khỏi luật editor bên dưới vì DELETE /api/projects/<id>/assets/<file>
  // chỉ là xoá một file trong project - việc thường ngày của editor.
  { methods: ["DELETE"], re: /^\/api\/projects\/[^/]+$/, access: "admin" },

  // ---- Đọc: mọi GET còn lại. Các nhánh nhạy cảm đã chặn ở trên rồi.
  { methods: ["GET"], re: /^\/api\//, access: "viewer" },
  { methods: ["GET", "HEAD"], re: /^\/media\//, access: "viewer" },

  // ---- Ghi: mọi thứ còn lại dưới /api (tạo project, render, upload, TTS...)
  { re: /^\/api\//, access: "editor" },
];

/**
 * Vai trò tối thiểu cho một request, hoặc null = từ chối thẳng (không luật nào
 * khớp). Trả null chứ không "admin" là có chủ đích: đường không nằm trong bảng
 * thì không ai đi được, kể cả admin - buộc người thêm route mới phải khai báo.
 */
export function requiredAccess(method: string, path: string): Access | null {
  const m = method.toUpperCase();
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(m)) continue;
    if (!rule.re.test(path)) continue;
    return rule.access;
  }
  return null;
}
