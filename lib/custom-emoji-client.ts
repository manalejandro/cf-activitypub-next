"use client";

import { useEffect, useState } from "react";
import type { EmojiData } from "@/lib/emoji";

let cachedPromise: Promise<EmojiData[]> | null = null;

/**
 * Fetch the full custom-emoji list (local + federated) once per client
 * session. Used by DisplayName so account names render emojis even when an
 * API response omits the `emojis` array.
 */
export function fetchAllCustomEmojis(): Promise<EmojiData[]> {
  if (!cachedPromise) {
    cachedPromise = fetch("/api/v1/custom_emojis")
      .then((res) => (res.ok ? res.json() as Promise<EmojiData[]> : []))
      .catch(() => []);
  }
  return cachedPromise;
}

export function useAllCustomEmojis(): EmojiData[] {
  const [emojis, setEmojis] = useState<EmojiData[]>([]);
  useEffect(() => {
    let alive = true;
    fetchAllCustomEmojis().then((data) => {
      if (alive) setEmojis(data);
    });
    return () => { alive = false; };
  }, []);
  return emojis;
}