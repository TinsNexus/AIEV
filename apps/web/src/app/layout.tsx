import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./globals.css";
import { FAVICON } from "@/lib/brand";
import { NAV_STORAGE_KEY, PANEL_STORAGE_KEY, Shell } from "@/components/Shell";
import { StaleChunkGuard } from "@/components/StaleChunkGuard";
import { LanguageProvider } from "@/lib/i18n";
import { AuthProvider } from "@/lib/useAuth";
import { EventsProvider } from "@/lib/useEvents";

export const metadata: Metadata = {
  title: "Tisorr Studio by: Tisorr",
  description: "Edit video tự động bằng AI",
  // Data URI biên dịch vào bundle chứ không trỏ tới /brand/favicon.png: chép đè
  // file trong public/ không đổi được favicon của ứng dụng nữa. Xem
  // scripts/build-brand.mjs.
  icons: { icon: FAVICON },
};

/** Chống FOUC: áp data-theme trước khi paint. Mặc định light. */
const THEME_SCRIPT = `try{if(localStorage.getItem("theme")==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}`;

/**
 * Chống nháy layout: áp data-nav/data-panel (rail gấp/mở, panel AI gấp/mở)
 * trước khi paint, cùng cơ chế với THEME_SCRIPT ở trên. Phải nằm ở đây (Server
 * Component) chứ không phải trong Shell.tsx ("use client") - script render từ
 * một client component không chạy khi client re-render/hydrate, chỉ ở đây nó
 * mới là markup HTML tĩnh mà trình duyệt chạy lúc phân tích trang.
 */
const SHELL_SCRIPT = `try{var d=document.documentElement,n=localStorage.getItem("${NAV_STORAGE_KEY}");if(n==="collapsed"||n==="expanded")d.setAttribute("data-nav",n);if(localStorage.getItem("${PANEL_STORAGE_KEY}")==="collapsed")d.setAttribute("data-panel","collapsed")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SHELL_SCRIPT }} />
        <StaleChunkGuard />
        <LanguageProvider>
          <AuthProvider>
            <EventsProvider>
              <Shell>{children}</Shell>
            </EventsProvider>
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
