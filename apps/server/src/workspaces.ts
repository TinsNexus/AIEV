import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { HEX_RE, normHexColor } from "./styles.js";
import { ensureDir, isKebabCase, nowIso, toKebabAscii } from "./util.js";

/**
 * Workspace - nhóm nhiều project (video-projects/<id> hoặc image-projects/<id>)
 * lại với nhau để dễ chuyển đổi/qua lại, KHÔNG di chuyển hay đụng file của
 * project. Nguồn sự thật: assets/workspaces/workspaces.json = { workspaces }.
 *
 * Vì sao JSON thay vì SQLite (jobs/chat): workspace chỉ là một nhãn nhóm gắn
 * vào id project có sẵn - đúng hình dạng dữ liệu như Style Design
 * (assets/styles/styles.json), không cần join phức tạp. Xem docs/API.md mục
 * "Workspaces".
 *
 * Vì sao member cần cả `kind` lẫn `id`: video-projects/<id> và
 * image-projects/<id> là HAI không gian tên RIÊNG - một project video và một
 * project ảnh có thể trùng id (xem childProject.ts uniqueProjectId vs
 * imageMeta.ts newImageProjectId, không bên nào kiểm tra bên kia). Thiếu
 * `kind` thì "thêm ảnh trùng id với video đã có trong workspace" sẽ bị coi là
 * trùng lặp trong khi thực ra là hai project khác nhau.
 */

export type ProjectKind = "video" | "image";

export interface WorkspaceMember {
  kind: ProjectKind;
  id: string;
  /** Lúc thêm vào workspace - khác createdAt của project, dùng để sắp xếp trong workspace */
  addedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Hex màu chip nhận diện workspace trong danh sách - không liên quan Style Design */
  color: string;
  description: string;
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspacesFile {
  workspaces: Workspace[];
}

/** Bảng màu cố định cho chip workspace - đủ phân biệt, không cần color picker tự do */
export const WORKSPACE_COLORS = [
  "#ed3c47",
  "#ff7849",
  "#f59e0b",
  "#16a34a",
  "#37bdf8",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#64748b",
] as const;

const workspacesFilePath = () => path.join(paths.workspacesDir, "workspaces.json");

/** Màu tiếp theo trong bảng, xoay vòng theo số workspace đã có - workspace mới không trùng màu workspace liền trước */
export function nextWorkspaceColor(existingCount: number): string {
  return WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length];
}

function normMember(raw: unknown): WorkspaceMember | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.kind !== "video" && m.kind !== "image") return null;
  if (typeof m.id !== "string" || !isKebabCase(m.id)) return null;
  return {
    kind: m.kind,
    id: m.id,
    addedAt: typeof m.addedAt === "string" && m.addedAt ? m.addedAt : nowIso(),
  };
}

/** Chuẩn hóa một workspace đọc từ đĩa - thiếu id/name hợp lệ → null (bỏ khỏi danh sách) */
function normWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id.trim()) return null;
  const now = nowIso();
  const members: WorkspaceMember[] = [];
  const seen = new Set<string>();
  if (Array.isArray(w.members)) {
    for (const item of w.members) {
      const m = normMember(item);
      if (!m) continue;
      const key = `${m.kind}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(m);
    }
  }
  return {
    id: w.id.trim(),
    name: typeof w.name === "string" && w.name.trim() ? w.name.trim() : w.id.trim(),
    color:
      typeof w.color === "string" && HEX_RE.test(w.color) ? normHexColor(w.color) : WORKSPACE_COLORS[0],
    description: typeof w.description === "string" ? w.description : "",
    members,
    createdAt: typeof w.createdAt === "string" && w.createdAt ? w.createdAt : now,
    updatedAt: typeof w.updatedAt === "string" && w.updatedAt ? w.updatedAt : now,
  };
}

/** Đọc workspaces.json - file thiếu/hỏng đọc phòng thủ, không ném lỗi */
export function readWorkspaces(): WorkspacesFile {
  const file = workspacesFilePath();
  if (!fs.existsSync(file)) return { workspaces: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { workspaces: [] };
    const r = raw as Record<string, unknown>;
    const workspaces: Workspace[] = [];
    const seen = new Set<string>();
    if (Array.isArray(r.workspaces)) {
      for (const item of r.workspaces) {
        const w = normWorkspace(item);
        if (w && !seen.has(w.id)) {
          seen.add(w.id);
          workspaces.push(w);
        }
      }
    }
    return { workspaces };
  } catch {
    return { workspaces: [] };
  }
}

export function writeWorkspaces(data: WorkspacesFile): void {
  ensureDir(paths.workspacesDir);
  fs.writeFileSync(workspacesFilePath(), JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function workspaceExists(id: string): boolean {
  return readWorkspaces().workspaces.some((w) => w.id === id);
}

/** Sinh id từ tên (bỏ dấu tiếng Việt, kebab-case), trùng thì thêm -2, -3… */
export function uniqueWorkspaceId(name: string, data: WorkspacesFile = readWorkspaces()): string {
  const base = toKebabAscii(name) || "workspace";
  let id = base;
  for (let n = 2; data.workspaces.some((w) => w.id === id); n++) id = `${base}-${n}`;
  return id;
}
