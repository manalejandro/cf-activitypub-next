"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Map as LeafletMap, LayerGroup, Marker } from "leaflet";
import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";
import { distanceMeters, locationLabel, type GeoLocation } from "@/lib/location";

type RouteProfile = "driving" | "foot";

interface RouteInfo {
  distance: number;
  duration: number | null;
  straight: boolean;
}

const OSRM_BASE = "https://router.project-osrm.org/route/v1";

/**
 * Full-screen destination map with an optional route from the visitor's
 * current position. Routing uses the public OSRM demo server; when it is
 * unavailable the map falls back to a dashed straight line with the
 * great-circle distance, so the page always works.
 */
export default function LocationMapFull({ location }: { location: GeoLocation }) {
  const { t } = useLocale();
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const routeLayerRef = useRef<LayerGroup | null>(null);
  const userMarkerRef = useRef<Marker | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [locating, setLocating] = useState(false);
  const [profile, setProfile] = useState<RouteProfile>("driving");
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [origin, setOrigin] = useState<GeoLocation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatDistance = (meters: number): string => {
    if (meters < 1000) {
      return t.location_route_m.replace("{value}", String(Math.round(meters)));
    }
    return t.location_route_km.replace("{value}", (meters / 1000).toFixed(meters < 10_000 ? 1 : 0));
  };

  const formatDuration = (seconds: number): string => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return t.location_route_minutes.replace("{value}", String(minutes));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (rest === 0) return t.location_route_hours.replace("{value}", String(hours));
    return `${t.location_route_hours.replace("{value}", String(hours))} ${t.location_route_minutes.replace("{value}", String(rest))}`;
  };

  const drawRoute = useCallback(
    async (origin: GeoLocation, withProfile: RouteProfile) => {
      const map = mapRef.current;
      if (!map) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const { default: L } = await import("leaflet");
      const layer = routeLayerRef.current ?? L.layerGroup().addTo(map);
      routeLayerRef.current = layer;
      layer.clearLayers();
      const accent =
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6366f1";

      const straight = () => {
        const meters = distanceMeters(origin, location);
        layer.addLayer(
          L.polyline(
            [
              [origin.latitude, origin.longitude],
              [location.latitude, location.longitude],
            ],
            { color: accent, weight: 3, dashArray: "6 8", opacity: 0.85 }
          )
        );
        setRoute({ distance: meters, duration: null, straight: true });
      };

      try {
        const url =
          `${OSRM_BASE}/${withProfile === "foot" ? "foot" : "driving"}/` +
          `${origin.longitude},${origin.latitude};${location.longitude},${location.latitude}` +
          `?overview=full&geometries=geojson`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          code?: string;
          routes?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] } }[];
        };
        const best = data.code === "Ok" ? data.routes?.[0] : undefined;
        const coords = best?.geometry?.coordinates;
        if (!best || !coords || coords.length < 2 || typeof best.distance !== "number") {
          straight();
        } else {
          layer.addLayer(
            L.polyline(coords.map(([lng, lat]) => [lat, lng] as [number, number]), {
              color: accent,
              weight: 4,
              opacity: 0.9,
            })
          );
          setRoute({
            distance: best.distance,
            duration: typeof best.duration === "number" ? best.duration : null,
            straight: false,
          });
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        straight();
      }

      const bounds = L.latLngBounds([
        [origin.latitude, origin.longitude],
        [location.latitude, location.longitude],
      ]);
      map.fitBounds(bounds, { padding: [64, 64], maxZoom: 16 });
    },
    [location]
  );

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setError(t.location_error_unavailable);
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setLocating(false);
        const origin: GeoLocation = {
          name: null,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
        setOrigin(origin);
        const map = mapRef.current;
        if (map) {
          const { default: L } = await import("leaflet");
          const icon = L.divIcon({
            className: "",
            html:
              '<div style="width:16px;height:16px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 0 0 6px color-mix(in srgb, var(--accent) 25%, transparent),0 1px 4px rgba(0,0,0,.4)"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          });
          userMarkerRef.current?.remove();
          userMarkerRef.current = L.marker([origin.latitude, origin.longitude], { icon }).addTo(map);
        }
      },
      (err) => {
        setLocating(false);
        setError(err.code === err.PERMISSION_DENIED ? t.location_error_denied : t.location_error_unavailable);
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }, [t]);

  const clearRoute = useCallback(() => {
    abortRef.current?.abort();
    routeLayerRef.current?.clearLayers();
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    setOrigin(null);
    setRoute(null);
    setError(null);
    mapRef.current?.setView([location.latitude, location.longitude], 15);
  }, [location]);

  // Draw the route once the visitor's position is known and redraw it when the
  // travel profile changes.
  useEffect(() => {
    if (origin) void drawRoute(origin, profile);
  }, [origin, profile, drawRoute]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !mapEl.current || mapRef.current) return;
      const center: [number, number] = [location.latitude, location.longitude];
      const map = L.map(mapEl.current, { zoomControl: false, attributionControl: true }).setView(center, 15);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("/api/map/tiles/{z}/{x}/{y}.png", {
        maxZoom: 19,
        noWrap: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      const icon = L.divIcon({
        className: "",
        html:
          '<div style="width:20px;height:20px;border-radius:50% 50% 50% 0;background:var(--accent);transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 20],
      });
      L.marker(center, { icon }).addTo(map);
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      mapRef.current?.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      userMarkerRef.current = null;
    };
  }, [location.latitude, location.longitude]);

  const profileButton = (value: RouteProfile, label: string, icon: string) => (
    <button
      type="button"
      onClick={() => setProfile(value)}
      aria-pressed={profile === value}
      style={{
        display: "inline-flex", alignItems: "center", gap: "0.3rem",
        border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
        background: profile === value ? "var(--accent-bg)" : "var(--bg-surface)",
        color: profile === value ? "var(--accent)" : "var(--text-secondary)",
        padding: "0.3rem 0.55rem", fontSize: "0.78rem", cursor: "pointer",
      }}
    >
      <Icon name={icon} size="0.8rem" color="currentColor" /> {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute", top: "0.75rem", left: "0.75rem", zIndex: 500,
          width: "min(340px, calc(100vw - 1.5rem))",
          background: "color-mix(in srgb, var(--bg-surface) 92%, transparent)",
          backdropFilter: "blur(6px)",
          border: "1px solid var(--border)", borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)", padding: "0.75rem 0.85rem",
          display: "flex", flexDirection: "column", gap: "0.5rem",
        }}
      >
        <span style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>
          OpenStreetMap
        </span>
        <span style={{ fontWeight: 700, fontSize: "1rem", lineHeight: 1.3 }}>{locationLabel(location)}</span>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={locate}
            disabled={locating}
            style={{ fontSize: "0.8rem" }}
          >
            {locating ? <Icon name="hourglass" spin color="#fff" size="0.85rem" /> : <Icon name="location-arrow" color="#fff" size="0.85rem" />}
            {locating ? t.location_locating : t.location_use_my_location}
          </button>
          {origin && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={clearRoute}
              style={{ fontSize: "0.78rem" }}
            >
              <Icon name="times" size="0.8rem" /> {t.location_route_clear}
            </button>
          )}
        </div>

        {origin && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
            {profileButton("driving", t.location_route_driving, "car")}
            {profileButton("foot", t.location_route_walking, "male")}
          </div>
        )}

        {route && (
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: "0.15rem" }}>
            <span>
              {formatDistance(route.distance)}
              {route.duration != null && <> · {formatDuration(route.duration)}</>}
            </span>
            {route.straight && (
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{t.location_route_straight}</span>
            )}
            {!route.straight && (
              <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                <Link
                  href="https://project-osrm.org/"
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  style={{ color: "inherit" }}
                >
                  OSRM
                </Link>
              </span>
            )}
          </div>
        )}

        {error && <span style={{ fontSize: "0.78rem", color: "var(--danger)" }}>{error}</span>}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
          <Link href="/" style={{ color: "var(--accent)" }}>{t.nav_home}</Link>
          <Link
            href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=15/${location.latitude}/${location.longitude}`}
            target="_blank"
            rel="nofollow noopener noreferrer"
            style={{ color: "var(--accent)" }}
          >
            openstreetmap.org
          </Link>
        </div>
      </div>
    </div>
  );
}
