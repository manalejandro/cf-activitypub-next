"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // First register the account
      const regRes = await fetch("/api/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      });

      const regData = await regRes.json() as { error?: string; id?: string };
      if (!regRes.ok) {
        setError(regData.error ?? "Registration failed");
        return;
      }

      // Then sign in
      const tokenRes = await fetch("/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "password", username: email, password }),
      });

      const tokenData = await tokenRes.json() as { access_token?: string };
      if (tokenData.access_token) {
        localStorage.setItem("access_token", tokenData.access_token);
      }

      window.location.href = "/home";
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4" style={{ background: "var(--bg)" }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
          </Link>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Create account</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            Join the open social web
          </p>
        </div>

        <div className="card p-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {error && (
              <div
                style={{
                  background: "rgba(248,113,113,0.1)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  color: "var(--danger)",
                  borderRadius: "var(--radius)",
                  padding: "0.625rem 0.875rem",
                  fontSize: "0.875rem",
                }}
              >
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>Username</label>
              <input
                type="text"
                className="input"
                placeholder="yourname"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                pattern="[a-zA-Z0-9_]{1,30}"
                title="Letters, numbers and underscores, 1-30 characters"
                required
                autoComplete="username"
              />
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                Letters, numbers and underscores only
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>Email</label>
              <input
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>Password</label>
              <input
                type="password"
                className="input"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={loading}
              style={{ marginTop: "0.5rem" }}
            >
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>

        <p
          style={{
            textAlign: "center",
            fontSize: "0.875rem",
            color: "var(--text-muted)",
            marginTop: "1.5rem",
          }}
        >
          Already have an account?{" "}
          <Link href="/login" style={{ color: "var(--accent-light)" }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
