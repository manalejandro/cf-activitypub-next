"use client";

import { useEffect } from "react";
import { applySavedPalette } from "@/lib/palettes";

/**
 * Applies the user's saved palette to the document root and keeps it in sync
 * when the theme (light/dark) changes or the palette is edited in the settings
 * screen (custom event). Mounted once in the root layout.
 */
export function PaletteApplier() {
  useEffect(() => {
    const apply = () => applySavedPalette();

    // Initial application + whenever the theme attribute changes.
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("cf-ap:palette-change", apply);

    return () => {
      observer.disconnect();
      window.removeEventListener("cf-ap:palette-change", apply);
    };
  }, []);

  return null;
}