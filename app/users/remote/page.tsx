"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, Suspense, Fragment } from "react";
import Image from "next/image";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useStartCallButton } from "@/components/CallOverlay";
import { StatusCard } from "@/components/StatusCard";
import { RichText } from "@/components/RichText";
import type { Status as SharedStatus } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MastodonField {
  name: string;
  value: string;
  verified_at: string | null;
}

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  note: string;
  avatar: string;
  header: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  locked: boolean;
  bot: boolean;
  url: string;
  created_at: string;
  fields?: MastodonField[];
  roles?: { id: string; name: string; color: string }[];
  supports_calls?: boolean;
}

interface PollOption { title: string; votes_count: number | null }
interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number;
  voted: boolean;
  own_votes: number[];
  options: PollOption[];
}

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
}

interface Status {
  id: string;
  content: string;
  created_at: string;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  language?: string | null;
  poll: Poll | null;
}

interface Relationship {
  id: string;
  following: boolean;
  requested: boolean;
  blocking: boolean;
  muting?: boolean;
  followed_by?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


function AvatarImg({ account, size = 42 }: { account: Account; size?: number }) {
  const [err, setErr] = useState(false);
  const fallback = (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase();
  if (!err && account.avatar) {
    return (
      <Image src={account.avatar} alt={account.display_name} width={size} height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={() => setErr(true)} />
    );
  }
  return (
    <div style={{
      width: size, height: size, flexShrink: 0, borderRadius: "50%",
      background: "var(--accent-bg)", display: "flex", alignItems: "center",
      justifyContent: "center", fontSize: size * 0.4, fontWeight: 700, color: "var(--accent)",
    }}>
      {fallback}
    </div>
  );
}


// ─── Main Component ───────────────────────────────────────────────────────────

function AccountRow({ account }: { account: Account }) {
  const href = account.url?.startsWith("http") ? `/users/remote?url=${encodeURIComponent(account.url)}` : "#";
  return (
    <a href={href} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}>
      <AvatarImg account={account} size={42} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.display_name || account.username}</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{account.acct}</div>
      </div>
    </a>
  );
}

function RemoteProfileInner() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const actorUrl = searchParams.get("url");
  const { t } = useLocale();

  const [account, setAccount] = useState<Account | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [followers, setFollowers] = useState<Account[]>([]);
  const [following, setFollowing] = useState<Account[]>([]);
  const [activeTab, setActiveTab] = useState<"posts" | "followers" | "following">("posts");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [me, setMe] = useState<Account | null>(null);
  const [editingStatus, setEditingStatus] = useState<SharedStatus | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  // Profile header actions menu (⋯ on mobile)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  const token = getToken();
  const { startCall: initiateCall } = useStartCallButton(token);

  async function load(url: string) {
    setLoading(true);
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    const [acctRes, meRes] = await Promise.all([
      fetch(`/api/v1/accounts/${encodeURIComponent(url)}`),
      token ? fetch("/api/v1/accounts/verify_credentials", { headers }) : Promise.resolve(null),
    ]);

    if (!acctRes.ok) { setNotFound(true); setLoading(false); return; }
    const acct = await acctRes.json() as Account;
    setAccount(acct);

    if (meRes?.ok) {
      const meData = await meRes.json() as Account;
      setMe(meData);

      const relRes = await fetch(`/api/v1/accounts/relationships?id[]=${encodeURIComponent(acct.id)}`, { headers });
      if (relRes.ok) {
        const [rel] = await relRes.json() as Relationship[];
        setRelationship(rel ?? null);
      }
    }

    // Load cached statuses, followers and following in parallel
    const [statusRes, followersRes, followingRes] = await Promise.all([
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?limit=20`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/followers?limit=40`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/following?limit=40`, { headers }),
    ]);
    if (statusRes.ok) setStatuses(await statusRes.json() as Status[]);
    if (followersRes.ok) setFollowers(await followersRes.json() as Account[]);
    if (followingRes.ok) setFollowing(await followingRes.json() as Account[]);

    setLoading(false);
  }

  useEffect(() => {
    if (!actorUrl) return;
    void load(actorUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorUrl]);

  async function handleFollow() {
    if (!token || !account) return;
    setFollowBusy(true);
    try {
      const following = relationship?.following === true || relationship?.requested === true;
      const path = following ? "unfollow" : "follow";
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { following?: boolean; requested?: boolean };
        setRelationship((prev) => ({
          id: account.id,
          following: data.following ?? (prev?.following ?? false),
          requested: data.requested ?? (prev?.requested ?? false),
          blocking: prev?.blocking ?? false,
          followed_by: prev?.followed_by ?? false,
        }));
      }
    } catch {
      // silent
    } finally {
      setFollowBusy(false);
    }
  }

  async function handleBlock() {
    if (!token || !account) return;
    setBlockBusy(true);
    try {
      const blocking = relationship?.blocking === true;
      const path = blocking ? "unblock" : "block";
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setRelationship((prev) => ({
          id: account.id,
          following: blocking ? (prev?.following ?? false) : false,
          requested: blocking ? (prev?.requested ?? false) : false,
          blocking: !blocking,
          followed_by: prev?.followed_by ?? false,
        }));
      }
    } catch {
      // silent
    } finally {
      setBlockBusy(false);
    }
  }

  async function handleMute() {
    if (!token || !account) return;
    setMuteBusy(true);
    try {
      const muting = relationship?.muting === true;
      const path = muting ? "unmute" : "mute";
      await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setRelationship((prev) => prev ? { ...prev, muting: !muting } : prev);
    } catch {
      // silent
    } finally {
      setMuteBusy(false);
    }
  }

  function handleStatusUpdate(updated: SharedStatus) {
    const applied = updated as Status;
    setStatuses((prev) => prev.map((s) => (s.id === applied.id ? applied : s)));
  }

  function openEdit(s: SharedStatus) {
    const div = typeof document !== "undefined" ? document.createElement("div") : null;
    if (div) {
      div.innerHTML = s.content.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
      setEditText((div.textContent ?? div.innerText ?? "").trim());
    } else {
      setEditText(s.content.replace(/<[^>]*>/g, "").trim());
    }
    setEditSpoiler(s.spoiler_text ?? "");
    setEditingStatus(s);
  }

  async function handleEditSave() {
    if (!editText.trim() || !editingStatus || !token) return;
    setEditBusy(true);
    const res = await fetch(`/api/v1/statuses/${editingStatus.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: editText, spoiler_text: editSpoiler, sensitive: !!editSpoiler }),
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      setStatuses((prev) => prev.map((x) => (x.id === editingStatus.id ? updated : x)));
      setEditingStatus(null);
    }
    setEditBusy(false);
  }

  async function handleDelete(s: SharedStatus) {
    if (!token) return;
    if (!confirm("¿Eliminar este estado?")) return;
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
    }
  }

  if (loading && actorUrl) {
    return (
      <PageLayout sidebar={<Sidebar me={me} currentPath={pathname} />}>
        <div style={{ padding: "2rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />
            <div className="skeleton" style={{ height: 24, width: "40%" }} />
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
          </div>
        </div>
      </PageLayout>
    );
  }

  if (!actorUrl || notFound || !account) {
    return (
      <PageLayout sidebar={<Sidebar me={me} currentPath={pathname} />}>
        <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
          <span style={{ fontSize: "3rem" }}><Icon name="globe" size="3rem" /></span>
          <p style={{ marginTop: "1rem" }}>Cuenta no encontrada</p>
          <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>{actorUrl}</p>
        </div>
      </PageLayout>
    );
  }

  const isOwnAccount = me && me.id === account.id;
  const displayName = account.display_name || account.username;
  const isFollowing = relationship?.following === true;
  const isRequested = relationship?.requested === true;

  return (
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath={pathname} />}>
        {/* Header banner */}
        <div style={{
          width: "100%", maxWidth: "100%", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          aspectRatio: "3 / 1", minHeight: 140, maxHeight: 220,
          position: "relative",
          overflow: "hidden",
          background: account.header
            ? undefined
            : "linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-elevated) 100%)",
        }}>
          {account.header ? (
            <Image
              src={account.header}
              alt=""
              width={1500}
              height={500}
              style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, aspectRatio: "1500 / 500", objectFit: "cover", objectPosition: "center" }}
            />
          ) : null}
          {/* Remote badge */}
          <div style={{
            position: "absolute", top: "0.75rem", right: "0.75rem",
            background: "rgba(0,0,0,0.55)", color: "#fff",
            padding: "0.25rem 0.6rem", borderRadius: "var(--radius)",
            fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.3rem",
          }}>
            <Icon name="globe" color="#fff" /> {t.profile_remote_badge}
          </div>
        </div>

        {/* Profile info */}
        <div style={{ padding: "0 1.25rem 1rem", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: "-38px", marginBottom: "0.75rem", position: "relative", zIndex: 1 }}>
            <div style={{ border: "3px solid var(--bg)", borderRadius: "50%", background: "var(--bg)" }}>
              <AvatarImg account={account} size={76} />
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", position: "relative", flexWrap: "wrap" }}>
              {/* View on original server */}
              <a href={account.url} target="_blank" rel="noopener noreferrer"
                className="btn btn-ghost btn-sm"
                style={{ display: "flex", alignItems: "center", gap: "0.3rem", textDecoration: "none" }}
                title={t.profile_remote_view}>
                <Icon name="globe" /> {t.profile_remote_view}
              </a>
              {/* Follow / Unfollow / Block */}
              {token && !isOwnAccount && (
                <>
                  <button
                    className={isFollowing || isRequested ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                    onClick={() => void handleFollow()}
                    disabled={followBusy || relationship?.blocking === true}
                  >
                    {followBusy ? "…" : isFollowing ? t.account_following : isRequested ? t.account_requested : t.account_follow}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-hide-mobile"
                    style={{ border: "1px solid var(--border)", color: relationship?.blocking ? "var(--danger)" : "var(--text-muted)" }}
                    onClick={() => void handleBlock()}
                    disabled={blockBusy}
                    title={relationship?.blocking ? t.action_unblock : t.action_block}
                  >
                    {blockBusy ? "…" : (<><Icon name="ban" color={relationship?.blocking ? "var(--danger)" : undefined} />{relationship?.blocking ? ` ${t.status_blocked}` : ""}</>)}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-hide-mobile"
                    style={{ border: "1px solid var(--border)", color: relationship?.muting ? "var(--danger)" : "var(--text-muted)" }}
                    onClick={() => void handleMute()}
                    disabled={muteBusy}
                    title={relationship?.muting ? t.mute_unmute : t.mute_mute}
                  >
                    {muteBusy ? "…" : (<><Icon name="microphone-slash" color={relationship?.muting ? "var(--danger)" : undefined} />{relationship?.muting ? ` ${t.status_muted}` : ""}</>)}
                  </button>
                  {!relationship?.blocking && (
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)" }}
                      onClick={() => router.push("/messages")}
                      title="Mensaje directo"
                    >
                      <Icon name="comment" />
                    </button>
                  )}
                  {account.supports_calls && (<>
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)" }}
                      title="Llamada de voz"
                      onClick={() => void initiateCall(account.acct, "audio")}
                    >
                      <Icon name="phone" />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)" }}
                      title="Videollamada"
                      onClick={() => void initiateCall(account.acct, "video")}
                    >
                      <Icon name="video-camera" />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)" }}
                      title="Compartir pantalla"
                      onClick={() => void initiateCall(account.acct, "screen")}
                    >
                      <Icon name="desktop" />
                    </button>
                  </>)}

                  {/* ⋯ menu (mobile only) */}
                  <div className="md:hidden" style={{ position: "relative" }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ border: "1px solid var(--border)" }}
                      onClick={() => setProfileMenuOpen((v) => !v)}
                      aria-label="More actions"
                    >
                      {profileMenuOpen ? <Icon name="times" /> : <Icon name="ellipsis-h" />}
                    </button>
                    {profileMenuOpen && (
                      <div
                        style={{
                          position: "absolute",
                          right: 0,
                          top: "calc(100% + 0.25rem)",
                          zIndex: 50,
                          minWidth: 180,
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius)",
                          boxShadow: "var(--shadow-lg)",
                          padding: "0.25rem",
                          display: "flex",
                          flexDirection: "column",
                        }}
                      >
                        <button
                          className="btn btn-ghost"
                          style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: relationship?.blocking ? "var(--danger)" : undefined }}
                          onClick={() => { setProfileMenuOpen(false); void handleBlock(); }}
                          disabled={blockBusy}
                        >
                          <Icon name="ban" color={relationship?.blocking ? "var(--danger)" : undefined} /> {relationship?.blocking ? t.status_blocked : t.action_block}
                        </button>
                        <button
                          className="btn btn-ghost"
                          style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: relationship?.muting ? "var(--danger)" : undefined }}
                          onClick={() => { setProfileMenuOpen(false); void handleMute(); }}
                          disabled={muteBusy}
                        >
                          <Icon name="microphone-slash" color={relationship?.muting ? "var(--danger)" : undefined} /> {relationship?.muting ? t.mute_unmute : t.mute_mute}
                        </button>
                        {!relationship?.blocking && (
                          <button
                            className="btn btn-ghost"
                            style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
                            onClick={() => { setProfileMenuOpen(false); router.push("/messages"); }}
                          >
                            <Icon name="comment" /> {t.messages_title}
                          </button>
                        )}
                        {account.supports_calls && (<>
                          <button
                            className="btn btn-ghost"
                            style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
                            onClick={() => { setProfileMenuOpen(false); void initiateCall(account.acct, "audio"); }}
                          >
                            <Icon name="phone" /> {t.profile_call_voice}
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
                            onClick={() => { setProfileMenuOpen(false); void initiateCall(account.acct, "video"); }}
                          >
                            <Icon name="video-camera" /> {t.profile_call_video}
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
                            onClick={() => { setProfileMenuOpen(false); void initiateCall(account.acct, "screen"); }}
                          >
                            <Icon name="desktop" /> {t.profile_call_screen}
                          </button>
                        </>)}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "0.1rem" }}>
            {displayName}
            {account.roles?.some((r) => r.name.toLowerCase() === "admin") && (
              <span style={{ marginLeft: "0.4rem", verticalAlign: "middle" }} title="Admin"><Icon name="trophy" size="0.9rem" /></span>
            )}
            {account.roles?.some((r) => r.name.toLowerCase() === "moderator") && (
              <span style={{ marginLeft: "0.4rem", verticalAlign: "middle" }} title="Moderator"><Icon name="trophy" size="0.9rem" color="var(--text-muted)" /></span>
            )}
            {account.bot && (
              <span
                style={{
                  marginLeft: "0.5rem", fontSize: "0.7rem", padding: "0.1rem 0.4rem",
                  borderRadius: "var(--radius-sm)", background: "var(--accent-bg)",
                  color: "var(--accent)", verticalAlign: "middle",
                }}
              >
                BOT
              </span>
            )}
            {!isOwnAccount && relationship?.followed_by && (
              <span
                style={{
                  marginLeft: "0.5rem", fontSize: "0.7rem", padding: "0.1rem 0.45rem",
                  borderRadius: "var(--radius-sm)", background: "rgba(52,211,153,0.12)",
                  color: "var(--success)", verticalAlign: "middle", whiteSpace: "nowrap",
                }}
              >
                {t.account_follows_you}
              </span>
            )}
          </div>
          <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>@{account.acct}</div>

          {account.note && (
            <div
              style={{ fontSize: "0.925rem", lineHeight: 1.55, color: "var(--text-secondary)", marginBottom: "0.75rem" }}
            >
              <RichText html={account.note} />
            </div>
          )}
          {/* Profile fields */}
          {account.fields && account.fields.length > 0 && (
            <div style={{ marginBottom: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", display: "grid", gridTemplateColumns: "max-content 1fr" }}>
              {account.fields.map((f, i) => (
                <Fragment key={i}>
                  <div style={{ padding: "0.4rem 0.75rem", background: "var(--bg-elevated)", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-secondary)", borderRight: "1px solid var(--border)", borderBottom: i < (account.fields?.length ?? 0) - 1 ? "1px solid var(--border)" : "none" }}>
                    {f.name}
                    {f.verified_at && <span style={{ color: "var(--accent)", marginLeft: "0.25rem" }}>✓</span>}
                  </div>
                  <div style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", wordBreak: "break-all", borderBottom: i < (account.fields?.length ?? 0) - 1 ? "1px solid var(--border)" : "none" }}><RichText html={f.value} /></div>
                </Fragment>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.85rem", color: "var(--text-muted)" }}>
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: activeTab === "posts" ? "var(--accent)" : "inherit" }} onClick={() => setActiveTab("posts")}><strong style={{ color: "var(--text)" }}>{account.statuses_count}</strong> {t.profile_posts_label}</button>
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: activeTab === "following" ? "var(--accent)" : "inherit" }} onClick={() => setActiveTab("following")}><strong style={{ color: "var(--text)" }}>{account.following_count}</strong> {t.profile_following_label}</button>
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: activeTab === "followers" ? "var(--accent)" : "inherit" }} onClick={() => setActiveTab("followers")}><strong style={{ color: "var(--text)" }}>{account.followers_count}</strong> {t.profile_followers_label}</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "2px solid var(--border)" }}>
          {(["posts", "following", "followers"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className="btn btn-ghost btn-sm" style={{ flex: 1, borderRadius: 0, borderBottom: activeTab === tab ? "2px solid var(--accent)" : "none", marginBottom: "-2px", fontWeight: activeTab === tab ? 700 : 400, color: activeTab === tab ? "var(--accent)" : "var(--text-muted)" }}>
              {tab === "posts" ? t.profile_posts_label : tab === "following" ? t.profile_following_label : t.profile_followers_label}
            </button>
          ))}
        </div>

        {/* Posts tab */}
        {activeTab === "posts" && (statuses.length === 0 ? (
          <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <p>{t.profile_remote_no_posts}</p>
            <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <a href={account.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                {t.profile_remote_view_full}
              </a>
            </p>
          </div>
        ) : (
          <div>
            {statuses.map((s) => (
              <StatusCard
                key={s.id}
                status={s}
                onFav={handleStatusUpdate}
                onReblog={handleStatusUpdate}
                onReply={(st) => router.push(`/statuses/${encodeURIComponent(st.id)}?reply=1`)}
                me={me}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        ))}

        {/* Followers tab */}
        {activeTab === "followers" && (
          followers.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_remote_no_followers}</div>
          ) : (
            <div>
              {followers.map((f) => (
                <AccountRow key={f.id} account={f} />
              ))}
            </div>
          )
        )}

        {/* Following tab */}
        {activeTab === "following" && (
          following.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_remote_no_following}</div>
          ) : (
            <div>
              {following.map((f) => (
                <AccountRow key={f.id} account={f} />
              ))}
            </div>
          )
        )}
    </PageLayout>

      {/* Edit status modal */}
      {editingStatus && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.edit_status_title}
          style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditingStatus(null); }}
        >
          <div style={{ background: "var(--bg)", borderRadius: "var(--radius-lg)", padding: "1.25rem", width: "min(520px, 95vw)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "1rem" }}>{t.edit_status_title}</span>
              <button type="button" onClick={() => setEditingStatus(null)} aria-label={t.action_close} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}><Icon name="times" color="var(--text-muted)" /></button>
            </div>
            {editSpoiler !== "" || editingStatus.spoiler_text ? (
              <input
                type="text"
                value={editSpoiler}
                onChange={(e) => setEditSpoiler(e.target.value)}
                placeholder={t.cw_placeholder}
                className="input"
                style={{ width: "100%" }}
              />
            ) : null}
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder={t.edit_status_placeholder}
              maxLength={500}
              className="input"
              style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{editText.length}/500</span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingStatus(null)}>{t.profile_cancel}</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={!editText.trim() || editBusy} onClick={() => void handleEditSave()}>
                  {editBusy ? "…" : t.profile_save}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function RemoteProfilePage() {
  return (
    <Suspense fallback={<PageLayout><div style={{ color: "var(--text-muted)", padding: "2rem", textAlign: "center" }}>Cargando…</div></PageLayout>}>
      <RemoteProfileInner />
    </Suspense>
  );
}
