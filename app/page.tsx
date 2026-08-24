"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { LanguagePicker } from "@/components/LanguagePicker";
import { Icon, type IconName } from "@/components/Icon";
import { RichText } from "@/components/RichText";

interface InstanceSettings {
  rules?: { id: string; text: string; html: string }[];
  extended_description?: string;
  privacy_policy?: string;
  terms_of_service?: string;
}

export default function Home() {
  const { authenticated, loading } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const [version, setVersion] = useState<string | null>(null);
  const [settings, setSettings] = useState<InstanceSettings | null>(null);

  useEffect(() => {
    if (authenticated && !loading) router.replace("/home");
  }, [authenticated, loading, router]);

  useEffect(() => {
    fetch("/api/v1/instance")
      .then((res) => (res.ok ? res.json() as Promise<{ version?: string }> : null))
      .then((data) => {
        if (data?.version) {
          const m = data.version.match(/compatible;\s*([^)]+)/);
          setVersion(m ? m[1] : data.version);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/v1/instance/settings")
      .then((res) => (res.ok ? res.json() as Promise<InstanceSettings> : null))
      .then((data) => { if (data) setSettings(data); })
      .catch(() => {});
  }, []);

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
    { icon: "exclamation-triangle", title: t.f_disclaimer_title, desc: t.f_disclaimer_desc },
  ];

  return (
    <main className="force-light flex flex-col flex-1 -mt-14 md:mt-0" style={{ background: "var(--bg)" }}>
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
            <LanguagePicker />
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
      <section className="container-wide pt-24 pb-16">
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

      {/* Instance settings (only the ones that are configured) */}
      {(settings?.rules?.length || settings?.extended_description || settings?.privacy_policy || settings?.terms_of_service) ? (
        <section className="container-wide pb-40">
          <div className="grid gap-6 md:grid-cols-2">
            {settings.extended_description && (
              <div className="card p-6 flex flex-col gap-3">
                <div style={{ fontSize: "2rem" }}><Icon name="info-circle" size="2rem" /></div>
                <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t.landing_extended_description}</h3>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}><RichText html={settings.extended_description} /></div>
              </div>
            )}
            {settings.privacy_policy && (
              <div className="card p-6 flex flex-col gap-3">
                <div style={{ fontSize: "2rem" }}><Icon name="lock" size="2rem" /></div>
                <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t.landing_privacy_policy}</h3>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}><RichText html={settings.privacy_policy} /></div>
              </div>
            )}
            {settings.terms_of_service && (
              <div className="card p-6 flex flex-col gap-3">
                <div style={{ fontSize: "2rem" }}><Icon name="book" size="2rem" /></div>
                <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t.landing_terms_of_service}</h3>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}><RichText html={settings.terms_of_service} /></div>
              </div>
            )}
            {settings.rules && settings.rules.length > 0 && (
              <div className="card p-6 flex flex-col gap-3">
                <div style={{ fontSize: "2rem" }}><Icon name="list" size="2rem" /></div>
                <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t.landing_rules}</h3>
                <ol style={{ margin: 0, paddingLeft: "1.25rem", color: "var(--text-secondary)", fontSize: "0.9rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {settings.rules.map((r) => (
                    <li key={r.id}><RichText html={r.html} /></li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* Footer */}
      <footer style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-4 py-6">
          <span>© {new Date().getFullYear()} CF ActivityPub — {t.landing_footer}{version ? ` · v${version}` : ""}</span>
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
