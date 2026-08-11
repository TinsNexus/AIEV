"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { authSetup, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/lib/useAuth";

export default function SetupPage() {
  const { t } = useT();
  const router = useRouter();
  const { needsSetup, loading, refresh } = useAuth();

  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Đã có tài khoản thì trang này vô nghĩa (backend cũng trả 409) - về đăng nhập
  useEffect(() => {
    if (!loading && !needsSetup) router.replace("/login");
  }, [loading, needsSetup, router]);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authSetup({ code, username, password, displayName: displayName || undefined });
      await refresh();
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t("auth.setup-title")} sub={t("auth.setup-sub")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error && <Banner tone="danger" message={error} />}
        <Field
          label={t("auth.setup-code")}
          htmlFor="setup-code"
          hint={t("auth.setup-code-hint")}
        >
          <input
            id="setup-code"
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            autoFocus
            required
          />
        </Field>
        <Field
          label={t("auth.username")}
          htmlFor="setup-username"
          hint={t("auth.setup-username-hint")}
        >
          <input
            id="setup-username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field
          label={t("auth.display-name")}
          htmlFor="setup-display-name"
          hint={t("auth.display-name-hint")}
        >
          <input
            id="setup-display-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
          />
        </Field>
        <Field
          label={t("auth.password")}
          htmlFor="setup-password"
          hint={t("auth.setup-password-hint")}
        >
          <input
            id="setup-password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? t("auth.setup-creating") : t("auth.setup-submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
