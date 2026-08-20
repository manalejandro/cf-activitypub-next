"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import {
  findEmojiQuery,
  getEmojiSuggestions,
  replaceEmojiQuery,
  type CustomEmoji,
  type EmojiSuggestion,
} from "@/lib/emoji-autocomplete";

const MAX_SUGGESTIONS = 8;

/**
 * Wire `:name` emoji autocomplete into a status composer textarea.
 * Returns the handlers to attach to the `<textarea>` plus the dropdown state.
 */
export function useEmojiAutocomplete(
  text: string,
  setText: (s: string) => void,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
) {
  const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>([]);
  const [suggestions, setSuggestions] = useState<EmojiSuggestion[]>([]);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const lastCursor = useRef(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/v1/custom_emojis")
      .then((res) => (res.ok ? res.json() as Promise<CustomEmoji[]> : []))
      .then((data) => { if (alive) setCustomEmojis(data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const close = useCallback(() => {
    setRange(null);
    setSuggestions([]);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    const query = findEmojiQuery(text, lastCursor.current);
    if (!query) {
      close();
      return;
    }
    setRange({ start: query.start, end: query.end });
    setSuggestions(getEmojiSuggestions(query.query, customEmojis, MAX_SUGGESTIONS));
    setActiveIndex(0);
  }, [text, customEmojis, close]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    lastCursor.current = e.target.selectionStart ?? e.target.value.length;
    setText(e.target.value);
  }, [setText]);

  const select = useCallback((index: number) => {
    if (!range) return;
    const suggestion = suggestions[index];
    if (!suggestion) return;
    const next = replaceEmojiQuery(text, range, suggestion.insert);
    lastCursor.current = range.start + suggestion.insert.length;
    setText(next);
    close();
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(lastCursor.current, lastCursor.current);
      }
    });
  }, [text, range, suggestions, setText, close, textareaRef]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!range || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((a) => (a - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      select(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }, [range, suggestions, activeIndex, select, close]);

  return {
    suggestions,
    open: range !== null && suggestions.length > 0,
    activeIndex,
    onChange,
    onKeyDown,
    select,
  };
}

interface EmojiAutocompleteDropdownProps {
  suggestions: EmojiSuggestion[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function EmojiAutocompleteDropdown({ suggestions, activeIndex, onSelect }: EmojiAutocompleteDropdownProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Emoji suggestions"
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
          key={s.type === "custom" ? `c:${s.shortcode}` : `u:${s.char}`}
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
          {s.type === "custom" ? (
            <Image src={s.url ?? ""} alt={`:${s.shortcode}:`} width={20} height={20} style={{ flexShrink: 0 }} />
          ) : (
            <span style={{ flexShrink: 0, fontSize: "1.1rem", lineHeight: 1 }}>{s.char}</span>
          )}
          <span style={{ color: "var(--text-secondary)" }}>:{s.name}:</span>
        </button>
      ))}
    </div>
  );
}