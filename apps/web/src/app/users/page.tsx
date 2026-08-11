"use client";

import { KeyRound, Plus, Trash2, Users as UsersIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createUserAccount,
  deleteUserAccount,
  listAuditLog,
  listUsers,
  resetUserPassword,
  updateUserAccount,
  type AuditEntry,
  type AuthUser,
  type UserRole,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { TableSkeleton } from "@/components/Skeleton";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/lib/useAuth";

const ROLES: UserRole[] = ["admin", "editor", "viewer"];

export default function UsersPage() {
  const { t, tf } = useT();
  const { user: me, refresh: refreshAuth } = useAuth();

  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("editor");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [resetFor, setResetFor] = useState<AuthUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const [deleteFor, setDeleteFor] = useState<AuthUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, a] = await Promise.all([listUsers(), listAuditLog(50)]);
      setUsers(u);
      setAudit(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Mọi thao tác đổi tài khoản đều đi qua đây: lỗi lên banner, xong thì tải lại */
  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCreate(): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      await createUserAccount({
        username,
        password,
        role,
        displayName: displayName || undefined,
      });
      setCreateOpen(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("editor");
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function onReset(): Promise<void> {
    if (!resetFor) return;
    setResetting(true);
    setResetError(null);
    try {
      await resetUserPassword(resetFor.id, newPassword);
      setResetFor(null);
      setNewPassword("");
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (!deleteFor) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteUserAccount(deleteFor.id);
      setDeleteFor(null);
      await load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("users.title")}
        subtitle={t("users.hint")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} strokeWidth={2} />
            {t("users.add")}
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}

      <Card>
        {!users ? (
          <TableSkeleton />
        ) : users.length === 0 ? (
          <EmptyState
            icon={UsersIcon}
            title={t("users.empty-title")}
            description={t("users.empty-desc")}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("users.col-user")}</th>
                <th>{t("users.col-role")}</th>
                <th>{t("users.col-status")}</th>
                <th>{t("users.col-last-login")}</th>
                <th>{t("users.col-actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex flex-col">
                      <span className="text-sm">{u.displayName}</span>
                      <span className="text-meta text-[var(--text-muted)]">{u.username}</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="input"
                      value={u.role}
                      aria-label={t("auth.role")}
                      onChange={(e) =>
                        void run(() =>
                          updateUserAccount(u.id, { role: e.target.value as UserRole })
                        ).then(() => {
                          // Tự hạ quyền chính mình thì nav/quyền của tab này phải
                          // đổi theo ngay, không đợi tải lại trang
                          if (me && me.id === u.id) void refreshAuth();
                        })
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {t(`auth.role.${r}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Badge
                      tone={u.status === "active" ? "success" : "muted"}
                      label={t(`users.status.${u.status}`)}
                    />
                  </td>
                  <td className="text-meta text-[var(--text-muted)]">
                    {u.lastLoginAt ? formatRelative(u.lastLoginAt) : t("users.never")}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        small
                        onClick={() =>
                          void run(() =>
                            updateUserAccount(u.id, {
                              status: u.status === "active" ? "disabled" : "active",
                            })
                          )
                        }
                      >
                        {u.status === "active" ? t("users.disable") : t("users.enable")}
                      </Button>
                      <IconButton
                        label={t("users.reset-password")}
                        size="sm"
                        onClick={() => {
                          setResetFor(u);
                          setNewPassword("");
                          setResetError(null);
                        }}
                      >
                        <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={t("common.delete")}
                        size="sm"
                        tone="danger"
                        onClick={() => {
                          setDeleteFor(u);
                          setDeleteError(null);
                        }}
                      >
                        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title={
          <span className="flex items-baseline gap-2">
            {t("users.audit-title")}
            <span className="text-meta font-normal text-[var(--text-muted)]">
              {t("users.audit-hint")}
            </span>
          </span>
        }
      >
        {!audit ? (
          <TableSkeleton />
        ) : audit.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{t("users.audit-empty")}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("users.audit-col-at")}</th>
                <th>{t("users.audit-col-who")}</th>
                <th>{t("users.audit-col-action")}</th>
                <th>{t("users.audit-col-target")}</th>
                <th>{t("users.audit-col-ip")}</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id}>
                  <td className="text-meta text-[var(--text-muted)]">{formatRelative(e.at)}</td>
                  <td className="text-sm">{e.username || "—"}</td>
                  <td className="text-sm">{e.action}</td>
                  <td className="text-meta text-[var(--text-muted)]">
                    {e.target}
                    {e.detail ? ` · ${e.detail}` : ""}
                  </td>
                  <td className="text-meta text-[var(--text-muted)]">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        title={t("users.create-title")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void onCreate()} disabled={creating}>
              {t("users.add")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {createError && <ErrorBanner message={createError} />}
          <Field
            label={t("auth.username")}
            htmlFor="new-username"
            hint={t("auth.setup-username-hint")}
          >
            <input
              id="new-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field
            label={t("auth.display-name")}
            htmlFor="new-display-name"
            hint={t("auth.display-name-hint")}
          >
            <input
              id="new-display-name"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field
            label={t("auth.password")}
            htmlFor="new-password"
            hint={t("auth.setup-password-hint")}
          >
            <input
              id="new-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={t("auth.role")} htmlFor="new-role" hint={t(`users.role-hint.${role}`)}>
            <select
              id="new-role"
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`auth.role.${r}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>

      <Modal
        title={t("users.reset-password")}
        open={resetFor !== null}
        onClose={() => setResetFor(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetFor(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void onReset()} disabled={resetting}>
              {t("users.reset-password")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {resetError && <ErrorBanner message={resetError} />}
          <Field
            label={t("users.new-password")}
            htmlFor="reset-password"
            hint={t("auth.setup-password-hint")}
          >
            <input
              id="reset-password"
              type="password"
              className="input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDeleteModal
        open={deleteFor !== null}
        description={tf("users.delete-confirm", { name: deleteFor?.displayName ?? "" })}
        busy={deleting}
        error={deleteError}
        onClose={() => setDeleteFor(null)}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
