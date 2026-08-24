"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Account avatar: renders the image when available, otherwise falls back to
 * the first letter of the display name.
 */
export function Avatar({
  avatar,
  name,
  size = 42,
  radius = "50%",
}: {
  avatar?: string | null;
  name?: string;
  size?: number;
  radius?: string;
}) {
  const [err, setErr] = useState(false);
  const fallback = (name?.[0] ?? "?").toUpperCase();

  if (avatar && !err) {
    return (
      <Image
        src={avatar}
        alt={name ?? ""}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: radius, objectFit: "cover", flexShrink: 0 }}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: radius,
        background: "var(--accent-bg)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.max(size * 0.45, 0.7),
        fontWeight: 700,
        color: "var(--accent)",
      }}
    >
      {fallback}
    </div>
  );
}