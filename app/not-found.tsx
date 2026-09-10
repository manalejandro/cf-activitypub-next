"use client";

import Link from "next/link";
import Image from "next/image";
import { useLocale } from "@/lib/i18n";
import { useInstanceTitle } from "@/lib/instance-context";
import { LanguagePicker } from "@/components/LanguagePicker";

/**
 * Global 404 page. Matches the landing style and always renders in day mode
 * (.force-light), with a way back to the landing.
 */
export default function NotFound() {
  const { t } = useLocale();
  const brand = useInstanceTitle();

  return (
    <main
      className="force-light flex flex-col flex-1"
      style={{ background: "var(--bg)", minHeight: "100dvh" }}
    >
      {/* Nav */}
      <nav style={{ position: "relative", zIndex: 20, borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <Image src="/logo.svg" alt={brand} width={36} height={36} />
              <span className="hidden sm:inline font-bold text-lg" style={{ color: "var(--text-primary)" }}>
                {brand}
              </span>
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LanguagePicker />
          </div>
        </div>
      </nav>

      {/* 404 */}
      <section className="flex flex-col items-center justify-center text-center flex-1 px-6 py-20 relative overflow-hidden">
        {/* soft glow, like the landing hero */}
        <div
          style={{
            position: "absolute", inset: 0,
            background: "radial-gradient(ellipse 60% 50% at 50% 25%, rgba(99,102,241,0.14) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        <div className="animate-fade-in relative z-10 flex flex-col items-center gap-5 max-w-md">
          <span style={{ fontSize: "clamp(4.5rem, 12vw, 7rem)", lineHeight: 1, fontWeight: 900, margin: 0 }} className="gradient-text">
            404
          </span>
          <h1 style={{ fontSize: "1.6rem", margin: 0, color: "var(--text-primary)" }}>
            {t.not_found_title}
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", margin: 0 }}>
            {t.not_found_sub}
          </p>

          <div className="flex flex-wrap gap-3 justify-center mt-2">
            <Link href="/" className="btn btn-primary btn-lg">
              {t.not_found_back}
            </Link>
            <a
              href="/docs"
              className="btn btn-outline btn-lg"
              style={{ color: "var(--text-secondary)" }}
            >
              API Docs
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}