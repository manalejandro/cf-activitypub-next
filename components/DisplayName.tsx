"use client";

import { memo } from "react";
import { renderEmojiInHtml, type EmojiData } from "@/lib/emoji";
import { useAllCustomEmojis } from "@/lib/custom-emoji-client";
import { RichText } from "@/components/RichText";

/**
 * Renders an account display name inline, replacing any :shortcode: custom
 * emoji with their <img>. Resolves shortcodes against the account's `emojis`
 * list merged with the full cached emoji list, so names render even when an
 * API response omits the `emojis` array.
 */
export function DisplayName({ name, emojis }: { name?: string | null; emojis?: EmojiData[] }) {
  const all = useAllCustomEmojis();
  if (!name) return null;

  const map = new Map<string, EmojiData>();
  for (const e of all) map.set(e.shortcode, e);
  for (const e of emojis ?? []) map.set(e.shortcode, e);
  const list = [...map.values()];

  if (list.length === 0) return <>{name}</>;
  return <RichText html={renderEmojiInHtml(name, list)} />;
}

export const MemoDisplayName = memo(DisplayName);