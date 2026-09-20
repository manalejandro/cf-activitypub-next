"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

export interface GeoLocation {
  latitude: number;
  longitude: number;
  name: string | null;
}

/**
 * OSM map picker (Leaflet loaded on demand). Lets the user use their current
 * position, click/drag the pin, edit the coordinates or type a place name.
 */
export default function LocationPickerModal({
  initial,
  onSave,
  onClose,
}: {
  initial: GeoLocation | null;
  onSave: (location: GeoLocation | null) => void;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerRef = useRef<import("leaflet").Marker | null>(null);
  const [lat, setLat] = useState(initial?.latitude != null ? String(initial.latitude) : "");
  const [lng, setLng] = useState(initial?.longitude != null ? String(initial.longitude) : "");
  const [name, setName] = useState(initial?.name ?? "");
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setPoint = useCallback((latitude: number, longitude: number) => {
    setLat(latitude.toFixed(6));
    setLng(longitude.toFixed(6));
    const map = mapRef.current;
    const marker = markerRef.current;
    if (map && marker) {
      marker.setLatLng([latitude, longitude]);
      map.panTo([latitude, longitude]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !mapEl.current || mapRef.current) return;
      const center: [number, number] = initial
        ? [initial.latitude, initial.longitude]
        : [20, 0];
      const map = L.map(mapEl.current, { zoomControl: true, attributionControl: true }).setView(center, initial ? 15 : 2);
      L.tileLayer("/api/map/tiles/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      const icon = L.divIcon({
        className: "",
        html: '<div style="width:18px;height:18px;border-radius:50% 50% 50% 0;background:var(--accent);transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 18],
      });
      const marker = L.marker(center, { draggable: true, icon }).addTo(map);
      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        setPoint(pos.lat, pos.lng);
      });
      map.on("click", (e: import("leaflet").LeafletMouseEvent) => setPoint(e.latlng.lat, e.latlng.lng));
      mapRef.current = map;
      markerRef.current = marker;
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [initial, setPoint]);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError(t.location_error_unavailable);
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        mapRef.current?.setView([pos.coords.latitude, pos.coords.longitude], 15);
        setPoint(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        setLocating(false);
        setError(t.location_error_denied);
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  async function reverseGeocode(latitude: number, longitude: number) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&accept-language=${encodeURIComponent(locale)}`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) return;
      const data = (await res.json()) as { display_name?: string };
      if (data.display_name) setName(data.display_name);
    } catch { /* best-effort */ }
  }

  function save() {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      setError(t.location_error_invalid);
      return;
    }
    onSave({ latitude, longitude, name: name.trim() ? name.trim() : null });
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }} onClick={onClose}>
      <div className="card" style={{ width: "100%", maxWidth: 560, padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Icon name="map-marker" />
          <strong style={{ flex: 1 }}>{t.location_title}</strong>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t.cancel}><Icon name="times" /></button>
        </div>

        <div ref={mapEl} style={{ width: "100%", height: 280, borderRadius: "var(--radius)", overflow: "hidden", background: "var(--bg-elevated)" }} />

        <button type="button" className="btn btn-ghost btn-sm" onClick={useMyLocation} disabled={locating} style={{ alignSelf: "flex-start" }}>
          <Icon name="crosshairs" spin={locating} /> {locating ? t.location_locating : t.location_use_my_location}
        </button>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            {t.location_latitude}
            <input className="input" value={lat} onChange={(e) => { setLat(e.target.value); }} style={{ marginTop: "0.25rem" }} />
          </label>
          <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            {t.location_longitude}
            <input className="input" value={lng} onChange={(e) => { setLng(e.target.value); }} style={{ marginTop: "0.25rem" }} />
          </label>
        </div>

        <label style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {t.location_name}
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.location_name_placeholder}
            maxLength={200}
            style={{ marginTop: "0.25rem" }}
          />
        </label>

        {error && <div style={{ color: "var(--danger)", fontSize: "0.82rem" }}>{error}</div>}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void reverseGeocode(Number(lat), Number(lng))}
            disabled={!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))}
          >
            {t.location_fill_name}
          </button>
          {initial && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={() => onSave(null)}>
              {t.location_remove}
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!lat || !lng}>
            {t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
