import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Marker, Polyline } from "leaflet";

export type MapPunto = {
  code: string;
  label: string;
  lat: number;
  lng: number;
  line: string;
};

/**
 * Mapa interactivo real (Leaflet + OpenStreetMap).
 * Todos los puntos operativos quedan fijados a sus coordenadas GPS:
 * al mover el mapa, los marcadores se mueven con él.
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
  const fittedRef = useRef(false);
  const [ready, setReady] = useState(false);

  // Inicializa el mapa una sola vez (solo en el navegador).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !divRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(divRef.current, { zoomControl: true, attributionControl: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 }).addTo(map);
      setReady(true);
      map.setView([28.431, -81.313], 15);
      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 200);
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

  // Marcadores fijos de todos los puntos operativos.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    for (const p of puntos) {
      let m = markersRef.current.get(p.code);
      const activo = origen?.code === p.code || destino?.code === p.code;
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${activo ? 38 : 30}px;height:${activo ? 38 : 30}px;border-radius:9999px;background:${p.line};border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:${p.line === "#facc15" ? "#713f12" : "#fff"};font-weight:800;font-size:${activo ? 15 : 12}px;">${p.code}</div>`,
        iconSize: [activo ? 38 : 30, activo ? 38 : 30],
        iconAnchor: [activo ? 19 : 15, activo ? 19 : 15],
      });
      if (!m) {
        m = L.marker([p.lat, p.lng], { icon }).addTo(map);
        m.bindTooltip(p.label, { direction: "top", offset: [0, -16] });
        markersRef.current.set(p.code, m);
      } else {
        m.setIcon(icon);
      }
    }
  }, [ready, puntos, origen, destino]);

  // Ruta real por calles (OSRM). Si el servicio falla, se dibuja la línea directa.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    let cancelled = false;

    if (lineRef.current) {
      map.removeLayer(lineRef.current);
      lineRef.current = null;
    }
    if (!origen || !destino) return;

    const color = destino.code === "X" ? origen.line : destino.line;
    const recta: [number, number][] = [
      [origen.lat, origen.lng],
      [destino.lat, destino.lng],
    ];

    function dibujar(coords: [number, number][]) {
      if (cancelled || !L || !map) return;
      if (lineRef.current) map.removeLayer(lineRef.current);
      lineRef.current = L.polyline(coords, { color, weight: 6, opacity: 0.9 }).addTo(map);
      const bounds = L.latLngBounds([...coords, ...(yo ? ([[yo.lat, yo.lng]] as [number, number][]) : [])]);
      map.fitBounds(bounds.pad(0.2));
      fittedRef.current = true;
    }

    dibujar(recta);

    void (async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        if (!res.ok) return;
        const json = (await res.json()) as {
          routes?: { geometry?: { coordinates?: [number, number][] } }[];
        };
        const coords = json.routes?.[0]?.geometry?.coordinates;
        if (!coords || coords.length < 2) return;
        dibujar(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
      } catch {
        /* se conserva la línea directa */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, origen, destino, yo]);


  // Punto azul del conductor.
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
      html: '<div style="width:16px;height:16px;border-radius:9999px;background:#0ea5e9;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5);"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    if (!meRef.current) {
      meRef.current = L.marker([yo.lat, yo.lng], { icon }).addTo(map);
      if (!fittedRef.current) {
        map.setView([yo.lat, yo.lng], 16);
        fittedRef.current = true;
      }
    } else {
      meRef.current.setLatLng([yo.lat, yo.lng]);
    }
  }, [ready, yo]);

  return <div ref={divRef} className="rounded-xl overflow-hidden border border-border bg-card h-[380px] w-full z-0" />;
}
