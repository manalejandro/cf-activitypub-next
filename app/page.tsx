"use client";

import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/lib/client-api";

export default function Home() {
  const { authenticated, loading } = useAuth();

  if (loading) return null;
  if (authenticated) {
    if (typeof window !== "undefined") window.location.href = "/home";
    return null;
  }

  return (
    <main className="flex flex-col flex-1">
      {/* Nav */}
      <nav style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        <div className="container-wide flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <Image src="/logo.svg" alt="CF ActivityPub" width={36} height={36} />
            <span className="font-bold text-lg" style={{ color: "var(--text-primary)" }}>
              CF ActivityPub
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login" className="btn btn-outline btn-sm">Sign in</Link>
            <Link href="/register" className="btn btn-primary btn-sm">Join</Link>
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
          <span className="badge badge-accent mb-2">Open · Federated · Edge-native</span>
          <h1 style={{ fontSize: "clamp(2.5rem, 5vw, 4rem)", margin: 0 }}>
            The{" "}
            <span className="gradient-text">ActivityPub server</span>
            <br />
            for the modern web
          </h1>
          <p style={{ fontSize: "1.2rem", color: "var(--text-secondary)", maxWidth: 560, margin: 0 }}>
            Mastodon-compatible, globally distributed, and deployed at the edge — all on Cloudflare
            Workers with zero cold starts.
          </p>

          <div className="flex flex-wrap gap-4 justify-center mt-4">
            <Link href="/register" className="btn btn-primary btn-lg">
              Create an account
            </Link>
            <a
              href="https://github.com/manalejandro/cf-activitypub-next"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline btn-lg"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container-wide py-24">
        <h2 className="text-center mb-14" style={{ fontSize: "1.8rem" }}>
          Built for performance and openness
        </h2>
        <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          {features.map((f) => (
            <div key={f.title} className="card p-6 flex flex-col gap-3">
              <div style={{ fontSize: "2rem" }}>{f.icon}</div>
              <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{f.title}</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        <div className="container-wide flex flex-wrap items-center justify-between gap-4 py-6">
          <span>© {new Date().getFullYear()} CF ActivityPub — Open source & federated</span>
          <div className="flex gap-5">
            <a href="/.well-known/nodeinfo" style={{ color: "var(--text-muted)" }}>NodeInfo</a>
            <a href="https://github.com/manalejandro/cf-activitypub-next" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)" }}>GitHub</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

const features = [
  {
    icon: "⚡",
    title: "Edge-native performance",
    desc: "Runs on Cloudflare Workers in 300+ global locations with sub-millisecond cold starts.",
  },
  {
    icon: "🌐",
    title: "Mastodon compatible",
    desc: "Full Mastodon REST API support — works with Ivory, Elk, Tusky, and any Mastodon client.",
  },
  {
    icon: "🔗",
    title: "ActivityPub federation",
    desc: "Federation with any Mastodon, Pleroma, Misskey, or ActivityPub-compatible server.",
  },
  {
    icon: "🔒",
    title: "HTTP Signatures",
    desc: "All federated activities are cryptographically signed and verified using RFC 9421.",
  },
  {
    icon: "🗄️",
    title: "Cloudflare D1 + KV",
    desc: "Persistent data on Cloudflare D1 (SQLite), with KV for caching and R2 for media.",
  },
  {
    icon: "📦",
    title: "Zero dependencies",
    desc: "Pure TypeScript, Web Crypto API, no Node.js runtime required. Deploy with one command.",
  },
];

