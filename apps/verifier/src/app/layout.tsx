import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { VERIFIER_URL } from "@/lib/api";
import { HEADER } from "@/lib/copy";
import "./globals.css";

export const metadata: Metadata = {
  title: `${HEADER.product} — ${HEADER.title}`,
  description: "검증기관 화면: 요청 QR 생성 · 제출 검증 결과 · 공격 시연. 발급기관에 직접 조회하지 않고 공동원장만 확인한다.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        <footer className="border-t border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm text-muted">
            <span>
              {HEADER.product} · {HEADER.title} (시연용)
            </span>
            <span className="mono">검증 서비스: {VERIFIER_URL}</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
