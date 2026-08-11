import { Router } from "express";
import { HEX_RE, normHexColor } from "../styles.js";
import { HttpError, isKebabCase, nowIso } from "../util.js";
import { scanImageProjects } from "../imageMeta.js";
import { scanProjects } from "../meta.js";
import {
  nextWorkspaceColor,
  readWorkspaces,
  uniqueWorkspaceId,
  writeWorkspaces,
  type ProjectKind,
  type Workspace,
  type WorkspacesFile,
} from "../workspaces.js";

/**
 * Workspace - nhóm project video/ảnh để dễ chuyển đổi qua lại. CRUD workspace
 * + thêm/bớt thành viên (project có sẵn, KHÔNG scaffold file mới). Xem
 * docs/API.md mục "Workspaces" và workspaces.ts cho lý do chọn JSON + lý do
 * member cần cả kind lẫn id.
 */

function findWorkspace(data: WorkspacesFile, id: string): Workspace {
  const w = data.workspaces.find((w) => w.id === id);
  if (!w) throw new HttpError(404, "WORKSPACE_NOT_FOUND", `Không tìm thấy workspace "${id}"`);
  return w;
}

// Summary cho danh sách - KHÔNG kèm member đã enrich (nặng, danh sách chỉ cần đếm)
function summaryOf(w: Workspace) {
  const video = w.members.filter((m) => m.kind === "video").length;
  const image = w.members.filter((m) => m.kind === "image").length;
  return {
    id: w.id,
    name: w.name,
    color: w.color,
    description: w.description,
    memberCount: { video, image, total: w.members.length },
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

const router = Router();

// GET /api/workspaces
router.get("/", (_req, res) => {
  res.json(readWorkspaces().workspaces.map(summaryOf));
});

// POST /api/workspaces - { name, color?, description? } → 201 summary
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new HttpError(400, "INVALID_NAME", "Thiếu name");
  if ("color" in body && (typeof body.color !== "string" || !HEX_RE.test(body.color))) {
    throw new HttpError(400, "INVALID_COLOR", `color phải là mã màu hex (vd "#ed3c47")`);
  }
  if ("description" in body && typeof body.description !== "string") {
    throw new HttpError(400, "INVALID_DESCRIPTION", "description phải là string");
  }

  const data = readWorkspaces();
  const id = uniqueWorkspaceId(name, data);
  const now = nowIso();
  const workspace: Workspace = {
    id,
    name,
    color:
      typeof body.color === "string" && HEX_RE.test(body.color)
        ? normHexColor(body.color)
        : nextWorkspaceColor(data.workspaces.length),
    description: typeof body.description === "string" ? body.description.trim() : "",
    members: [],
    createdAt: now,
    updatedAt: now,
  };
  data.workspaces.push(workspace);
  writeWorkspaces(data);
  res.status(201).json(summaryOf(workspace));
});

// GET /api/workspaces/:id - chi tiết + members đã enrich (tên/status/tags từ project thật)
router.get("/:id", (req, res) => {
  const data = readWorkspaces();
  const workspace = findWorkspace(data, req.params.id);

  const videoMap = new Map(scanProjects().map((p) => [p.id, p]));
  const imageMap = new Map(scanImageProjects().map((p) => [p.id, p]));

  const members = workspace.members.map((m) => {
    if (m.kind === "video") {
      const p = videoMap.get(m.id);
      return {
        kind: m.kind,
        id: m.id,
        addedAt: m.addedAt,
        missing: !p,
        name: p?.name ?? m.id,
        status: p?.status ?? null,
        tags: p?.tags ?? [],
        updatedAt: p?.updatedAt ?? null,
      };
    }
    const p = imageMap.get(m.id);
    return {
      kind: m.kind,
      id: m.id,
      addedAt: m.addedAt,
      missing: !p,
      name: p?.name ?? m.id,
      status: p?.status ?? null,
      tags: [] as string[],
      updatedAt: p?.updatedAt ?? null,
    };
  });

  res.json({ ...summaryOf(workspace), members });
});

// PUT /api/workspaces/:id - partial (name/color/description) → summary
router.put("/:id", (req, res) => {
  const data = readWorkspaces();
  const workspace = findWorkspace(data, req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new HttpError(400, "INVALID_NAME", "name phải là string không rỗng");
    }
    workspace.name = body.name.trim();
  }
  if ("color" in body) {
    if (typeof body.color !== "string" || !HEX_RE.test(body.color)) {
      throw new HttpError(400, "INVALID_COLOR", `color phải là mã màu hex (vd "#ed3c47")`);
    }
    workspace.color = normHexColor(body.color);
  }
  if ("description" in body) {
    if (typeof body.description !== "string") {
      throw new HttpError(400, "INVALID_DESCRIPTION", "description phải là string");
    }
    workspace.description = body.description.trim();
  }

  workspace.updatedAt = nowIso();
  writeWorkspaces(data);
  res.json(summaryOf(workspace));
});

// DELETE /api/workspaces/:id - CHỈ xóa nhãn nhóm, không đụng project thành viên
router.delete("/:id", (req, res) => {
  const data = readWorkspaces();
  findWorkspace(data, req.params.id); // 404 nếu không có
  data.workspaces = data.workspaces.filter((w) => w.id !== req.params.id);
  writeWorkspaces(data);
  res.status(204).end();
});

// POST /api/workspaces/:id/members - { kind: "video"|"image", id } → 201 summary
router.post("/:id/members", (req, res) => {
  const data = readWorkspaces();
  const workspace = findWorkspace(data, req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = body.kind;
  const projectId = body.id;

  if (kind !== "video" && kind !== "image") {
    throw new HttpError(400, "INVALID_KIND", `kind phải là "video" hoặc "image"`);
  }
  if (typeof projectId !== "string" || !isKebabCase(projectId)) {
    throw new HttpError(400, "INVALID_PROJECT_ID", "id project không hợp lệ");
  }
  const exists =
    kind === "video"
      ? scanProjects().some((p) => p.id === projectId)
      : scanImageProjects().some((p) => p.id === projectId);
  if (!exists) {
    throw new HttpError(
      404,
      "PROJECT_NOT_FOUND",
      `Không tìm thấy project ${kind} "${projectId}"`,
    );
  }
  if (workspace.members.some((m) => m.kind === kind && m.id === projectId)) {
    throw new HttpError(409, "ALREADY_MEMBER", "Project đã có trong workspace này");
  }

  workspace.members.push({ kind: kind as ProjectKind, id: projectId, addedAt: nowIso() });
  workspace.updatedAt = nowIso();
  writeWorkspaces(data);
  res.status(201).json(summaryOf(workspace));
});

// DELETE /api/workspaces/:id/members/:kind/:projectId
router.delete("/:id/members/:kind/:projectId", (req, res) => {
  const data = readWorkspaces();
  const workspace = findWorkspace(data, req.params.id);
  const { kind, projectId } = req.params;
  if (kind !== "video" && kind !== "image") {
    throw new HttpError(400, "INVALID_KIND", `kind phải là "video" hoặc "image"`);
  }
  const before = workspace.members.length;
  workspace.members = workspace.members.filter((m) => !(m.kind === kind && m.id === projectId));
  if (workspace.members.length === before) {
    throw new HttpError(404, "MEMBER_NOT_FOUND", "Project không nằm trong workspace này");
  }
  workspace.updatedAt = nowIso();
  writeWorkspaces(data);
  res.status(204).end();
});

export default router;
