"use client";

import { LogOut, ShieldAlert, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authLogout } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/lib/useAuth";
import { Badge } from "@/components/Badge";
import { IconButton } from "@/components/IconButton";

/**
 * Người đang đăng nhập + nút đăng xuất, ở góc phải topbar.
 *
 * Hai trạng thái, và cái thứ hai mới là chỗ dễ sai: khi vào bằng quyền MÁY CHỦ
 * (mở dashboard ngay trên máy, hoặc link `?t=`) thì không có bản ghi user nào -
 * `user` là null còn `role` vẫn là admin. Hiện đúng sự thật đó thay vì bịa ra
 * một cái tên, và không hiện nút đăng xuất vì chẳng có phiên nào để thoát.
 */
export function UserMenu() {
  const { t } = useT();
  const router = useRouter();
  const { user, role, via, refresh } = useAuth();
  const [busy, setBusy] = useState(false);

  if (via === "machine") {
    return (
      <span title={t("auth.via-machine-hint")} className="flex items-center gap-2">
        <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="text-meta text-[var(--text-muted)]">{t("auth.via-machine")}</span>
      </span>
    );
  }

  if (!user || !role) return null;

  async function onLogout(): Promise<void> {
    setBusy(true);
    try {
      await authLogout();
    } finally {
      await refresh();
      router.replace("/login");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <User size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="text-meta min-w-0 max-w-[140px] truncate">{user.displayName}</span>
      {/* Vai trò là NHÃN PHÂN LOẠI, không phải trạng thái → dot={false} */}
      <Badge tone={role === "admin" ? "danger" : "muted"} dot={false} label={t(`auth.role.${role}`)} />
      <IconButton
        label={t("auth.logout")}
        size="sm"
        onClick={() => void onLogout()}
        disabled={busy}
      >
        <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
      </IconButton>
    </div>
  );
}
