"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Unicode emoji categories ─────────────────────────────────────────────────
const UNICODE_CATEGORIES = [
  { name: "Caritas", emojis: ["😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥸","😏","😒","😞","😔","😟","😕","🙁","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🫡","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤑","🤒","🤕","🤢","🤮","🤧","🥴","🤠","🥳","🤡","👹","👺","💀","👻","👽","🤖","💩"] },
  { name: "Gestos", emojis: ["👋","🤚","🖐","✋","🖖","👌","🤌","✌️","🤞","🤟","🤘","👈","👉","👆","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","🤲","🤝","🙏","💪","🦾","🖕","✍️","💅","🫶","❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☯️","🔥","💯","✨","⭐","🌟","💫","💥","💢","💬","💭","💤"] },
  { name: "Naturaleza", emojis: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐝","🌸","🌺","🌻","🌹","🍀","🌿","🍃","🌲","🌴","🌵","🌾","🍁","🍂","🌍","🌎","🌏","🌙","🌞","⭐","☁️","⛅","🌈","⛄","🌊","🔥"] },
  { name: "Comida", emojis: ["🍕","🍔","🌮","🌯","🥗","🍜","🍣","🍱","🍛","🍲","🥘","🍝","🥞","🧇","🥓","🌭","🍟","🍿","🧆","🥚","🍳","🥐","🥨","🥖","🧀","🥗","🍎","🍊","🍋","🍇","🍓","🍑","🍒","🥭","🍍","🥝","🍦","🍧","🍨","🍩","🍪","🎂","🍰","🧁","☕","🍵","🧃","🥤","🍺","🍻","🥂","🍷"] },
  { name: "Actividades", emojis: ["⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥊","🎯","🎮","🎲","🎨","🖼️","🎭","🎬","🎤","🎧","🎸","🎹","🥁","🎷","🎺","🎻","🎙️","🎚️","📸","📷","🎥","📹","🎞️","📺","📻","🎁","🎀","🎊","🎉","🎈","🏆","🥇","🎖️","🏅","🚴","🧗","🏊","🤸","⛷️","🏄"] },
  { name: "Objetos", emojis: ["📱","💻","🖥️","⌨️","🖱️","📷","📚","📖","📝","✏️","🖊️","🖋️","📌","📍","✂️","🗂️","📁","📂","🗑️","🔑","🔒","🔓","🔔","🔕","🔊","🔇","🔈","📢","💡","🔦","🕯️","🧲","🔧","🔩","⚙️","🔬","🔭","💊","💉","🩺","🩹","🚑","🚒","🚓","🚗","✈️","🚀","⛵","🏠","🏢","🗺️","🌐"] },
];

interface CustomEmoji {
  shortcode: string;
  url: string;
  static_url: string;
  category?: string;
  visible_in_picker?: boolean;
}

interface EmojiPickerProps {
  onInsert: (text: string) => void;
  open: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
  direction?: "up" | "down";
}

export function EmojiPicker({ onInsert, open, onClose, anchorRef, direction = "down" }: EmojiPickerProps) {
  const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>([]);
  const [tab, setTab] = useState<"unicode" | "custom">("unicode");
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/v1/custom_emojis")
      .then((res) => res.ok ? res.json() as Promise<CustomEmoji[]> : [])
      .then((data) => setCustomEmojis(data.filter((e) => e.visible_in_picker !== false)))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        // Check if click originated from the anchor button
        if (anchorRef?.current && anchorRef.current.contains(e.target as Node)) return;
        onClose();
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  // Group custom emoji by category
  const grouped: { name: string; emojis: CustomEmoji[] }[] = [];
  const categoryMap = new Map<string, CustomEmoji[]>();
  for (const e of customEmojis) {
    const cat = e.category ?? "Otros";
    const list = categoryMap.get(cat) ?? [];
    list.push(e);
    categoryMap.set(cat, list);
  }
  for (const [name, emojis] of categoryMap) {
    grouped.push({ name, emojis });
  }
  // Uncategorized last
  const others = grouped.findIndex((g) => g.name === "Otros");
  if (others > 0) {
    const [item] = grouped.splice(others, 1);
    grouped.push(item);
  }

  const style: React.CSSProperties = {
    position: "absolute",
    [direction === "down" ? "top" : "bottom"]: "calc(100% + 6px)",
    left: 0,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "0.5rem",
    zIndex: 200,
    width: 340,
    maxHeight: 300,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 4px 24px rgba(0,0,0,0.22)",
  };

  return (
    <div ref={pickerRef} style={style}>
      {/* Tabs */}
      {customEmojis.length > 0 && (
        <div style={{ display: "flex", gap: "0.25rem", marginBottom: "0.4rem", borderBottom: "1px solid var(--border)", paddingBottom: "0.35rem" }}>
          <button
            type="button"
            onClick={() => setTab("unicode")}
            style={{
              flex: 1, padding: "0.25rem", fontSize: "0.78rem", fontWeight: tab === "unicode" ? 600 : 400,
              background: tab === "unicode" ? "var(--accent-bg)" : "transparent",
              color: tab === "unicode" ? "var(--accent)" : "var(--text-muted)",
              border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer",
            }}
          >
            Unicode
          </button>
          <button
            type="button"
            onClick={() => setTab("custom")}
            style={{
              flex: 1, padding: "0.25rem", fontSize: "0.78rem", fontWeight: tab === "custom" ? 600 : 400,
              background: tab === "custom" ? "var(--accent-bg)" : "transparent",
              color: tab === "custom" ? "var(--accent)" : "var(--text-muted)",
              border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer",
            }}
          >
            Personalizados ({customEmojis.length})
          </button>
        </div>
      )}

      {/* Emoji grid */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {tab === "unicode" ? (
          UNICODE_CATEGORIES.map((cat) => (
            <div key={cat.name}>
              <div style={{ fontSize: "0.65rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginTop: "0.4rem", marginBottom: "0.2rem", padding: "0 0.15rem" }}>
                {cat.name}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.05rem" }}>
                {cat.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => { onInsert(emoji); onClose(); }}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: "1.25rem", lineHeight: 1, padding: "0.2rem 0.25rem",
                      borderRadius: "var(--radius-sm)",
                    }}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : (
          grouped.length > 0 ? (
            grouped.map((cat) => (
              <div key={cat.name}>
                <div style={{ fontSize: "0.65rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginTop: "0.4rem", marginBottom: "0.2rem", padding: "0 0.15rem" }}>
                  {cat.name}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.15rem" }}>
                  {cat.emojis.map((emoji) => (
                    <button
                      key={emoji.shortcode}
                      type="button"
                      onClick={() => { onInsert(`:${emoji.shortcode}:`); onClose(); }}
                      style={{
                        background: "none", border: "none", cursor: "pointer",
                        lineHeight: 1, padding: "0.2rem",
                        borderRadius: "var(--radius-sm)",
                      }}
                      title={`:${emoji.shortcode}:`}
                    >
                      <img
                        src={emoji.url}
                        alt={`:${emoji.shortcode}:`}
                        width={22}
                        height={22}
                        style={{ verticalAlign: "middle" }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div style={{ padding: "1rem", textAlign: "center", fontSize: "0.82rem", color: "var(--text-muted)" }}>
              No hay emojis personalizados
            </div>
          )
        )}
      </div>
    </div>
  );
}
