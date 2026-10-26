"use client";

/**
 * Chi tiết một Workspace - đổi tên/màu/mô tả, quản lý thành viên (project
 * video/ảnh có sẵn). KHÔNG dùng bộ khối Workspace 3 cột (source/setup/output)
 * dùng chung cho trang dựng video: trang này không có pipeline sản xuất nào,
 * chỉ là cài đặt + danh sách, nên xếp Card đơn giản theo chiều dọc là đủ - và
 * tránh nhầm lẫn tên với chính khái niệm "workspace" đang quản lý ở đây.
 */

import {
  ArrowLeft,
  Clapperboard,
  Images as ImagesIcon,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addWorkspaceMember,
  ApiError,
  deleteWorkspace,
  getImageProjects,
  getProjects,
  getWorkspace,
  removeWorkspaceMember,
  updateWorkspace,
  WORKSPACE_COLORS,
  type ImageProject,
  type ProjectKind,
  type ProjectSummary,
  type WorkspaceDetail,
  type WorkspaceMemberView,
} from "@/lib/api";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Suy tone của Badge từ status thô (trộn ProjectStatus + ImageProjectStatus) */
function statusTone(status: string | null): BadgeTone {
  if (status === "done") return "success";
  if (status === "rendering" || status === "generating") return "running";
  if (status === "error") return "danger";
  return "muted";
}

export default function WorkspaceDetailPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const router = useRouter();
  const { t, tf } = useT();

  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Cài đặt (name/color/description) - chỉnh cục bộ, lưu bằng nút Lưu
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Gỡ thành viên - theo dõi id đang xử lý để khóa đúng một nút, không khóa cả danh sách
  const [removing, setRemoving] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  // Modal "Thêm project"
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [videoProjects, setVideoProjects] = useState<ProjectSummary[] | null>(null);
  const [imageProjects, setImageProjects] = useState<ImageProject[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await getWorkspace(workspaceId);
      setWorkspace(w);
      setName(w.name);
      setColor(w.color);
      setDescription(w.description);
      setLoadError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
        return;
      }
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    !!workspace &&
    (name !== workspace.name || color !== workspace.color || description !== workspace.description);

  async function onSave() {
    if (!workspace || saving || !name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const s = await updateWorkspace(workspaceId, {
        name: name.trim(),
        color,
        description: description.trim(),
      });
      setWorkspace((w) => (w ? { ...w, ...s } : w));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteWorkspace(workspaceId);
      router.push("/workspaces");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  async function onRemoveMember(m: WorkspaceMemberView) {
    if (removing) return;
    if (!window.confirm(tf("workspaceDetail.remove-confirm", { name: m.name }))) return;
    setRemoving(`${m.kind}:${m.id}`);
    setMemberError(null);
    try {
      await removeWorkspaceMember(workspaceId, m.kind, m.id);
      await load();
    } catch (e) {
      setMemberError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  }

  async function openAdd() {
    setAddSearch("");
    setAddError("");
    setAddOpen(true);
    if (videoProjects === null) {
      try {
        setVideoProjects(await getProjects());
      } catch {
        setVideoProjects([]);
      }
    }
    if (imageProjects === null) {
      try {
        setImageProjects(await getImageProjects());
      } catch {
        setImageProjects([]);
      }
    }
  }

  async function onAdd(kind: ProjectKind, id: string) {
    if (adding) return;
    setAdding(`${kind}:${id}`);
    setAddError(null);
    try {
      await addWorkspaceMember(workspaceId, kind, id);
      await load();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  }

  const memberKeys = useMemo(
    () => new Set((workspace?.members ?? []).map((m) => `${m.kind}:${m.id}`)),
    [workspace],
  );

  const q = addSearch.trim().toLowerCase();
  const availableVideo = (videoProjects ?? []).filter(
    (p) => !memberKeys.has(`video:${p.id}`) && (!q || `${p.name} ${p.id}`.toLowerCase().includes(q)),
  );
  const availableImage = (imageProjects ?? []).filter(
    (p) => !memberKeys.has(`image:${p.id}`) && (!q || `${p.name} ${p.id}`.toLowerCase().includes(q)),
  );
  const addListLoading = videoProjects === null || imageProjects === null;

  const busy = saving || deleting;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={workspace?.name ?? workspaceId}
        hint={{ titleKey: "help.workspaces.title", bodyKey: "help.workspaces.body" }}
        subtitle={
          workspace
            ? tf("workspaceDetail.updated", { time: formatRelative(workspace.updatedAt) })
            : undefined
        }
        actions={
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => router.push("/workspaces")}>
                <ArrowLeft size={15} strokeWidth={2} />
                {t("nav.workspaces")}
              </Button>
              <Button onClick={onSave} disabled={!workspace || !dirty || busy || !name.trim()}>
                <Save size={15} strokeWidth={2} />
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </span>
            <span className="flex items-center border-l border-[var(--border)] pl-2">
              <Button
                variant="destructive"
                disabled={!workspace || busy}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 size={15} strokeWidth={2} />
                {deleting ? t("common.deleting") : t("workspaceDetail.delete")}
              </Button>
            </span>
          </>
        }
      />

      {loadError && <ErrorBanner message={t("workspaceDetail.load-error")} detail={loadError} />}
      {notFound && (
        <ErrorBanner
          message={tf("workspaceDetail.not-found", { id: workspaceId })}
          detail={t("workspaceDetail.not-found-detail")}
        />
      )}
      {saveError && <ErrorBanner message={t("common.save-error")} detail={saveError} />}
      {deleteError && (
        <ErrorBanner message={t("workspaceDetail.delete-error")} detail={deleteError} />
      )}
      {memberError && <ErrorBanner message={memberError} />}
      {saved && <Banner tone="success" message={t("common.saved")} />}

      {!workspace && !loadError && !notFound && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {workspace && (
        <>
          <Card title={t("workspaceDetail.settings-title")}>
            <div className="flex flex-col gap-4">
              <Field label={t("common.name")} htmlFor="workspace-name">
                <input
                  id="workspace-name"
                  className="input"
                  value={name}
                  disabled={busy}
                  onChange={(e) => {
                    setSaved(false);
                    setName(e.target.value);
                  }}
                  placeholder={t("workspaces.name-placeholder")}
                />
              </Field>

              <Field label={t("workspaces.color-label")}>
                <span
                  className="flex flex-wrap gap-2"
                  role="radiogroup"
                  aria-label={t("workspaces.color-label")}
                >
                  {WORKSPACE_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={color === c}
                      aria-label={c}
                      disabled={busy}
                      onClick={() => {
                        setSaved(false);
                        setColor(c);
                      }}
                      className={`h-7 w-7 rounded-full transition-shadow duration-150 ${
                        color === c
                          ? "shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--text)]"
                          : ""
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </span>
              </Field>

              <Field label={t("workspaces.description-label")} htmlFor="workspace-description">
                <textarea
                  id="workspace-description"
                  className="input"
                  rows={2}
                  value={description}
                  disabled={busy}
                  onChange={(e) => {
                    setSaved(false);
                    setDescription(e.target.value);
                  }}
                  placeholder={t("workspaces.description-placeholder")}
                />
              </Field>
            </div>
          </Card>

          <Card
            title={tf("workspaceDetail.members-count", { n: workspace.members.length })}
            actions={
              <Button small onClick={openAdd}>
                <Plus size={14} strokeWidth={2} />
                {t("workspaceDetail.add-project")}
              </Button>
            }
          >
            {workspace.members.length === 0 ? (
              <EmptyState
                icon={Clapperboard}
                description={t("workspaceDetail.members-empty")}
                action={
                  <Button small onClick={openAdd}>
                    <Plus size={14} strokeWidth={2} />
                    {t("workspaceDetail.add-project")}
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-2">
                {workspace.members.map((m) => {
                  const key = `${m.kind}:${m.id}`;
                  const href = m.kind === "video" ? `/projects/${m.id}` : `/images/${m.id}`;
                  const Icon = m.kind === "video" ? Clapperboard : ImagesIcon;
                  return (
                    <Panel
                      key={key}
                      title={
                        <span className="flex min-w-0 items-center gap-2">
                          <Icon
                            size={15}
                            strokeWidth={1.75}
                            className="shrink-0 text-[var(--text-muted)]"
                            aria-hidden="true"
                          />
                          {m.missing ? (
                            <span className="min-w-0 truncate text-sm font-medium text-[var(--text-muted)] line-through">
                              {m.name}
                            </span>
                          ) : (
                            <Link
                              href={href}
                              className="min-w-0 truncate text-sm font-medium hover:text-[var(--primary)] hover:underline"
                            >
                              {m.name}
                            </Link>
                          )}
                          {m.missing ? (
                            <Badge tone="muted" label={t("workspaceDetail.missing-badge")} />
                          ) : (
                            m.status && <Badge tone={statusTone(m.status)} label={m.status} />
                          )}
                        </span>
                      }
                      actions={
                        <IconButton
                          label={tf("workspaceDetail.remove-aria", { name: m.name })}
                          size="sm"
                          tone="danger"
                          disabled={removing === key}
                          onClick={() => onRemoveMember(m)}
                        >
                          <X size={14} strokeWidth={2} />
                        </IconButton>
                      }
                    >
                      {null}
                    </Panel>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Modal xác nhận xóa workspace - bắt gõ DELETE, KHÔNG đụng project thành viên */}
      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("workspaceDetail.delete-title")}
        description={<p>{t("workspaceDetail.delete-desc")}</p>}
        busy={deleting}
        confirmLabel={t("workspaceDetail.delete")}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />

      {/* Modal thêm project - tìm trong project video + ảnh CHƯA nằm trong workspace */}
      <Modal
        title={t("workspaceDetail.add-project-title")}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        footer={
          <Button variant="secondary" onClick={() => setAddOpen(false)}>
            {t("common.close")}
          </Button>
        }
      >
        {addError && <ErrorBanner message={addError} />}
        <div className="relative">
          <Search
            size={15}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <input
            type="search"
            className="input h-8 pl-8"
            value={addSearch}
            onChange={(e) => setAddSearch(e.target.value)}
            placeholder={t("workspaceDetail.add-search-placeholder")}
            aria-label={t("workspaceDetail.add-search-placeholder")}
            autoFocus
          />
        </div>

        {addListLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : availableVideo.length === 0 && availableImage.length === 0 ? (
          <p className="py-4 text-center text-sm text-[var(--text-muted)]">
            {q ? t("common.no-match") : t("workspaceDetail.add-empty")}
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
            {availableVideo.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-meta font-semibold text-[var(--text-muted)]">
                  {t("workspaceDetail.kind-video")}
                </p>
                {availableVideo.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={adding === `video:${p.id}`}
                    onClick={() => onAdd("video", p.id)}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Clapperboard
                        size={14}
                        strokeWidth={1.75}
                        className="shrink-0 text-[var(--text-muted)]"
                      />
                      <span className="min-w-0 truncate text-sm">{p.name}</span>
                    </span>
                    <Plus size={14} strokeWidth={2} className="shrink-0 text-[var(--text-muted)]" />
                  </button>
                ))}
              </div>
            )}
            {availableImage.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-meta font-semibold text-[var(--text-muted)]">
                  {t("workspaceDetail.kind-image")}
                </p>
                {availableImage.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={adding === `image:${p.id}`}
                    onClick={() => onAdd("image", p.id)}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ImagesIcon
                        size={14}
                        strokeWidth={1.75}
                        className="shrink-0 text-[var(--text-muted)]"
                      />
                      <span className="min-w-0 truncate text-sm">{p.name}</span>
                    </span>
                    <Plus size={14} strokeWidth={2} className="shrink-0 text-[var(--text-muted)]" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
