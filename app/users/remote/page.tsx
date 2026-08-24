"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, Suspense, Fragment, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useStartCallButton } from "@/components/CallOverlay";
import { StatusCard } from "@/components/StatusCard";
import { RichText } from "@/components/RichText";
import { DisplayName } from "@/components/DisplayName";
import type { EmojiData } from "@/lib/emoji";
import { Lightbox } from "@/components/Lightbox";
import type { Status as SharedStatus } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import { EditStatusModal } from "@/components/EditStatusModal";

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
  emojis?: EmojiData[];
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

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash?: string | null;
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

interface Status {
  id: string;
  content: string;
  created_at: string;
  in_reply_to_id?: string | null;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  pinned?: boolean;
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

interface Collection {
  id: string;
  name: string;
  description: string | null;
  item_count: number;
}

type ActiveTab = "posts" | "replies" | "pinned" | "media" | "following" | "followers" | "collections";

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

function AccountRow({ account }: { account: Account }) {
  const href = account.url?.startsWith("http") ? `/users/remote?url=${encodeURIComponent(account.url)}` : "#";
  return (
    <a href={href} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}>
      <AvatarImg account={account} size={46} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><DisplayName name={account.display_name || account.username} emojis={account.emojis} /></div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{account.acct}</div>
        {account.note && (
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.2rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <RichText html={account.note} />
          </div>
        )}
      </div>
    </a>
  );
}

// Flat media grid with global lightbox (media tab)
function ProfileMediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "2px", padding: "2px" }}>
        {attachments.map((att, i) => (
          <button
            key={att.id}
            type="button"
            onClick={() => setLbIdx(i)}
            title={att.description ?? undefined}
            style={{ display: "block", position: "relative", aspectRatio: "1/1", overflow: "hidden", border: "none", padding: 0, cursor: "zoom-in", background: "var(--bg-elevated)" }}
          >
            {att.type === "image" || att.type === "gifv" ? (
              <Image
                src={att.preview_url ?? att.url}
                alt={att.description ?? ""}
                fill
                sizes="(max-width: 768px) 100vw, 600px"
                style={{ objectFit: "cover" }}
              />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name={att.type === "video" ? "film" : "music"} size="2rem" />
              </div>
            )}
          </button>
        ))}
      </div>
      {lbIdx !== null && (
        <Lightbox
          media={attachments.map((a) => ({ url: a.url, preview_url: a.preview_url, description: a.description, type: a.type }))}
          index={lbIdx}
          onClose={() => setLbIdx(null)}
          onNav={setLbIdx}
        />
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function RemoteProfileInner() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const actorUrl = searchParams.get("url");
  const { t } = useLocale();

  const [account, setAccount] = useState<Account | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [replies, setReplies] = useState<Status[]>([]);
  const [pinnedStatuses, setPinnedStatuses] = useState<Status[]>([]);
  const [followers, setFollowers] = useState<Account[]>([]);
  const [following, setFollowing] = useState<Account[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>("posts");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [endorsed, setEndorsed] = useState(false);
  const [endorseBusy, setEndorseBusy] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [me, setMe] = useState<Account | null>(null);
  const [editingStatus, setEditingStatus] = useState<SharedStatus | null>(null);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Profile header actions menu (⋯ on mobile)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [avatarLb, setAvatarLb] = useState(false);

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

    // Load cached statuses, replies, pinned, followers, following and collections in parallel
    const [statusRes, repliesRes, pinnedRes, followersRes, followingRes, collectionsRes] = await Promise.all([
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?limit=20`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?only_replies=true&limit=20`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?pinned=true&limit=20`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/followers?limit=40`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/following?limit=40`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/collections`, { headers }),
    ]);
    if (statusRes.ok) {
      const data = await statusRes.json() as Status[];
      setStatuses(data);
      setHasMorePosts(data.length >= 20);
    }
    if (repliesRes.ok) setReplies(await repliesRes.json() as Status[]);
    if (pinnedRes.ok) setPinnedStatuses(await pinnedRes.json() as Status[]);
    if (followersRes.ok) setFollowers(await followersRes.json() as Account[]);
    if (followingRes.ok) setFollowing(await followingRes.json() as Account[]);
    if (collectionsRes.ok) {
      const data = await collectionsRes.json() as { collections: Collection[] };
      setCollections(data.collections ?? []);
    }

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

  async function toggleEndorse() {
    if (!token || !account || endorseBusy) return;
    setEndorseBusy(true);
    const path = endorsed ? "unpin" : "pin";
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setEndorsed((v) => !v);
    setEndorseBusy(false);
  }

  async function handleSaveNote() {
    if (!token || !account || noteBusy) return;
    setNoteBusy(true);
    await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/note`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment: noteText }),
    });
    setNoteOpen(false);
    setNoteBusy(false);
  }

  async function loadMorePosts() {
    if (!account || loadingMorePosts || !hasMorePosts || statuses.length === 0) return;
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMorePosts(true);
    const oldestId = statuses[statuses.length - 1].id;
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?max_id=${encodeURIComponent(oldestId)}&limit=20`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...data]);
      setHasMorePosts(data.length >= 20);
    }
    setLoadingMorePosts(false);
  }

  // Infinite scroll for the posts tab
  useEffect(() => {
    if (!bottomRef.current) return;
    if (activeTab !== "posts" || !hasMorePosts || loadingMorePosts) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) void loadMorePosts(); },
      { rootMargin: "300px" }
    );
    obs.observe(bottomRef.current);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMorePosts, loadingMorePosts, statuses, activeTab]);

  function handleStatusUpdate(updated: SharedStatus) {
    const applied = updated as Status;
    const apply = (prev: Status[]) => prev.map((x) => (x.id === applied.id ? applied : x));
    setStatuses(apply);
    setReplies(apply);
    setPinnedStatuses(apply);
  }

  function openEdit(s: SharedStatus) {
    setEditingStatus(s);
  }

  function handleStatusSaved(updated: SharedStatus) {
    const applied = updated as Status;
    const apply = (prev: Status[]) => prev.map((x) => (x.id === applied.id ? applied : x));
    setStatuses(apply);
    setReplies(apply);
    setPinnedStatuses(apply);
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
      setReplies((prev) => prev.filter((x) => x.id !== s.id));
      setPinnedStatuses((prev) => prev.filter((x) => x.id !== s.id));
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
          <p style={{ marginTop: "1rem" }}>{t.profile_not_found}</p>
          <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>{actorUrl}</p>
        </div>
      </PageLayout>
    );
  }

  const isOwnAccount = me && me.id === account.id;
  const isFollowing = relationship?.following === true;
  const isRequested = relationship?.requested === true;
  const allAttachments = statuses.flatMap((s) => s.media_attachments);

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

        {/* Avatar + actions row */}
        <div
          style={{
            display: "flex", alignItems: "flex-end", justifyContent: "space-between",
            flexWrap: "wrap", gap: "0.5rem",
            padding: "0 1rem",
            marginTop: -44,
            position: "relative",
            zIndex: 1,
          }}
        >
          <button
            type="button"
            onClick={() => account.avatar ? setAvatarLb(true) : undefined}
            aria-label={account.avatar ? `${account.display_name} avatar` : undefined}
            style={{
              width: 88, height: 88,
              borderRadius: "50%",
              border: "4px solid var(--bg)",
              overflow: "hidden",
              background: "var(--accent-bg)",
              display: "flex", alignItems: "center", justifyContent: "center",
              position: "relative",
              fontSize: "2.5rem", fontWeight: 700, color: "var(--accent)",
              cursor: account.avatar ? "zoom-in" : "default",
              padding: 0,
            }}
          >
            {account.avatar ? (
              <Image
                src={account.avatar}
                alt={account.display_name}
                fill
                sizes="88px"
                style={{ objectFit: "cover" }}
              />
            ) : (
              (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()
            )}
          </button>

          <div className="flex gap-2" style={{ paddingBottom: "0.5rem", position: "relative" }}>
            {/* View on original server */}
            <a href={account.url} target="_blank" rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
              style={{ display: "flex", alignItems: "center", gap: "0.3rem", textDecoration: "none", border: "1px solid var(--border)" }}
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
                    title={t.messages_title}
                  >
                    <Icon name="comment" />
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm btn-hide-mobile"
                  style={{ border: "1px solid var(--border)", color: endorsed ? "var(--accent)" : "var(--text-muted)" }}
                  onClick={() => void toggleEndorse()}
                  disabled={endorseBusy}
                  title={endorsed ? t.profile_unendorse : t.profile_endorse}
                >
                  {endorseBusy ? "…" : <Icon name={endorsed ? "star" : "star-o"} color={endorsed ? "var(--accent)" : undefined} />}
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-hide-mobile"
                  style={{ border: "1px solid var(--border)" }}
                  onClick={() => setNoteOpen(true)}
                  title={t.profile_note}
                >
                  <Icon name="pencil" />
                </button>
                {account.supports_calls && (<>
                  <button
                    className="btn btn-ghost btn-sm btn-hide-mobile"
                    style={{ border: "1px solid var(--border)" }}
                    title={t.profile_call_voice}
                    onClick={() => void initiateCall(account.acct, "audio")}
                  >
                    <Icon name="phone" />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-hide-mobile"
                    style={{ border: "1px solid var(--border)" }}
                    title={t.profile_call_video}
                    onClick={() => void initiateCall(account.acct, "video")}
                  >
                    <Icon name="video-camera" />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-hide-mobile"
                    style={{ border: "1px solid var(--border)" }}
                    title={t.profile_call_screen}
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
                    aria-label={t.a11y_more_actions}
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
                      <button
                        className="btn btn-ghost"
                        style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: endorsed ? "var(--accent)" : undefined }}
                        onClick={() => { setProfileMenuOpen(false); void toggleEndorse(); }}
                        disabled={endorseBusy}
                      >
                        <Icon name={endorsed ? "star" : "star-o"} /> {endorsed ? t.profile_unendorse : t.profile_endorse}
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
                        onClick={() => { setProfileMenuOpen(false); setNoteOpen(true); }}
                      >
                        <Icon name="pencil" /> {t.profile_note}
                      </button>
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

        {/* Profile info */}
        <div style={{ padding: "0.75rem 1rem 0" }}>
          <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>
            <DisplayName name={account.display_name || account.username} emojis={account.emojis} />
            {account.roles?.some((r) => r.name.toLowerCase() === "admin") && (
              <span style={{ marginLeft: "0.4rem", verticalAlign: "middle" }} title={t.admin_role_admin}><Icon name="trophy" size="0.9rem" /></span>
            )}
            {account.roles?.some((r) => r.name.toLowerCase() === "moderator") && (
              <span style={{ marginLeft: "0.4rem", verticalAlign: "middle" }} title={t.admin_role_moderator}><Icon name="trophy" size="0.9rem" color="var(--text-muted)" /></span>
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
          <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "0.5rem" }}>@{account.acct}</div>

          {account.note && (
            <div style={{ fontSize: "0.9rem", lineHeight: 1.55, marginBottom: "0.75rem", whiteSpace: "pre-line" }}>
              <RichText html={account.note} />
            </div>
          )}

          {/* Profile fields (Mastodon-style key/value pairs) */}
          {account.fields && account.fields.length > 0 && (
            <div style={{ marginBottom: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", display: "grid", gridTemplateColumns: "max-content 1fr" }}>
              {account.fields.map((f, i) => (
                <Fragment key={i}>
                  <div style={{ padding: "0.4rem 0.75rem", background: "var(--bg-elevated)", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-secondary)", borderRight: "1px solid var(--border)", borderBottom: i < (account.fields?.length ?? 0) - 1 ? "1px solid var(--border)" : "none" }}>
                    <DisplayName name={f.name} emojis={account.emojis} />
                    {f.verified_at && <span style={{ color: "var(--accent)", marginLeft: "0.25rem" }}>✓</span>}
                  </div>
                  <div style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", wordBreak: "break-all", borderBottom: i < (account.fields?.length ?? 0) - 1 ? "1px solid var(--border)" : "none" }}><RichText html={f.value} /></div>
                </Fragment>
              ))}
            </div>
          )}

          {/* Stats */}
          <div className="flex gap-5" style={{ padding: "0.75rem 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
            {[
              { label: t.profile_posts, value: account.statuses_count },
              { label: t.profile_following, value: account.following_count },
              { label: t.profile_followers, value: account.followers_count },
            ].map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-0.5">
                <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>{s.value.toLocaleString()}</span>
                <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex" style={{ borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
          {([
            { key: "posts" as ActiveTab, label: t.profile_posts, count: account.statuses_count },
            { key: "replies" as ActiveTab, label: t.profile_replies },
            { key: "pinned" as ActiveTab, label: <Icon name="thumb-tack" size="0.9rem" />, count: pinnedStatuses.length },
            { key: "media" as ActiveTab, label: t.profile_media, count: allAttachments.length },
            { key: "following" as ActiveTab, label: t.profile_following, count: account.following_count },
            { key: "followers" as ActiveTab, label: t.profile_followers, count: account.followers_count },
            { key: "collections" as ActiveTab, label: t.profile_collections },
          ]).map((tab) => (
            <button
              key={tab.key}
              className="btn btn-ghost"
              onClick={() => setActiveTab(tab.key)}
              style={{
                flex: "0 0 auto",
                borderRadius: 0,
                padding: "0.875rem 1rem",
                borderBottom: activeTab === tab.key ? "2px solid var(--accent)" : "2px solid transparent",
                color: activeTab === tab.key ? "var(--accent)" : "var(--text-muted)",
                fontWeight: activeTab === tab.key ? 600 : 400,
                whiteSpace: "nowrap",
                fontSize: "0.875rem",
              }}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span style={{ marginLeft: "0.35rem", fontSize: "0.78rem", opacity: 0.7 }}>{tab.count.toLocaleString()}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "posts" && (
          statuses.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
              <p>{t.profile_remote_no_posts}</p>
              <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
                <a href={account.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                  {t.profile_remote_view_full}
                </a>
              </p>
            </div>
          ) : (
            <>
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
              <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                {loadingMorePosts ? t.loading : ""}
              </div>
            </>
          )
        )}

        {activeTab === "replies" && (
          replies.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_replies}</div>
          ) : (
            replies.map((s) => (
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
            ))
          )
        )}

        {activeTab === "pinned" && (
          pinnedStatuses.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_pinned}</div>
          ) : (
            pinnedStatuses.map((s) => (
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
            ))
          )
        )}

        {activeTab === "media" && (
          allAttachments.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_media}</div>
          ) : (
            <ProfileMediaGrid attachments={allAttachments} />
          )
        )}

        {activeTab === "following" && (
          following.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_following}</div>
          ) : (
            following.map((f) => <AccountRow key={f.id} account={f} />)
          )
        )}

        {activeTab === "followers" && (
          followers.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_followers}</div>
          ) : (
            followers.map((f) => <AccountRow key={f.id} account={f} />)
          )
        )}

        {activeTab === "collections" && (
          collections.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
              <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}><Icon name="users" size="2rem" /></span>
              {t.collections_empty}
            </div>
          ) : (
            collections.map((c) => (
              <Link
                key={c.id}
                href={`/collections/${encodeURIComponent(c.id)}`}
                style={{ display: "flex", alignItems: "center", gap: "0.875rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}
              >
                <div style={{ width: 42, height: 42, flexShrink: 0, borderRadius: "var(--radius)", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
                  <Icon name="users" size="1.1rem" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>{c.name}</div>
                  {c.description && (
                    <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "0.1rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</div>
                  )}
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>
                    {t.collections_item_count.replace("{count}", String(c.item_count))}
                  </div>
                </div>
                <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "1rem" }}><Icon name="chevron-right" /></span>
              </Link>
            ))
          )
        )}
    </PageLayout>

      {/* Avatar lightbox */}
      {avatarLb && account?.avatar && (
        <Lightbox
          media={[{ url: account.avatar, preview_url: account.avatar, description: account.display_name, type: "image" }]}
          index={0}
          onClose={() => setAvatarLb(false)}
          onNav={() => undefined}
        />
      )}

      {/* Note modal */}
      {noteOpen && account && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.profile_note}
          style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", padding: "1rem" }}
          onClick={(e) => { if (e.target === e.currentTarget) setNoteOpen(false); }}
        >
          <div style={{ background: "var(--bg-surface)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border)", width: "100%", maxWidth: 420, padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "1rem" }}>{t.profile_note}</span>
              <button type="button" onClick={() => setNoteOpen(false)} aria-label={t.action_close} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}><Icon name="times" color="var(--text-muted)" /></button>
            </div>
            <textarea
              autoFocus
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={t.note_placeholder}
              aria-label={t.note_placeholder}
              maxLength={500}
              className="input"
              style={{ resize: "none", minHeight: 100, fontFamily: "inherit", width: "100%" }}
            />
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNoteOpen(false)}>{t.profile_cancel}</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={noteBusy} onClick={() => void handleSaveNote()}>
                {noteBusy ? "…" : t.profile_save}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit status modal */}
      <EditStatusModal status={editingStatus} onClose={() => setEditingStatus(null)} onSaved={handleStatusSaved} />
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