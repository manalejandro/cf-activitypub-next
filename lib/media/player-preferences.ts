"use client";

/**
 * Shared audio state of every media player on the page.
 *
 * Each player used to own its `muted`/`volume` state, so muting a timeline
 * video and opening the enlarged viewer (a second `<video>`) brought the sound
 * back. This tiny store keeps every player in sync and remembers the choice
 * across reloads, like Mastodon's player volume preference.
 */

export interface MediaPreference {
  muted: boolean;
  volume: number;
}

const MUTED_KEY = "cf-ap:media-muted";
const VOLUME_KEY = "cf-ap:media-volume";

const SERVER_SNAPSHOT: MediaPreference = { muted: false, volume: 1 };

let snapshot: MediaPreference | null = null;
const listeners = new Set<() => void>();

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): MediaPreference {
  const storage = store();
  if (!storage) return SERVER_SNAPSHOT;
  const storedVolume = storage.getItem(VOLUME_KEY);
  const volume = storedVolume === null ? Number.NaN : Number(storedVolume);
  return {
    muted: storage.getItem(MUTED_KEY) === "1",
    volume: Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : 1,
  };
}

/** Current preference (reads localStorage once). */
export function mediaPreference(): MediaPreference {
  if (!snapshot) snapshot = load();
  return snapshot;
}

/** Snapshot used while rendering on the server (never touches localStorage). */
export function mediaPreferenceServerSnapshot(): MediaPreference {
  return SERVER_SNAPSHOT;
}

/** Update the preference everywhere (players re-render through the store). */
export function setMediaPreference(next: Partial<MediaPreference>): void {
  const current = mediaPreference();
  const merged: MediaPreference = {
    muted: next.muted ?? current.muted,
    volume: next.volume !== undefined ? Math.min(1, Math.max(0, next.volume)) : current.volume,
  };
  if (merged.muted === current.muted && merged.volume === current.volume) return;
  snapshot = merged;
  const storage = store();
  if (storage) {
    try {
      storage.setItem(MUTED_KEY, merged.muted ? "1" : "0");
      storage.setItem(VOLUME_KEY, String(merged.volume));
    } catch {
      /* private mode / quota — the in-memory preference still works */
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeMediaPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget the cached preference (localStorage is untouched). */
export function resetMediaPreferenceCache(): void {
  snapshot = null;
}
