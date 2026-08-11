"use client";

import type { ReactNode } from "react";
import { LOGO_DARK, LOGO_LIGHT } from "@/lib/brand";

/**
 * Khung cho hai trang đứng ngoài shell: /login và /setup.
 *
 * Hai trang đó không có rail, không có topbar (chưa đăng nhập thì cũng chưa có
 * gì để điều hướng tới), nên chúng cần một khung riêng - nhưng vẫn phải là
 * Card/Field/Button của hệ thống, không phải form tự vẽ. Ở đây chỉ lo phần
 * căn giữa + logo, còn ruột do trang truyền vào.
 */
export function AuthCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-subtle)] p-4">
      <div className="flex w-full max-w-[420px] flex-col gap-4">
        <div className="flex justify-center">
          {/* Logo đổi theo theme bằng CSS, giống hệt topbar của shell */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_LIGHT} alt="Tisorr" className="logo-light h-8 w-auto" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_DARK} alt="Tisorr" className="logo-dark h-8 w-auto" />
        </div>
        <div className="card flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-meta text-[var(--text-muted)]">{sub}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
