"use client";

import { Icon } from "@/components/Icon";

export interface GeoLocation {
  name: string | null;
  latitude: number;
  longitude: number;
}

const TILE = 256;
const ZOOM = 14;
// A 6x5 mosaic (1536x1280) covers any card width with room to spare; the extra
// row/column also hides the sub-pixel hairline a fractional container height
// used to leave at the bottom edge.
const COLS = 6;
const ROWS = 5;

function tileX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}
function tileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
}

/**
 * Small static OSM map (a tile mosaic with a pin) shown on a geolocated status.
 * No JS map instance: the point is centered with slippy-map math so several
 * statuses stay cheap to render.
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
      href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=${ZOOM}/${location.latitude}/${location.longitude}`}
      target="_blank"
      rel="nofollow noopener noreferrer"
      style={{ display: "block", marginTop: "0.6rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", textDecoration: "none", color: "inherit" }}
    >
      <span style={{ display: "block", position: "relative", width: "100%", aspectRatio: "3 / 2", overflow: "hidden", background: "var(--bg-overlay)" }}>
        <span
          style={{
            position: "absolute",
            left: `calc(50% - ${offsetX}px)`,
            top: `calc(50% - ${offsetY}px)`,
            width,
            height,
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
