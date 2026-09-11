"use client";

import Image from "next/image";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { useInstanceTitle } from "@/lib/instance-context";

/**
 * Mastodon-style external-link interstitial. The target arrives as a prop from
 * the server page: `useSearchParams` reads the browser URL on the client, which
 * for a middleware rewrite (`/@user@domain` → `/redirect?url=…`) does not carry
 * the rewritten query — reading it there made every target look invalid.
 */
export function RedirectView({ target }: { target: string }) {
  const { t } = useLocale();
  const brand = useInstanceTitle();
  const valid = /^https:\/\//i.test(target);

  return (
    <PageLayout>
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
          padding: "3rem 1.5rem",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: "1rem",
        }}
      >
        <Image src="/logo.svg" alt={brand} width={52} height={52} />
        <h1 style={{ fontSize: "1.15rem", fontWeight: 700, margin: 0 }}>
          {t.redirect_title.replace("{instance}", brand)}
        </h1>
        {valid ? (
          <>
            <p style={{ color: "var(--text-secondary)", margin: 0 }}>{t.redirect_hint}</p>
            <a
              href={target}
              rel="noopener noreferrer"
              style={{
                wordBreak: "break-all",
                fontWeight: 600,
                color: "var(--accent)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "0.75rem 1rem",
                width: "100%",
              }}
            >
              {target}
            </a>
          </>
        ) : (
          <p style={{ color: "var(--text-muted)" }}>{t.redirect_invalid}</p>
        )}
      </div>
    </PageLayout>
  );
}
