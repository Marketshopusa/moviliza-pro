import { useEffect, useRef } from "react";

type Props = {
  lat: number;
  lng: number;
  label: string;
  yo?: { lat: number; lng: number } | null;
};

/**
 * Mapa pequeño con la ubicación guardada del vehículo dentro de Base X
 * y la posición actual del driver.
 */
export function VehicleSpotMap({ lat, lng, label, yo }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const meRef = useRef<import("leaflet").Marker | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !ref.current || mapRef.current) return;
      const map = L.map(ref.current, { attributionControl: false, zoomControl: true }).setView([lat, lng], 18);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 21 }).addTo(map);
      const vehicleIcon = L.divIcon({
        className: "",
        html: `<div style="background:#111827;color:#fff;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;border:3px solid #f59e0b;box-shadow:0 1px 6px rgba(0,0,0,.4)">🚗</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      L.marker([lat, lng], { icon: vehicleIcon }).addTo(map).bindPopup(label);
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [lat, lng, label]);

  useEffect(() => {
    if (!mapRef.current || !yo) return;
    void (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      if (!map) return;
      if (meRef.current) {
        meRef.current.setLatLng([yo.lat, yo.lng]);
      } else {
        const meIcon = L.divIcon({
          className: "",
          html: `<div style="background:#2563eb;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        meRef.current = L.marker([yo.lat, yo.lng], { icon: meIcon }).addTo(map);
        map.fitBounds(L.latLngBounds([lat, lng], [yo.lat, yo.lng]).pad(0.4));
      }
    })();
  }, [yo, lat, lng]);

  return <div ref={ref} className="h-52 w-full rounded-xl overflow-hidden border border-border" />;
}
