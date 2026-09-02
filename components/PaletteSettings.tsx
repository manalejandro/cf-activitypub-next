"use client";

import { useState } from "react";
import { useLocale } from "@/lib/i18n";
import {
  PALETTE_PRESETS,
  buildPalette,
  loadPalette,
  presetPalette,
  savePalette,
  type CustomPaletteInput,
  type SavedPalette,
} from "@/lib/palettes";
import { Icon } from "@/components/Icon";

/**
 * Interface color settings: the instance default, a set of predefined palettes,
 * or a fully custom palette (accent + light/dark backgrounds). Changes apply
 * live and are persisted to localStorage; PaletteApplier re-applies them.
 */
export function PaletteSettings() {
  const { t } = useLocale();
  const [saved, setSaved] = useState<SavedPalette>(() => loadPalette());
  const [custom, setCustom] = useState<CustomPaletteInput>(() => {
    const s = loadPalette();
    return s.type === "custom" ? s.custom : { accent: "#6366f1", lightBg: "#f4f4ff", darkBg: "#0f0f17" };
  });

  const customPalette = buildPalette(custom);

  function apply(p: SavedPalette) {
    setSaved(p);
    savePalette(p);
    window.dispatchEvent(new CustomEvent("cf-ap:palette-change"));
  }

  function updateCustom(patch: Partial<CustomPaletteInput>) {
    const next = { ...custom, ...patch };
    setCustom(next);
    apply({ type: "custom", custom: next });
  }

  return (
    <div>
      <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>
        {t.settings_theme_colors}
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {/* Instance default */}
        <button
          type="button"
          onClick={() => apply({ type: "default" })}
          aria-pressed={saved.type === "default"}
          title={t.settings_theme_default}
          style={{
            width: 56,
            height: 48,
            borderRadius: "var(--radius)",
            border: "2px solid",
            borderColor: saved.type === "default" ? "var(--accent)" : "var(--border)",
            cursor: "pointer",
            background: "linear-gradient(180deg, #f4f4ff 0%, #f4f4ff 50%, #0f0f17 50%, #0f0f17 100%)",
            padding: 0,
            position: "relative",
          }}
        >
          <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", background: "#6366f1", border: "2px solid #fff" }} />
          </span>
        </button>

        {PALETTE_PRESETS.map((p) => {
          const pal = presetPalette(p);
          const isActive = saved.type === "preset" && saved.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => apply({ type: "preset", id: p.id })}
              aria-pressed={isActive}
              title={p.name}
              style={{
                width: 56,
                height: 48,
                borderRadius: "var(--radius)",
                border: "2px solid",
                borderColor: isActive ? "var(--accent)" : "var(--border)",
                cursor: "pointer",
                background: `linear-gradient(180deg, ${pal.light.bg} 0%, ${pal.light.bg} 50%, ${pal.dark.bg} 50%, ${pal.dark.bg} 100%)`,
                padding: 0,
                position: "relative",
              }}
            >
              <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", background: p.accent, border: "2px solid #fff" }} />
              </span>
            </button>
          );
        })}

        {/* Custom */}
        <button
          type="button"
          onClick={() => apply({ type: "custom", custom })}
          aria-pressed={saved.type === "custom"}
          title={t.settings_theme_custom}
          style={{
            width: 56,
            height: 48,
            borderRadius: "var(--radius)",
            border: "2px solid",
            borderColor: saved.type === "custom" ? "var(--accent)" : "var(--border)",
            cursor: "pointer",
            background: `linear-gradient(180deg, ${customPalette.light.bg} 0%, ${customPalette.light.bg} 50%, ${customPalette.dark.bg} 50%, ${customPalette.dark.bg} 100%)`,
            padding: 0,
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="paint-brush" size="1rem" color={saved.type === "custom" ? custom.accent : "var(--text-muted)"} />
        </button>
      </div>

      {saved.type === "custom" && (
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
            <input
              type="color"
              value={custom.accent}
              onChange={(e) => updateCustom({ accent: e.target.value })}
              style={{ width: 40, height: 32, border: "none", background: "none", cursor: "pointer" }}
            />
            {t.settings_theme_accent}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
            <input
              type="color"
              value={custom.lightBg}
              onChange={(e) => updateCustom({ lightBg: e.target.value })}
              style={{ width: 40, height: 32, border: "none", background: "none", cursor: "pointer" }}
            />
            {t.settings_theme_light_bg}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
            <input
              type="color"
              value={custom.darkBg}
              onChange={(e) => updateCustom({ darkBg: e.target.value })}
              style={{ width: 40, height: 32, border: "none", background: "none", cursor: "pointer" }}
            />
            {t.settings_theme_dark_bg}
          </label>
        </div>
      )}
    </div>
  );
}