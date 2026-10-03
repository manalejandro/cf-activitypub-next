"use client";

import { Icon } from "./Icon";
import { licenseVisual } from "@/lib/license-client";

/**
 * Draws a license the way FEP-6757 expects: the instance's icon image when it
 * has one, the Fork Awesome badge keys the admin set, the official badges of a
 * known license URI, and otherwise the letters of its id (a custom license from
 * another instance).
 */
export function LicenseBadge({
  license,
  size = "0.85rem",
  fixedWidth = false,
}: {
  license: { icon?: string | null; badgeKeys?: string | null; badges?: string | null; url: string };
  size?: string;
  fixedWidth?: boolean;
}) {
  const visual = licenseVisual(license);
  if (visual.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={visual.src}
        alt=""
        style={{ height: size, width: "auto", verticalAlign: "middle", display: "inline-block" }}
      />
    );
  }
  if (visual.kind === "icons") {
    return (
      <>
        {visual.names.map((name) => (
          <Icon key={name} name={name} size={size} fixedWidth={fixedWidth} />
        ))}
      </>
    );
  }
  return (
    <span style={{ fontSize: `calc(${size} * 0.72)`, fontWeight: 700, letterSpacing: "0.02em", verticalAlign: "middle" }}>
      {visual.label}
    </span>
  );
}
