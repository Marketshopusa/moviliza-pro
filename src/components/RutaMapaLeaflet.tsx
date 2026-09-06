import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Marker, Polyline } from "leaflet";

export type MapPunto = {
  code: string;
  label: string;
  lat: number;
  lng: number;
  line: string;
};

import { RUTAS_FIJAS } from "@/lib/rutas-fijas";

// Caché de coordenadas de rutas por carretera para carga instantánea y cero parpadeo
const ROUTE_CACHE = new Map<string, [number, number][]>();

/**
 * Mapa de navegación interactivo en tiempo real (Leaflet + OpenStreetMap).
 * Corrige el parpadeo separando la ruta física del punto GPS del conductor.
 */
export function RutaMapaLeaflet({
  puntos,
  origen,
  destino,
  yo,
}: {
  puntos: MapPunto[];
  origen: MapPunto | null;
  destino: MapPunto | null;
  yo: { lat: number; lng: number } | null;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const lineRef = useRef<Polyline | null>(null);
  const meRef = useRef<Marker | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const fittedRouteKeyRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [following, setFollowing] = useState(true);

  // Inicializa el mapa una sola vez
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !divRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(divRef.current, {
        zoomControl: true,
        attributionControl: false,
      });

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 20,
      }).addTo(map);

      setReady(true);
      map.setView([28.431, -81.313], 15);
      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 250);

      // Si el usuario arrastra el mapa manualmente, pausamos el seguimiento automático
      map.on("dragstart", () => {
        setFollowing(false);
      });
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
      lineRef.current = null;
      meRef.current = null;
    };
  }, []);

  // Marcadores fijos de los puntos operativos (Base X, Terminales A, B, C)
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;

    for (const p of puntos) {
      let m = markersRef.current.get(p.code);
      const activo = origen?.code === p.code || destino?.code === p.code;
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${activo ? 38 : 28}px;height:${activo ? 38 : 28}px;border-radius:9999px;background:${p.line};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:${p.line === "#facc15" ? "#713f12" : "#fff"};font-weight:800;font-size:${activo ? 15 : 11}px;">${p.code}</div>`,
        iconSize: [activo ? 38 : 28, activo ? 38 : 28],
        iconAnchor: [activo ? 19 : 14, activo ? 19 : 14],
      });

      if (!m) {
        m = L.marker([p.lat, p.lng], { icon }).addTo(map);
        m.bindTooltip(p.label, { direction: "top", offset: [0, -16] });
        markersRef.current.set(p.code, m);
      } else {
        m.setIcon(icon);
      }
    }
  }, [ready, puntos, origen?.code, destino?.code]);

  // Trazo de la ruta física por carretera (OSRM + Caché)
  // IMPORTANTE: NO depende de 'yo' para evitar que parpadee con cada actualización GPS
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !origen || !destino) return;

    let cancelled = false;
    const routeKey = `${origen.code}->${destino.code}`;
    const color = destino.code === "X" ? origen.line : destino.line;

    function renderLine(coords: [number, number][]) {
      if (cancelled || !L || !map) return;
      if (lineRef.current) {
        map.removeLayer(lineRef.current);
      }

      lineRef.current = L.polyline(coords, {
        color,
        weight: 6,
        opacity: 0.85,
        lineJoin: "round",
      }).addTo(map);

      // Ajustar la vista de cámara solo la primera vez que se carga la ruta
      if (fittedRouteKeyRef.current !== routeKey) {
        fittedRouteKeyRef.current = routeKey;
        const bounds = L.latLngBounds(coords);
        map.fitBounds(bounds.pad(0.18));
      }
    }

    // 1. Si existe en rutas fijas pre-calculadas, dibujar instantáneamente (0ms, sin red)
    const fixedCoords = RUTAS_FIJAS[routeKey];
    if (fixedCoords && fixedCoords.length > 0) {
      renderLine(fixedCoords);
      return;
    }

    // 2. Si ya está en memoria caché, dibujar inmediatamente
    const cached = ROUTE_CACHE.get(routeKey);
    if (cached) {
      renderLine(cached);
      return;
    }

    // 3. Fallback dinámico: solicitar ruta detallada por carretera
    void (async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("OSRM error");
        const json = (await res.json()) as {
          routes?: { geometry?: { coordinates?: [number, number][] } }[];
        };
        const coords = json.routes?.[0]?.geometry?.coordinates;
        if (!coords || coords.length < 2) throw new Error("No coords");

        const latLngs = coords.map(([lng, lat]) => [lat, lng] as [number, number]);
        ROUTE_CACHE.set(routeKey, latLngs);
        renderLine(latLngs);
      } catch {
        // En caso de corte de red, trazar la conexión directa temporal
        const fallback: [number, number][] = [
          [origen.lat, origen.lng],
          [destino.lat, destino.lng],
        ];
        renderLine(fallback);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, origen?.code, destino?.code]);

  // Marcador del Conductor (Punto azul / Carro)
  // Se actualiza suavemente sin redibujar la ruta ni hacer saltar el mapa
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;

    if (!yo) {
      if (meRef.current) {
        map.removeLayer(meRef.current);
        meRef.current = null;
      }
      return;
    }

    const icon = L.divIcon({
      className: "",
      html: `<div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;">
        <div style="position:absolute;inset:-4px;border-radius:9999px;background:rgba(37,99,235,0.35);animation:ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>
        <div style="width:28px;height:28px;border-radius:9999px;background:#2563eb;border:3px solid #ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">🚗</div>
      </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    if (!meRef.current) {
      meRef.current = L.marker([yo.lat, yo.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    } else {
      meRef.current.setIcon(icon);
      meRef.current.setLatLng([yo.lat, yo.lng]);
    }

    // Seguir al conductor suavemente si el modo de seguimiento está activo
    if (following) {
      map.panTo([yo.lat, yo.lng], { animate: true, duration: 0.5 });
    }
  }, [ready, yo?.lat, yo?.lng, following]);

  return (
    <div className="relative rounded-xl overflow-hidden border border-border bg-card aspect-video shadow-sm">
      <div ref={divRef} className="w-full h-full" />

      {/* Botón flotante para re-centrar el GPS en el conductor */}
      {yo && (
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
            mapRef.current?.setView([yo.lat, yo.lng], 16, { animate: true });
          }}
          className="absolute bottom-2 right-2 z-[400] bg-background/90 backdrop-blur border border-border text-foreground px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider shadow hover:bg-background flex items-center gap-1"
        >
          <span>🎯</span>
          <span>{following ? "Centrado" : "Centrar en mí"}</span>
        </button>
      )}
    </div>
  );
}
