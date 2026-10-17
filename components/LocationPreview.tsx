"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { LOCATION_MAP_ZOOM, locationPath, mapCoverScale, tileX, tileY, type GeoLocation } from "@/lib/location";

const TILE = 256;
const ZOOM = LOCATION_MAP_ZOOM;
// 4x3 tiles (1024x768) cover the card (max ~640px wide) with room to spare for
// the centered point and the rounding shift, with far fewer OSM requests than
// a larger mosaic (the tile proxy caches each tile at the edge).
const COLS = 4;
const ROWS = 3;

/**
 * Small static OSM map (a tile mosaic with a pin) shown on a geolocated status.
 * No JS map instance: the point is centered with slippy-map math so several
 * statuses stay cheap to render.
 *
 * The mosaic links to the same place as the 📍 link in the content: the
 * origin's public map page (`location.url`), or our own path when the status
 * was posted here (or predates the federated URL).
 */
export default function LocationPreview({ location }: { location: GeoLocation }) {
  const x = tileX(location.longitude, ZOOM);
  const y = tileY(location.latitude, ZOOM);
  const centerX = Math.floor(x) - Math.floor(COLS / 2);
  const centerY = Math.floor(y) - Math.floor(ROWS / 2);
  // Rounded: fractional `calc(50% - X.5px)` positions produced hairline
  // seams between tiles and at the container edges.
  const offsetX = Math.round((x - centerX) * TILE);
  const offsetY = Math.round((y - centerY) * TILE);
  const width = COLS * TILE;
  const height = ROWS * TILE;

  // The mosaic is centred on the point, not on its own middle: the visible
  // window is [offsetX - w/2, offsetX + w/2] of it, so a point near the edge of
  // its tile leaves a strip of the card empty (that was the white band on the
  // right). Scale the mosaic around the pin until the nearest edge is out of
  // the card — measuring the *container*, and the distance from the pin to each
  // side, not the mosaic's own size (which is fixed and always "covers" itself).
  const frameRef = useRef<HTMLSpanElement>(null);
  const [cover, setCover] = useState(1);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => {
      setCover(mapCoverScale({
        frameWidth: el.clientWidth,
        frameHeight: el.clientHeight,
        offsetX,
        offsetY,
        mosaicWidth: width,
        mosaicHeight: height,
      }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height, offsetX, offsetY]);

  const max = 2 ** ZOOM;
  const tiles: { key: string; src: string; left: number; top: number }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      // Longitude wraps around the antimeridian; latitude is clamped (poles
      // have no tiles) so the mosaic never requests out-of-range tiles.
      const tx = ((centerX + col) % max + max) % max;
      const ty = Math.min(max - 1, Math.max(0, centerY + row));
      tiles.push({
        key: `${tx}-${ty}-${col}-${row}`,
        src: `/api/map/tiles/${ZOOM}/${tx}/${ty}.png`,
        left: col * TILE,
        top: row * TILE,
      });
    }
  }

  return (
    <a
      href={location.url ?? locationPath(location)}
      target="_blank"
      rel="nofollow noopener noreferrer"
      style={{ display: "block", marginTop: "0.6rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", textDecoration: "none", color: "inherit" }}
    >
      <span ref={frameRef} style={{ display: "block", position: "relative", width: "100%", aspectRatio: "3 / 2", overflow: "hidden", background: "var(--bg-overlay)" }}>
        <span
          style={{
            position: "absolute",
            left: `calc(50% - ${offsetX}px)`,
            top: `calc(50% - ${offsetY}px)`,
            width,
            height,
            transform: cover > 1 ? `scale(${cover})` : undefined,
            transformOrigin: `${offsetX}px ${offsetY}px`,
          }}
        >
          {tiles.map((tile) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={tile.key}
              src={tile.src}
              alt=""
              loading="lazy"
              width={TILE}
              height={TILE}
              style={{ position: "absolute", left: tile.left, top: tile.top, width: TILE, height: TILE, userSelect: "none" }}
            />
          ))}
        </span>
        <span style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -100%)" }}>
          <Icon name="map-marker" size="1.5rem" color="var(--accent)" />
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "0.35rem", padding: "0.4rem 0.6rem", fontSize: "0.8rem", color: "var(--text-secondary)", flexWrap: "nowrap", minWidth: 0 }}>
        <span style={{ display: "inline-flex", flexShrink: 0 }}><Icon name="map-marker" size="0.8rem" /></span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {location.name || `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`}
        </span>
        <span style={{ marginLeft: "auto", flexShrink: 0, whiteSpace: "nowrap", fontSize: "0.68rem", color: "var(--text-muted)" }}>
          © OpenStreetMap contributors
        </span>
      </span>
    </a>
  );
}
