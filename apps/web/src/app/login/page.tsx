"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { authLogin, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/lib/useAuth";

/**
 * useSearchParams() (đọc `?next=`) buộc trang phải render phía client, mà
 * `next build` thì vẫn prerender trang này ra HTML tĩnh - không có ranh giới
 * Suspense là build ĐỔ, không phải cảnh báo. Nên phần đọc query nằm trong
 * component con, còn export mặc định chỉ bọc Suspense quanh nó.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const { t } = useT();
  const router = useRouter();
  const params = useSearchParams();
  const { authenticated, needsSetup, loading, refresh } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Chưa có tài khoản nào thì màn hình đăng nhập là ngõ cụt - đẩy sang /setup.
  // Đã đăng nhập rồi mà quay lại đây thì về chỗ họ định tới.
  useEffect(() => {
    if (loading) return;
    if (needsSetup) router.replace("/setup");
    else if (authenticated) router.replace(params.get("next") || "/");
  }, [loading, needsSetup, authenticated, router, params]);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authLogin(username, password);
      await refresh();
      router.replace(params.get("next") || "/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t("auth.login-title")} sub={t("auth.login-sub")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error && <Banner tone="danger" message={error} />}
        <Field label={t("auth.username")} htmlFor="login-username">
          <input
            id="login-username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label={t("auth.password")} htmlFor="login-password">
          <input
            id="login-password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? t("auth.logging-in") : t("auth.login-submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
