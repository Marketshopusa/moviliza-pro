import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Beacon de ubicación del conductor.
 * Se activa en el teléfono donde el conductor inicia sesión y envía la posición
 * al servidor. El conductor NUNCA puede leer ubicaciones (RLS): solo supervisores
 * y administradores las consultan desde el panel.
 */
export function useLocationBeacon(userId: string | null | undefined, enabled: boolean) {
  const lastSent = useRef(0);

  useEffect(() => {
    if (!userId || !enabled) return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;

    let active = true;

    async function push(pos: GeolocationPosition, force = false) {
      const now = Date.now();
      if (!force && now - lastSent.current < 45_000) return;
      lastSent.current = now;
      if (!active || !userId) return;
      await supabase.from("driver_locations").upsert(
        {
          user_id: userId,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          is_on_shift: true,
          recorded_at: new Date(pos.timestamp).toISOString(),
        },
        { onConflict: "user_id" },
      );
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => void push(pos, true),
      () => {},
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );

    const watchId = navigator.geolocation.watchPosition((pos) => void push(pos), () => {}, {
      enableHighAccuracy: true,
      maximumAge: 30_000,
    });

    // Al cerrar la pestaña o la app el driver deja de ser rastreado.
    const onHide = () => {
      if (document.visibilityState === "hidden" && userId) void markOffShift(userId).catch(() => {});
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);

    return () => {
      active = false;
      navigator.geolocation.clearWatch(watchId);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [userId, enabled]);

}

/** Marca la ubicación como fuera de turno (al cerrar sesión / terminar turno). */
export async function markOffShift(userId: string) {
  await supabase.from("driver_locations").update({ is_on_shift: false }).eq("user_id", userId);
}

export function freshnessLabel(recordedAt: string): { label: string; fresh: boolean } {
  const mins = Math.round((Date.now() - new Date(recordedAt).getTime()) / 60000);
  if (mins <= 3) return { label: "En vivo", fresh: true };
  if (mins < 60) return { label: `Última posición · hace ${mins} min`, fresh: false };
  const hrs = Math.round(mins / 60);
  return { label: `Última posición · hace ${hrs} h`, fresh: false };
}
