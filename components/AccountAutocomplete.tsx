"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { findMentionQuery, replaceMentionQuery, type AccountSuggestion } from "@/lib/account-autocomplete";
import { Avatar } from "@/components/Avatar";
import { DisplayName } from "@/components/DisplayName";
import { useLocale } from "@/lib/i18n";

const MAX_SUGGESTIONS = 6;
const FETCH_DEBOUNCE_MS = 250;

/**
 * Wire `@mention` account autocomplete into a textarea or single-line input.
 * Triggers after `@` followed by two or more characters (Mastodon behaviour)
 * and fetches suggestions from /api/v1/accounts/search with a debounce.
 */
export function useAccountAutocomplete(
  text: string,
  setText: (s: string) => void,
  fieldRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
) {
  const [suggestions, setSuggestions] = useState<AccountSuggestion[]>([]);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const lastCursor = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  const close = useCallback(() => {
    setRange(null);
    setSuggestions([]);
    setLoading(false);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    const query = findMentionQuery(text, lastCursor.current);
    if (!query) {
      close();
      return;
    }
    setRange({ start: query.start, end: query.end });
    const seq = ++requestSeq.current;
    setLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetch(`/api/v1/accounts/search?q=${encodeURIComponent(query.query)}&limit=${MAX_SUGGESTIONS}`)
        .then((res) => (res.ok ? res.json() as Promise<AccountSuggestion[]> : []))
        .then((data) => {
          if (seq !== requestSeq.current) return;
          setSuggestions(data.slice(0, MAX_SUGGESTIONS));
          setLoading(false);
          setActiveIndex(0);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setSuggestions([]);
          setLoading(false);
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text, close]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    lastCursor.current = e.target.selectionStart ?? e.target.value.length;
    setText(e.target.value);
  }, [setText]);

  const select = useCallback((index: number) => {
    if (!range) return;
    const suggestion = suggestions[index];
    if (!suggestion) return;
    const insert = `@${suggestion.acct} `;
    const next = replaceMentionQuery(text, range, insert);
    lastCursor.current = range.start + insert.length;
    setText(next);
    close();
    requestAnimationFrame(() => {
      const el = fieldRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(lastCursor.current, lastCursor.current);
      }
    });
  }, [text, range, suggestions, setText, close, fieldRef]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (!range || (suggestions.length === 0 && !loading)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((a) => (a + 1) % Math.max(suggestions.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((a) => (a - 1 + Math.max(suggestions.length, 1)) % Math.max(suggestions.length, 1));
    } else if ((e.key === "Enter" || e.key === "Tab") && suggestions.length > 0) {
      e.preventDefault();
      select(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }, [range, suggestions, loading, activeIndex, select, close]);

  return {
    suggestions,
    open: range !== null && (suggestions.length > 0 || loading),
    loading,
    activeIndex,
    onChange,
    onKeyDown,
    select,
  };
}

interface AccountAutocompleteDropdownProps {
  suggestions: AccountSuggestion[];
  activeIndex: number;
  onSelect: (index: number) => void;
  loading: boolean;
}

export function AccountAutocompleteDropdown({ suggestions, activeIndex, onSelect, loading }: AccountAutocompleteDropdownProps) {
  const { t } = useLocale();
  if (suggestions.length === 0 && !loading) return null;

  return (
    <div
      role="listbox"
      aria-label={t.a11y_account_suggestions}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.22)",
        zIndex: 200,
        maxHeight: 260,
        overflowY: "auto",
        padding: "0.25rem",
      }}
    >
      {suggestions.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => { e.preventDefault(); onSelect(i); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            width: "100%",
            textAlign: "left",
            background: i === activeIndex ? "var(--accent-bg)" : "transparent",
            border: "none",
            borderRadius: "var(--radius-sm)",
            padding: "0.3rem 0.5rem",
            cursor: "pointer",
            fontSize: "0.88rem",
            color: "var(--text)",
          }}
        >
          <Avatar avatar={s.avatar} name={s.display_name || s.username} size={24} />
          <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <DisplayName name={s.display_name || s.username} emojis={s.emojis} />
          </span>
          <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>@{s.acct}</span>
        </button>
      ))}
      {loading && suggestions.length === 0 && (
        <div style={{ padding: "0.4rem 0.5rem", fontSize: "0.85rem", color: "var(--text-muted)" }}>{t.loading}</div>
      )}
    </div>
  );
}