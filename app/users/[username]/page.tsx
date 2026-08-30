"use client";

import { useState, useEffect, useRef, Fragment } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { Lightbox } from "@/components/Lightbox";
import { useStartCallButton } from "@/components/CallOverlay";
import { StatusCard } from "@/components/StatusCard";
import { RichText } from "@/components/RichText";
import { DisplayName } from "@/components/DisplayName";
import type { EmojiData } from "@/lib/emoji";
import type { Status as SharedStatus } from "@/components/StatusCard";
import type { APMeta } from "@/components/APTypeBlock";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import { EditStatusModal } from "@/components/EditStatusModal";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";
import { EmojiInput } from "@/components/EmojiInput";
import { useLimits } from "@/lib/limits-client";
import { purgeStatusFromCache } from "@/lib/streaming/timeline-cache";

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
  verified?: boolean;
  avatar: string;
  header: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  locked: boolean;
  bot: boolean;
  url: string;
  created_at: string;
  fields: MastodonField[];
  roles?: { id: string; name: string; color: string }[];
  supports_calls?: boolean;
  source?: {
    note: string;
    fields: MastodonField[];
    privacy: string;
    auto_delete_after?: number | null;
  };
}

type ActiveTab = "posts" | "replies" | "media" | "followers" | "following" | "pinned" | "collections";

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash: string | null;
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
  visibility: string;
  language?: string | null;
  poll: Poll | null;
  ap_type?: string | null;
  ap_meta?: APMeta | null;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  source?: {
    note: string;
    fields: MastodonField[];
    privacy: string;
    auto_delete_after?: number | null;
  };
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function AvatarBubble({ account, size = 42 }: { account: { display_name: string; username: string; avatar: string }; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const fallback = (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase();

  if (!imgError && account.avatar) {
    return (
      <Image
        src={account.avatar}
        alt={account.display_name}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      style={{
        width: size, height: size, flexShrink: 0,
        background: "var(--accent-bg)",
        border: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: "50%", fontSize: size * 0.45, fontWeight: 700,
        color: "var(--accent)",
      }}
    >
      {fallback}
    </div>
  );
}


// Flat media grid with global lightbox (for profile media tab)
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

// Account card for followers/following lists
function AccountCard({ acct }: { acct: Account }) {
  const { t } = useLocale();
  const isRemote = acct.acct.includes("@");
  const profileHref = isRemote
    ? `/users/remote?url=${encodeURIComponent(acct.id)}`
    : `/users/${acct.username}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)" }}>
      <Link href={profileHref} style={{ flexShrink: 0 }}><AvatarBubble account={acct} size={46} /></Link>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
          <DisplayName name={acct.display_name || acct.username} emojis={acct.emojis} />
          {acct.verified && (
            <span title={t.verified_badge} style={{ marginLeft: "0.25rem", verticalAlign: "middle" }}><Icon name="check" color="var(--success)" size="0.8rem" /></span>
          )}
        </Link>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>@{acct.acct}</div>
        {acct.note && (
          <div
            style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            <RichText html={acct.note} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter();
  const routeUsername = useParams<{ username: string }>()?.username ?? "";
  const [username, setUsername] = useState<string>("");
  const [account, setAccount] = useState<Account | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [replies, setReplies] = useState<Status[]>([]);
  const [pinnedStatuses, setPinnedStatuses] = useState<Status[]>([]);
  const [followers, setFollowers] = useState<Account[]>([]);
  const [following, setFollowing] = useState<Account[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("posts");
  const [tabLoaded, setTabLoaded] = useState<Record<string, boolean>>({ posts: false });
  const [endorsed, setEndorsed] = useState(false);
  const [endorseBusy, setEndorseBusy] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [hasMoreFollowers, setHasMoreFollowers] = useState(true);
  const [loadingMoreFollowers, setLoadingMoreFollowers] = useState(false);
  const [hasMoreFollowing, setHasMoreFollowing] = useState(true);
  const [loadingMoreFollowing, setLoadingMoreFollowing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Status edit state
  const [editingStatus, setEditingStatus] = useState<SharedStatus | null>(null);

  // Profile header actions menu (⋯ on mobile)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [avatarLb, setAvatarLb] = useState(false);

  // Edit form state
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editNote, setEditNote] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<{ name: string; value: string }[]>([]);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const bioTextareaRef = useRef<HTMLTextAreaElement>(null);
  const bioAuto = useEmojiAutocomplete(editNote, setEditNote, bioTextareaRef);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const displayNameAuto = useEmojiAutocomplete(editDisplayName, setEditDisplayName, displayNameRef);

  const token = getToken();

  async function load(uname: string) {
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    const [accountRes, meRes] = await Promise.all([
      fetch(`/api/v1/accounts/lookup?acct=${encodeURIComponent(uname)}`),
      token ? fetch("/api/v1/accounts/verify_credentials", { headers: authHeaders }) : Promise.resolve(null),
    ]);

    if (!accountRes.ok) { setNotFound(true); setLoading(false); return; }
    const acct = await accountRes.json() as Account;
    setAccount(acct);

    if (meRes?.ok) {
      const meData = await meRes.json() as Me;
      setMe(meData);

      if (meData.id !== acct.id) {
        const relRes = await fetch(`/api/v1/accounts/relationships?id[]=${encodeURIComponent(acct.id)}`, {
          headers: authHeaders,
        });
        if (relRes.ok) {
          const [rel] = await relRes.json() as Relationship[];
          setRelationship(rel ?? null);
        }
      }
    }

    // Load statuses
    const statusRes = await fetch(
      `/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?limit=${limits.defaultTimelinePage}`,
      { headers: authHeaders }
    );
    if (statusRes.ok) {
      const data = await statusRes.json() as Status[];
      setStatuses(data);
      setHasMorePosts(data.length >= limits.defaultTimelinePage);
    }
    setTabLoaded((p) => ({ ...p, posts: true }));

    setLoading(false);
  }

  // Reset all user-specific state when navigating between profiles
  // (render-phase reset — the recommended React pattern for "state that resets
  // when a prop changes" — so no setState calls fire from an effect).
  const [prevRoute, setPrevRoute] = useState(routeUsername);
  if (prevRoute !== routeUsername) {
    setPrevRoute(routeUsername);
    setUsername(routeUsername);
    setAccount(null);
    setStatuses([]);
    setReplies([]);
    setPinnedStatuses([]);
    setFollowers([]);
    setFollowing([]);
    setCollections([]);
    setRelationship(null);
    setNotFound(false);
    setActiveTab("posts");
    setLoading(true);
  }

  useEffect(() => {
    if (!routeUsername) return;
    Promise.resolve().then(() => void load(routeUsername));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeUsername]);

  async function loadMorePosts() {
    if (!account || loadingMorePosts || !hasMorePosts || statuses.length === 0) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMorePosts(true);
    const oldestId = statuses[statuses.length - 1].id;
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?max_id=${encodeURIComponent(oldestId)}&limit=20`,
      { headers: authHeaders }
    );
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...data]);
      setHasMorePosts(data.length >= limits.defaultTimelinePage);
    }
    setLoadingMorePosts(false);
  }

  async function loadMoreFollowers() {
    if (!account || loadingMoreFollowers || !hasMoreFollowers) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMoreFollowers(true);
    const nextPage = Math.floor(followers.length / 40);
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/followers?limit=${limits.pageSize}&page=${nextPage}`,
      { headers: authHeaders }
    );
    if (res.ok) {
      const data = await res.json() as Account[];
      setFollowers((prev) => [...prev, ...data]);
      setHasMoreFollowers(data.length >= limits.pageSize);
    }
    setLoadingMoreFollowers(false);
  }

  async function loadMoreFollowing() {
    if (!account || loadingMoreFollowing || !hasMoreFollowing) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMoreFollowing(true);
    const nextPage = Math.floor(following.length / 40);
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/following?limit=${limits.pageSize}&page=${nextPage}`,
      { headers: authHeaders }
    );
    if (res.ok) {
      const data = await res.json() as Account[];
      setFollowing((prev) => [...prev, ...data]);
      setHasMoreFollowing(data.length >= limits.pageSize);
    }
    setLoadingMoreFollowing(false);
  }

  // Infinite scroll for posts, followers, following tabs
  useEffect(() => {
    if (!bottomRef.current) return;
    if (activeTab === "posts" && (!hasMorePosts || loadingMorePosts)) return;
    if (activeTab === "followers" && (!hasMoreFollowers || loadingMoreFollowers)) return;
    if (activeTab === "following" && (!hasMoreFollowing || loadingMoreFollowing)) return;
    if (activeTab !== "posts" && activeTab !== "followers" && activeTab !== "following") return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        if (activeTab === "posts") void loadMorePosts();
        else if (activeTab === "followers") void loadMoreFollowers();
        else if (activeTab === "following") void loadMoreFollowing();
      },
      { rootMargin: "300px" }
    );
    obs.observe(bottomRef.current);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMorePosts, loadingMorePosts, statuses, activeTab, hasMoreFollowers, loadingMoreFollowers, followers, hasMoreFollowing, loadingMoreFollowing, following]);

  async function loadTab(tab: ActiveTab, acctId: string) {
    if (tabLoaded[tab]) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    if (tab === "replies") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/statuses?only_replies=true&limit=20`,
        { headers: authHeaders }
      );
      if (res.ok) setReplies(await res.json() as Status[]);
    } else if (tab === "pinned") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/statuses?pinned=true&limit=20`,
        { headers: authHeaders }
      );
      if (res.ok) setPinnedStatuses(await res.json() as Status[]);
    } else if (tab === "followers") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/followers?limit=${limits.pageSize}`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json() as Account[];
        setFollowers(data);
        setHasMoreFollowers(data.length >= limits.pageSize);
      }
    } else if (tab === "following") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/following?limit=${limits.pageSize}`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json() as Account[];
        setFollowing(data);
        setHasMoreFollowing(data.length >= limits.pageSize);
      }
    } else if (tab === "collections") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/collections`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json() as { collections: Collection[] };
        setCollections(data.collections ?? []);
      }
    }
    setTabLoaded((p) => ({ ...p, [tab]: true }));
  }

  function handleTabChange(tab: ActiveTab) {
    setActiveTab(tab);
    if (account) void loadTab(tab, account.id);
  }

  function openEdit(acct: Account) {
    setEditDisplayName(acct.display_name || "");
    setEditNote(acct.source?.note ?? me?.source?.note ?? acct.note ?? "");
    setAvatarPreview(null);
    setHeaderPreview(null);
    setAvatarFile(null);
    setHeaderFile(null);
    setEditError(null);
    const currentFields = (acct.source?.fields ?? me?.source?.fields ?? []).slice(0, limits.maxProfileFields);
    setEditFields(currentFields.map((f) => ({ name: f.name, value: f.value })));
    setEditOpen(true);
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSaving(true);
    setEditError(null);

    const form = new FormData();
    form.append("display_name", editDisplayName);
    form.append("note", editNote);
    if (avatarFile) form.append("avatar", avatarFile);
    if (headerFile) form.append("header", headerFile);
    editFields.forEach((f, i) => {
      form.append(`fields_attributes[${i}][name]`, f.name);
      form.append(`fields_attributes[${i}][value]`, f.value);
    });
    form.append("fields", JSON.stringify(editFields.map((f) => ({ name: f.name, value: f.value }))));

    const res = await fetch("/api/v1/accounts/verify_credentials", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    if (res.ok) {
      const updated = await res.json() as Account;
      setAccount(updated);
      setEditOpen(false);
    } else {
      const err = await res.json() as { error?: string };
      setEditError(err.error ?? "Failed to save");
    }
    setSaving(false);
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setAvatarFile(f);
    setAvatarPreview(URL.createObjectURL(f));
  }

  function handleHeaderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setHeaderFile(f);
    setHeaderPreview(URL.createObjectURL(f));
  }

  function addField() {
    if (editFields.length >= limits.maxProfileFields) return;
    setEditFields((p) => [...p, { name: "", value: "" }]);
  }

  function removeField(i: number) {
    setEditFields((p) => p.filter((_, idx) => idx !== i));
  }

  function updateField(i: number, key: "name" | "value", val: string) {
    setEditFields((p) => p.map((f, idx) => (idx === i ? { ...f, [key]: val } : f)));
  }

  function handleStatusUpdate(updated: SharedStatus) {
    const applied = updated as Status;
    const apply = (prev: Status[]) => prev.map((x) => (x.id === applied.id ? applied : x));
    setStatuses(apply);
    setReplies(apply);
    setPinnedStatuses(apply);
  }

  function openStatusEdit(s: SharedStatus) {
    setEditingStatus(s);
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
      purgeStatusFromCache(s.id);
    }
  }

  async function toggleFollow() {
    if (!token || !account || followBusy) return;
    setFollowBusy(true);
    const following = relationship?.following === true || relationship?.requested === true;
    const path = following ? "unfollow" : "follow";
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as { following?: boolean; requested?: boolean };
      setRelationship((prev) => ({
        ...(prev ?? { id: account.id, blocking: false }),
        following: data.following ?? false,
        requested: data.requested ?? false,
      }));
    }
    setFollowBusy(false);
  }

  async function toggleBlock() {
    if (!token || !account || blockBusy) return;
    setBlockBusy(true);
    const blocking = relationship?.blocking === true;
    const path = blocking ? "unblock" : "block";
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setRelationship((prev) => ({
        ...(prev ?? { id: account.id, following: false, requested: false }),
        blocking: !blocking,
        // unblock doesn't automatically re-follow
        following: blocking ? (prev?.following ?? false) : false,
        requested: blocking ? (prev?.requested ?? false) : false,
      }));
    }
    setBlockBusy(false);
  }

  async function toggleMute() {
    if (!token || !account || muteBusy) return;
    setMuteBusy(true);
    const muting = relationship?.muting === true;
    const path = muting ? "unmute" : "mute";
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setRelationship((prev) => prev ? { ...prev, muting: !muting } : prev);
    setMuteBusy(false);
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

  const isOwnProfile = me && account && me.id === account.id;
  const allAttachments = statuses.flatMap((s) => s.media_attachments);
  const { t } = useLocale();
  const limits = useLimits();
  const { startCall: initiateCall } = useStartCallButton(token);

  return (
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath={`/users/${username}`} />}>
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
        ) : notFound || !account ? (
          <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}><Icon name="user" size="3rem" /></div>
            <p style={{ fontWeight: 600 }}>{t.profile_not_found}</p>
            <Link href="/explore" className="btn btn-ghost btn-sm" style={{ marginTop: "1rem" }}>{t.nav_explore}</Link>
          </div>
        ) : (
          <>
            {/* Header banner */}
            <div
              style={{
                width: "100%", maxWidth: "100%", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                aspectRatio: "3 / 1", minHeight: 140, maxHeight: 220,
                position: "relative", overflow: "hidden",
                background: account.header
                  ? undefined
                  : "linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-elevated) 100%)",
              }}
            >
              {account.header ? (
                <Image
                  src={account.header}
                  alt=""
                  width={1500}
                  height={500}
                  style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, aspectRatio: "1500 / 500", objectFit: "cover", objectPosition: "center" }}
                />
              ) : null}
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
                {isOwnProfile ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ border: "1px solid var(--border)" }}
                    onClick={() => openEdit(account)}
                  >
                    {t.profile_edit}
                  </button>
                ) : token ? (
                  <>
                    <button
                      className={relationship?.following || relationship?.requested ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                      onClick={() => void toggleFollow()}
                      disabled={followBusy || relationship?.blocking}
                    >
                      {followBusy
                        ? "…"
                        : relationship?.following
                        ? t.account_following
                        : relationship?.requested
                        ? t.account_requested
                        : t.account_follow}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)", color: relationship?.blocking ? "var(--danger)" : "var(--text-muted)" }}
                      onClick={() => void toggleBlock()}
                      disabled={blockBusy}
                      title={relationship?.blocking ? t.action_unblock : t.action_block}
                    >
                      {blockBusy ? "…" : (<><Icon name="ban" color={relationship?.blocking ? "var(--danger)" : undefined} />{relationship?.blocking ? ` ${t.status_blocked}` : ""}</>)}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)", color: relationship?.muting ? "var(--danger)" : "var(--text-muted)" }}
                      onClick={() => void toggleMute()}
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
                      title={endorsed ? "Dejar de recomendar" : "Recomendar"}
                    >
                      {endorseBusy ? "…" : <Icon name={endorsed ? "star" : "star-o"} color={endorsed ? "var(--accent)" : undefined} />}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm btn-hide-mobile"
                      style={{ border: "1px solid var(--border)" }}
                      onClick={() => setNoteOpen(true)}
                      title={t.ap_type_note}
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
                            onClick={() => { setProfileMenuOpen(false); void toggleBlock(); }}
                            disabled={blockBusy}
                          >
                            <Icon name="ban" color={relationship?.blocking ? "var(--danger)" : undefined} /> {relationship?.blocking ? t.status_blocked : t.action_block}
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: relationship?.muting ? "var(--danger)" : undefined }}
                            onClick={() => { setProfileMenuOpen(false); void toggleMute(); }}
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
                            <Icon name={endorsed ? "star" : "star-o"} />{endorsed ? ` ${"Dejar de recomendar"}` : ` ${"Recomendar"}`}
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
                            onClick={() => { setProfileMenuOpen(false); setNoteOpen(true); }}
                          >
                            <Icon name="pencil" /> {t.ap_type_note}
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
                ) : (
                  <Link href="/login" className="btn btn-primary btn-sm">{t.account_follow}</Link>
                )}
              </div>
            </div>

            {/* Profile info */}
            <div style={{ padding: "0.75rem 1rem 0" }}>
              <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>
                <DisplayName name={account.display_name || account.username} emojis={account.emojis} />
                {account.verified && (
                  <span title={t.verified_badge} style={{ marginLeft: "0.4rem", verticalAlign: "middle" }}><Icon name="check" color="var(--success)" size="0.9rem" /></span>
                )}
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
                {!isOwnProfile && relationship?.followed_by && (
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
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                @{account.acct}
              </div>

              {account.note && (
                <div
                  style={{ fontSize: "0.9rem", lineHeight: 1.55, marginBottom: "0.75rem", whiteSpace: "pre-line" }}
                >
                  <RichText html={account.note} />
                </div>
              )}

              {/* Profile fields (Mastodon-style key/value pairs) */}
              {account.fields && account.fields.length > 0 && (
                <div style={{ marginBottom: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", display: "grid", gridTemplateColumns: "max-content 1fr" }}>
                  {account.fields.map((f, i) => (
                    <Fragment key={i}>
                      <div style={{ padding: "0.4rem 0.75rem", background: "var(--bg-elevated)", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-secondary)", borderRight: "1px solid var(--border)", borderBottom: i < account.fields.length - 1 ? "1px solid var(--border)" : "none" }}>
                        <DisplayName name={f.name} emojis={account.emojis} />
                      </div>
                      <div
                        style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", wordBreak: "break-all", borderBottom: i < account.fields.length - 1 ? "1px solid var(--border)" : "none" }}
                      >
                        <RichText html={f.value} />
                        {f.verified_at && <span title={t.verified_badge} style={{ color: "var(--success)", marginLeft: "0.25rem" }}><Icon name="check" size="0.75rem" /></span>}
                      </div>
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
                  onClick={() => handleTabChange(tab.key)}
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
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}><Icon name="pencil" size="2rem" /></span>
                  {t.profile_no_posts}
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
                    onQuote={(st) => router.push(`/statuses/${encodeURIComponent(st.id)}?quote=1`)}
                      me={me}
                      onEdit={openStatusEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                  <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {loadingMorePosts ? "Cargando…" : ""}
                  </div>
                </>
              )
            )}

            {activeTab === "replies" && (
              !tabLoaded.replies ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : replies.length === 0 ? (
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}><Icon name="comment" size="2rem" /></span>
                  {t.profile_no_replies}
                </div>
              ) : (
                replies.map((s) => (
                  <StatusCard
                    key={s.id}
                    status={s}
                    onFav={handleStatusUpdate}
                    onReblog={handleStatusUpdate}
                    onReply={(st) => router.push(`/statuses/${encodeURIComponent(st.id)}?reply=1`)}
                    onQuote={(st) => router.push(`/statuses/${encodeURIComponent(st.id)}?quote=1`)}
                    me={me}
                    onEdit={openStatusEdit}
                    onDelete={handleDelete}
                  />
                ))
              )
            )}

            {activeTab === "pinned" && (
              !tabLoaded.pinned ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : pinnedStatuses.length === 0 ? (
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}><Icon name="thumb-tack" size="2rem" /></span>
                  {t.profile_no_pinned}
                </div>
              ) : (
                pinnedStatuses.map((s) => (
                  <StatusCard
                    key={s.id}
                    status={s}
                    onFav={handleStatusUpdate}
                    onReblog={handleStatusUpdate}
                    onReply={(st) => router.push(`/statuses/${encodeURIComponent(st.id)}?reply=1`)}
                    onQuote={(st) => router.push(`/statuses/${encodeURIComponent(st.id)}?quote=1`)}
                    me={me}
                    onEdit={openStatusEdit}
                    onDelete={handleDelete}
                  />
                ))
              )
            )}

            {activeTab === "media" && (
              allAttachments.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_media}</div>
              ) : (
                <ProfileMediaGrid attachments={allAttachments} />
              )
            )}

            {activeTab === "followers" && (
              !tabLoaded.followers ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : followers.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_followers}</div>
              ) : (
                <>
                  {followers.map((f) => <AccountCard key={f.id} acct={f} />)}
                  <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {loadingMoreFollowers ? "Cargando…" : ""}
                  </div>
                </>
              )
            )}

            {activeTab === "following" && (
              !tabLoaded.following ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : following.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_following}</div>
              ) : (
                <>
                  {following.map((f) => <AccountCard key={f.id} acct={f} />)}
                  <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {loadingMoreFollowing ? "Cargando…" : ""}
                  </div>
                </>
              )
            )}

            {activeTab === "collections" && (
              !tabLoaded.collections ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : collections.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}><Icon name="users" size="2rem" /></span>
                  {t.collections_empty}
                </div>
              ) : (
                <>
                  {collections.map((c) => (
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
                  ))}
                </>
              )
            )}
          </>
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

      {/* Edit profile modal */}
      {editOpen && account && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            padding: "1rem",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditOpen(false); }}
        >
          <div
            style={{
              background: "var(--bg-surface)", borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border)", width: "100%", maxWidth: 640,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)",
              }}
            >
              <h2 style={{ fontWeight: 700, fontSize: "1.1rem", margin: 0 }}>{t.profile_edit}</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setEditOpen(false)}
                style={{ fontSize: "1.2rem", padding: "0.25rem 0.5rem" }}
              >
                <Icon name="times" />
              </button>
            </div>

            <form onSubmit={(e) => void handleEditSave(e)} style={{ padding: "1.25rem" }}>
              {/* Header image upload */}
              <div
                onClick={() => headerInputRef.current?.click()}
                style={{
                  width: "100%", maxWidth: "100%",
                  aspectRatio: "3 / 1", minHeight: 120, maxHeight: 220,
                  borderRadius: "var(--radius)",
                  background: headerPreview || account.header
                    ? undefined
                    : "linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-elevated) 100%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  marginBottom: "0.75rem",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {headerPreview || account.header ? (
                  <Image
                    src={headerPreview ?? account.header}
                    alt=""
                    width={1500}
                    height={500}
                    style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, aspectRatio: "1500 / 500", objectFit: "cover", objectPosition: "center" }}
                  />
                ) : null}
                <div
                  style={{
                    background: "rgba(0,0,0,0.55)", borderRadius: "var(--radius-sm)",
                    padding: "0.25rem 0.625rem", fontSize: "0.8rem", color: "#fff",
                  }}
                >
                  <Icon name="camera" color="#fff" /> {t.profile_edit_header}
                </div>
                <input
                  ref={headerInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handleHeaderChange}
                />
              </div>

              {/* Avatar upload */}
              <div className="flex items-center gap-3" style={{ marginBottom: "1.25rem" }}>
                <div
                  onClick={() => avatarInputRef.current?.click()}
                  style={{
                    width: 64, height: 64, borderRadius: "50%",
                    border: "3px solid var(--border)",
                    overflow: "hidden", cursor: "pointer",
                    background: "var(--accent-bg)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    position: "relative",
                  }}
                >
                  {avatarPreview || account.avatar ? (
                    <Image
                      src={avatarPreview ?? account.avatar}
                      alt="avatar"
                      fill
                      sizes="64px"
                      style={{ objectFit: "cover" }}
                    />
                  ) : (
                    <span style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--accent)" }}>
                      {(account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()}
                    </span>
                  )}
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={handleAvatarChange}
                  />
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {t.profile_edit_avatar}<br />
                  <span style={{ fontSize: "0.75rem" }}>JPEG, PNG, GIF, WebP · max 2 MB</span>
                </div>
              </div>

              {/* Display name */}
              <div className="flex flex-col gap-1" style={{ marginBottom: "1rem" }}>
                <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                  {t.profile_display_name}
                </label>
                <div style={{ position: "relative" }}>
                <input
                  type="text"
                  className="input"
                  maxLength={limits.maxDisplayNameChars}
                  ref={displayNameRef}
                  value={editDisplayName}
                  onChange={displayNameAuto.onChange}
                  onKeyDown={displayNameAuto.onKeyDown}
                  placeholder={t.profile_edit_placeholder_name}
                  style={{ width: "30ch", maxWidth: "100%" }}
                />
                <EmojiAutocompleteDropdown
                  suggestions={displayNameAuto.suggestions}
                  activeIndex={displayNameAuto.activeIndex}
                  onSelect={displayNameAuto.select}
                />
              </div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", width: "30ch", maxWidth: "100%", display: "block", textAlign: "left" }}>
                  {editDisplayName.length}/30
                </span>
              </div>

              {/* Bio */}
              <div className="flex flex-col gap-1" style={{ marginBottom: "1.25rem" }}>
                <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                  {t.profile_bio}
                </label>
                <div style={{ position: "relative" }}>
                <textarea
                  className="input"
                  style={{ resize: "none", minHeight: 90, fontFamily: "inherit" }}
                  maxLength={limits.maxStatusChars}
                  value={editNote}
                  onChange={bioAuto.onChange}
                  onKeyDown={bioAuto.onKeyDown}
                  ref={bioTextareaRef}
                  placeholder={t.profile_edit_placeholder_bio}
                />
                <EmojiAutocompleteDropdown
                  suggestions={bioAuto.suggestions}
                  activeIndex={bioAuto.activeIndex}
                  onSelect={bioAuto.select}
                />
              </div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "right" }}>
                  {editNote.length}/{limits.maxNoteChars}
                </span>
              </div>

              {/* Profile fields section */}
              <div style={{ marginBottom: "1.25rem" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                    {t.profile_edit_fields}
                  </label>
                  {editFields.length < limits.maxProfileFields && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={addField} style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}>
                      {t.profile_edit_add_field}
                    </button>
                  )}
                </div>
                {editFields.length === 0 && (
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
                    {t.profile_edit_fields_hint}
                  </p>
                )}
                {editFields.map((f, i) => (
                  <div key={i} className="flex gap-2" style={{ marginBottom: "0.5rem", alignItems: "center" }}>
                    <EmojiInput
                      className="input"
                      containerStyle={{ flex: "0 0 35%" }}
                      style={{ fontSize: "0.85rem" }}
                      placeholder={t.profile_edit_fields_label}
                      maxLength={limits.maxProfileFieldChars}
                      value={f.name}
                      onChange={(v) => updateField(i, "name", v)}
                    />
                    <EmojiInput
                      className="input"
                      containerStyle={{ flex: 1 }}
                      style={{ fontSize: "0.85rem" }}
                      placeholder={t.profile_edit_fields_content}
                      maxLength={limits.maxProfileFieldChars}
                      value={f.value}
                      onChange={(v) => updateField(i, "value", v)}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeField(i)}
                      style={{ padding: "0.2rem 0.5rem", color: "var(--danger)", flexShrink: 0 }}
                    >
                      <Icon name="times" color="var(--danger)" />
                    </button>
                  </div>
                ))}
              </div>

              {editError && (
                <div
                  style={{
                    marginBottom: "1rem",
                    background: "rgba(248,113,113,0.1)",
                    border: "1px solid rgba(248,113,113,0.3)",
                    color: "var(--danger)",
                    borderRadius: "var(--radius)",
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.875rem",
                  }}
                >
                  {editError}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEditOpen(false)}
                  disabled={saving}
                >
                  {t.profile_cancel}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                  {saving ? t.profile_saving : t.profile_save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Note modal */}
      {noteOpen && account && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            padding: "1rem",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setNoteOpen(false); }}
        >
          <div
            style={{
              background: "var(--bg-surface)", borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border)", width: "100%", maxWidth: 400,
              boxShadow: "var(--shadow-lg)", padding: "1.25rem",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: "0.75rem" }}>
              {t.note_about.replace("{username}", `@${account.username}`)}
            </div>
            <textarea
              className="input"
              style={{ width: "100%", minHeight: 80, resize: "none", fontFamily: "inherit", marginBottom: "0.75rem" }}
              placeholder={t.note_placeholder}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              maxLength={limits.maxStatusChars}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNoteOpen(false)}>{t.profile_cancel}</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={noteBusy} onClick={() => void handleSaveNote()}>
                {noteBusy ? "…" : t.profile_save}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit status modal */}
      <EditStatusModal status={editingStatus} onClose={() => setEditingStatus(null)} onSaved={handleStatusUpdate} />
    </>
  );
}
