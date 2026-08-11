"use client";

/**
 * Danh sách Workspace - nhóm project video/ảnh để dễ chuyển đổi qua lại.
 * Cùng lưới thẻ với Style Design / Prompts / Skills / Phong cách dựng (bốn
 * trang lưới thẻ của dashboard xuống hàng ở đúng ngưỡng giống nhau).
 *
 * Workspace KHÔNG di chuyển hay đụng file của project - chỉ là một nhãn nhóm
 * (xem apps/server/src/workspaces.ts). Xóa workspace không xóa project thành
 * viên, nên dùng confirm gõ DELETE như style/project cho nhất quán, dù hậu quả
 * nhẹ hơn nhiều.
 */

import { FolderKanban, Plus, SearchX, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaces,
  WORKSPACE_COLORS,
  type WorkspaceSummary,
} from "@/lib/api";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { CardGridSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

// Cùng lưới với Style Design/Prompts/Skills/Phong cách dựng
const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

export default function WorkspacesPage() {
  const { t, tf } = useT();
  const router = useRouter();
  const [list, setList] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Chọn nhiều workspace để xóa
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);

  // Modal "Tạo workspace"
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await getWorkspaces());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setName("");
    setDescription("");
    setColor(WORKSPACE_COLORS[(list?.length ?? 0) % WORKSPACE_COLORS.length]);
    setCreateError(null);
    setCreateOpen(true);
  }

  async function onCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createWorkspace({ name: name.trim(), color, description: description.trim() });
      setCreateOpen(false);
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onDeleteSelected() {
    if (bulkDeleting || selected.size === 0 || !list) return;
    const targets = list.filter((w) => selected.has(w.id));
    setBulkDeleting(true);
    setBulkErrors([]);
    const errors: string[] = [];
    for (const w of targets) {
      try {
        await deleteWorkspace(w.id);
      } catch (e) {
        errors.push(`${w.name} (${w.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    setSelected(new Set());
    setBulkErrors(errors);
    await load();
  }

  const q = search.trim().toLowerCase();
  const filtered = (list ?? []).filter((w) =>
    q ? `${w.name} ${w.id} ${w.description}`.toLowerCase().includes(q) : true,
  );

  // Đổi từ khóa tìm kiếm thì bỏ tick những mục không còn hiện - không thì "Xóa
  // đã chọn" xóa cả mục người dùng không nhìn thấy nữa (xem lý do ở StylesPage).
  useEffect(() => {
    const visible = new Set(filtered.map((w) => w.id));
    setSelected((cur) => {
      const next = new Set([...cur].filter((id) => visible.has(id)));
      return next.size === cur.size ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, list]);

  const createButton = (
    <Button onClick={openCreate}>
      <Plus size={16} strokeWidth={2} />
      {t("workspaces.create")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.workspaces")}
        hint={{ titleKey: "help.workspaces.title", bodyKey: "help.workspaces.body" }}
        subtitle={t("workspaces.subtitle")}
        actions={createButton}
      />

      {error && <ErrorBanner message={t("workspaces.load-error")} detail={error} />}
      {bulkErrors.length > 0 && (
        <ErrorBanner
          message={tf("workspaces.delete-errors", { n: bulkErrors.length })}
          detail={bulkErrors.join("\n")}
        />
      )}

      <Card title={tf("workspaces.count", { n: list?.length ?? 0 })}>
        <Toolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("workspaces.search"),
          }}
          selectedCount={selected.size}
          onClearSelection={() => setSelected(new Set())}
          bulkActions={
            <Button
              variant="destructive"
              small
              disabled={bulkDeleting}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 size={14} strokeWidth={2} />
              {bulkDeleting ? t("common.deleting") : t("common.delete-selected")}
            </Button>
          }
        />

        {list === null ? (
          !error && (
            <div className={GRID}>
              <CardGridSkeleton count={8} />
            </div>
          )
        ) : filtered.length > 0 ? (
          <div className={GRID}>
            {filtered.map((w) => (
              // Vỏ ngoài chỉ để bắt click/Enter - nhờ đi qua onClick của vỏ mà
              // stopPropagation của ô tick vẫn chặn được điều hướng (khác hẳn
              // khi bọc bằng <Link>, xem cùng lý do ở StylesPage).
              <div
                key={w.id}
                role="link"
                tabIndex={0}
                onClick={() => router.push(`/workspaces/${w.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(`/workspaces/${w.id}`);
                }}
                className="cursor-pointer"
              >
                <Panel className="h-full transition-colors duration-150 hover:border-[var(--primary)]">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="checkbox block"
                        aria-label={tf("common.select-aria", { name: w.name })}
                        checked={selected.has(w.id)}
                        disabled={bulkDeleting}
                        onChange={() => toggleSelect(w.id)}
                      />
                    </span>
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: w.color }}
                      aria-hidden="true"
                    />
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">{w.name}</p>
                  </div>

                  {w.description && (
                    <p className="line-clamp-2 text-meta text-[var(--text-muted)]">
                      {w.description}
                    </p>
                  )}

                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="text-meta text-[var(--text-muted)]">
                      {tf("workspaces.member-count", {
                        video: w.memberCount.video,
                        image: w.memberCount.image,
                      })}
                    </span>
                    <span className="text-meta text-[var(--text-muted)]">
                      {formatRelative(w.updatedAt)}
                    </span>
                  </div>
                </Panel>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            description={t("workspaces.empty")}
            action={createButton}
          />
        ) : (
          <EmptyState icon={SearchX} description={t("common.no-match")} />
        )}
      </Card>

      {/* Modal xác nhận xóa nhiều workspace - bắt gõ DELETE, nhất quán với
          project/style dù hậu quả nhẹ hơn (không đụng project thành viên) */}
      <ConfirmDeleteModal
        open={bulkDeleteOpen}
        title={t("workspaces.delete-selected-title")}
        description={<p>{tf("workspaces.delete-desc", { n: selected.size })}</p>}
        items={(list ?? []).filter((w) => selected.has(w.id)).map((w) => w.name)}
        busy={bulkDeleting}
        confirmLabel={tf("workspaces.delete-n", { n: selected.size })}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={onDeleteSelected}
      />

      {/* Modal tạo workspace mới */}
      <Modal
        title={t("workspaces.create-title")}
        open={createOpen}
        onClose={() => {
          if (!creating) setCreateOpen(false);
        }}
        footer={
          <>
            <Button variant="secondary" disabled={creating} onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={onCreate} disabled={!name.trim() || creating}>
              <Plus size={15} strokeWidth={2} />
              {creating ? t("common.creating") : t("workspaces.create")}
            </Button>
          </>
        }
      >
        {createError && <ErrorBanner message={t("workspaces.create-error")} detail={createError} />}
        <Field label={t("common.name")} htmlFor="workspace-new-name">
          <input
            id="workspace-new-name"
            className="input"
            autoFocus
            value={name}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("workspaces.name-placeholder")}
          />
        </Field>
        <Field label={t("workspaces.color-label")}>
          <span className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("workspaces.color-label")}>
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                disabled={creating}
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-full transition-shadow duration-150 ${
                  color === c ? "shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--text)]" : ""
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </span>
        </Field>
        <Field
          label={t("workspaces.description-label")}
          htmlFor="workspace-new-description"
        >
          <textarea
            id="workspace-new-description"
            className="input"
            rows={2}
            value={description}
            disabled={creating}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("workspaces.description-placeholder")}
          />
        </Field>
      </Modal>
    </div>
  );
}
