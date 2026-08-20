"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon, type IconName } from "@/components/Icon";

export default function Home() {
  const { authenticated, loading } = useAuth();
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();

  useEffect(() => {
    if (authenticated && !loading) router.replace("/home");
  }, [authenticated, loading, router]);

  if (loading) return null;
  if (authenticated) return null;

  const features: { icon: IconName; title: string; desc: string }[] = [
    { icon: "bolt", title: t.f_edge_title, desc: t.f_edge_desc },
    { icon: "globe", title: t.f_mastodon_title, desc: t.f_mastodon_desc },
    { icon: "link", title: t.f_federation_title, desc: t.f_federation_desc },
    { icon: "lock", title: t.f_http_title, desc: t.f_http_desc },
    { icon: "refresh", title: t.f_streaming_title, desc: t.f_streaming_desc },
    { icon: "bell", title: t.f_push_title, desc: t.f_push_desc },
    { icon: "microchip", title: t.f_moderation_title, desc: t.f_moderation_desc },
    { icon: "paint-brush", title: t.f_alttext_title, desc: t.f_alttext_desc },
    { icon: "phone", title: t.f_webrtc_title, desc: t.f_webrtc_desc },
    { icon: "database", title: t.f_d1_title, desc: t.f_d1_desc },
    { icon: "shield", title: t.f_mls_title, desc: t.f_mls_desc },
  ];

  return (
    <main className="flex flex-col flex-1 -mt-14 md:mt-0">
      {/* Nav */}
      <nav style={{ position: "sticky", top: 0, zIndex: 40, borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
          <div className="flex items-center gap-3">
            <Image src="/logo.svg" alt="CF ActivityPub" width={36} height={36} />
            <span className="hidden sm:inline font-bold text-lg" style={{ color: "var(--text-primary)" }}>
              CF ActivityPub
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.15rem" }}>
              <button
                onClick={() => setLocale("en")}
                className="btn btn-ghost btn-sm"
                aria-pressed={locale === "en"}
                style={{
                  fontWeight: locale === "en" ? 700 : 400,
                  background: locale === "en" ? "var(--accent-bg)" : undefined,
                  color: locale === "en" ? "var(--accent)" : "var(--text-muted)",
                  padding: "0.15rem 0.5rem",
                }}
              >
                EN
              </button>
              <button
                onClick={() => setLocale("es")}
                className="btn btn-ghost btn-sm"
                aria-pressed={locale === "es"}
                style={{
                  fontWeight: locale === "es" ? 700 : 400,
                  background: locale === "es" ? "var(--accent-bg)" : undefined,
                  color: locale === "es" ? "var(--accent)" : "var(--text-muted)",
                  padding: "0.15rem 0.5rem",
                }}
              >
                ES
              </button>
            </div>
            <Link href="/login" className="btn btn-outline btn-sm">{t.landing_signin}</Link>
            <Link href="/register" className="btn btn-primary btn-sm">{t.landing_join}</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center text-center py-28 px-6 flex-1 relative overflow-hidden">
        {/* glow */}
        <div
          style={{
            position: "absolute", inset: 0, background:
              "radial-gradient(ellipse 70% 50% at 50% 20%, rgba(99,102,241,0.15) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        <div className="animate-fade-in relative z-10 flex flex-col items-center gap-6 max-w-3xl">
          <span className="badge badge-accent mb-2">{t.landing_badge}</span>
          <h1 style={{ fontSize: "clamp(2.5rem, 5vw, 4rem)", margin: 0 }}>
            {t.landing_hero_1}{" "}
            <span className="gradient-text">{t.landing_hero_2}</span>
            <br />
            {t.landing_hero_3}
          </h1>
          <p style={{ fontSize: "1.2rem", color: "var(--text-secondary)", maxWidth: 560, margin: 0 }}>
            {t.landing_hero_desc}
          </p>

          <div className="flex flex-wrap gap-4 justify-center mt-4">
            <Link href="/register" className="btn btn-primary btn-lg">
              {t.landing_register}
            </Link>
            <a
              href="https://github.com/manalejandro/cf-activitypub-next"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline btn-lg"
            >
              {t.landing_github}
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container-wide pt-24 pb-40">
        <h2 className="text-center mb-14" style={{ fontSize: "1.8rem" }}>
          {t.landing_features_title}
        </h2>
        <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          {features.map((f) => (
            <div key={f.title} className="card p-6 flex flex-col gap-3">
              <div style={{ fontSize: "2rem" }}><Icon name={f.icon} size="2rem" /></div>
              <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{f.title}</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-4 py-6">
          <span>© {new Date().getFullYear()} CF ActivityPub — {t.landing_footer}</span>
          <div className="flex gap-5">
            <a href="/docs" style={{ color: "var(--text-muted)" }}>API Docs</a>
            <a href="/.well-known/nodeinfo" style={{ color: "var(--text-muted)" }}>NodeInfo</a>
            <a href="https://github.com/manalejandro/cf-activitypub-next" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
