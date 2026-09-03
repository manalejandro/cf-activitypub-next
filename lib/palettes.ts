/**
 * UI color palettes — presets + custom. A palette is a full set of CSS
 * variable values for both the light and dark theme, applied on top of the
 * built-in `:root` / `:root[data-theme="dark"]` variables. The "default"
 * palette is the instance's built-in theme (no overrides applied).
 *
 * Custom palettes derive every tone from three user picks (accent, light
 * background, dark background) with HSL adjustments so the result is always
 * coherent.
 */

export interface PaletteColors {
  accent: string;
  accentLight: string;
  accentHover: string;
  accentBg: string;
  bg: string;
  bgSurface: string;
  bgElevated: string;
  bgOverlay: string;
  border: string;
  borderHover: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
}

export interface CustomPaletteInput {
  accent: string;
  lightBg: string;
  darkBg: string;
}

export type SavedPalette =
  | { type: "default" }
  | { type: "preset"; id: string }
  | { type: "custom"; custom: CustomPaletteInput };

// ── Color math (hex ↔ HSL) ───────────────────────────────────────────────────

function hexToHsl(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue = 0;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / d + 2) / 6;
  else hue = ((r - g) / d + 4) / 6;
  return [hue * 360, s, l];
}

function hslToHex(hue: number, sat: number, lig: number): string {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.min(1, Math.max(0, sat));
  const l = Math.min(1, Math.max(0, lig));
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue2rgb(h + 1 / 3);
    g = hue2rgb(h);
    b = hue2rgb(h - 1 / 3);
  }
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function adjustLightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.min(1, Math.max(0, l + delta)));
}

function adjustSaturation(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, Math.min(1, Math.max(0, s + delta)), l);
}

function rgba(hex: string, alpha: number): string {
  const [h, s, l] = hexToHsl(hex);
  const [r2, g2, b2] = [h, s, l];
  const rgb = hslToHex(r2, g2, b2).replace("#", "");
  const n = parseInt(rgb, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Palette construction ─────────────────────────────────────────────────────

/** Derive a full palette from the three user-facing color picks. */
export function buildPalette(input: CustomPaletteInput): { light: PaletteColors; dark: PaletteColors } {
  const { accent, lightBg, darkBg } = input;

  const lightHsl = hexToHsl(lightBg);
  const darkHsl = hexToHsl(darkBg);

  return {
    light: {
      accent,
      accentLight: adjustLightness(accent, 0.12),
      accentHover: adjustLightness(accent, -0.1),
      accentBg: rgba(accent, 0.1),
      bg: lightBg,
      bgSurface: adjustLightness(lightBg, 0.03),
      bgElevated: adjustLightness(lightBg, 0.06),
      bgOverlay: adjustLightness(lightBg, 0.09),
      border: adjustLightness(adjustSaturation(lightBg, -0.15), -0.14),
      borderHover: adjustLightness(adjustSaturation(lightBg, -0.1), -0.22),
      textPrimary: hslToHex(lightHsl[0], 0.4, 0.13),
      textSecondary: hslToHex(lightHsl[0], 0.32, 0.3),
      textMuted: hslToHex(lightHsl[0], 0.28, 0.48),
    },
    dark: {
      accent,
      accentLight: adjustLightness(accent, 0.12),
      accentHover: adjustLightness(accent, -0.1),
      accentBg: rgba(accent, 0.14),
      bg: darkBg,
      bgSurface: adjustLightness(darkBg, 0.04),
      bgElevated: adjustLightness(darkBg, 0.08),
      bgOverlay: adjustLightness(darkBg, 0.12),
      border: adjustLightness(darkBg, 0.14),
      borderHover: adjustLightness(darkBg, 0.22),
      textPrimary: hslToHex(darkHsl[0], 0.35, 0.92),
      textSecondary: hslToHex(darkHsl[0], 0.3, 0.76),
      textMuted: hslToHex(darkHsl[0], 0.28, 0.6),
    },
  };
}

export interface Preset {
  id: string;
  name: string;
  accent: string;
  lightBg: string;
  darkBg: string;
}

export const PALETTE_PRESETS: Preset[] = [
  { id: "indigo", name: "Indigo", accent: "#6366f1", lightBg: "#f4f4ff", darkBg: "#0f0f17" },
  { id: "violet", name: "Violet", accent: "#8b5cf6", lightBg: "#f6f4ff", darkBg: "#120f1d" },
  { id: "emerald", name: "Esmeralda", accent: "#10b981", lightBg: "#f2fbf7", darkBg: "#071712" },
  { id: "rose", name: "Rosa", accent: "#f43f5e", lightBg: "#fff4f6", darkBg: "#190a10" },
  { id: "ocean", name: "Océano", accent: "#0ea5e9", lightBg: "#f1f8fd", darkBg: "#071018" },
  { id: "amber", name: "Ámbar", accent: "#f59e0b", lightBg: "#fff9ef", darkBg: "#170f03" },
  { id: "graphite", name: "Grafito", accent: "#94a3b8", lightBg: "#f5f6f8", darkBg: "#0b0d12" },
];

export function getPreset(id: string): Preset | undefined {
  return PALETTE_PRESETS.find((p) => p.id === id);
}

export function presetPalette(preset: Preset): { light: PaletteColors; dark: PaletteColors } {
  return buildPalette({ accent: preset.accent, lightBg: preset.lightBg, darkBg: preset.darkBg });
}

// ── Storage + application ────────────────────────────────────────────────────

const STORAGE_KEY = "cfap:palette";

export function savePalette(palette: SavedPalette): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(palette));
  } catch {
    /* storage unavailable */
  }
}

export function loadPalette(): SavedPalette {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { type: "default" };
    const parsed = JSON.parse(raw) as SavedPalette;
    if (parsed.type === "default") return parsed;
    if (parsed.type === "preset" && getPreset(parsed.id)) return parsed;
    if (parsed.type === "custom" && parsed.custom?.accent && parsed.custom?.lightBg && parsed.custom?.darkBg) return parsed;
    return { type: "default" };
  } catch {
    return { type: "default" };
  }
}

/** Colors for the given theme according to the saved palette, or null for the default instance theme. */
export function savedPaletteColors(theme: "light" | "dark"): PaletteColors | null {
  const saved = loadPalette();
  if (saved.type === "default") return null;
  const palette = saved.type === "preset"
    ? presetPalette(getPreset(saved.id)!)
    : buildPalette(saved.custom);
  return theme === "dark" ? palette.dark : palette.light;
}

const VAR_MAP: Record<keyof PaletteColors, string> = {
  accent: "--accent",
  accentLight: "--accent-light",
  accentHover: "--accent-hover",
  accentBg: "--accent-bg",
  bg: "--bg",
  bgSurface: "--bg-surface",
  bgElevated: "--bg-elevated",
  bgOverlay: "--bg-overlay",
  border: "--border",
  borderHover: "--border-hover",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
};

/** Apply a palette to the document root (overrides the built-in variables). */
export function applyPaletteToRoot(colors: PaletteColors | null): void {
  const root = document.documentElement;
  for (const key of Object.keys(VAR_MAP) as (keyof PaletteColors)[]) {
    root.style.setProperty(VAR_MAP[key], colors ? colors[key] : null);
  }
}

/** Convenience: re-read theme + palette from storage and apply to <html>. */
export function applySavedPalette(): void {
  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyPaletteToRoot(savedPaletteColors(theme));
}