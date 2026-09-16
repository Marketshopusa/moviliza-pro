import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { markOffShift } from "@/lib/geo";
import {
  ACTIVE_DRIVER_TRIP_KEY,
  CLOSE_BLOCKED_ACTIVE_TRIP,
  canCloseShift,
  decideStartShift,
  pickActiveShift,
  type DriverShift,
} from "@/lib/driver-shift";

type DriverShiftContextValue = {
  shift: DriverShift | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<DriverShift | null>;
  startShift: () => Promise<boolean>;
  endShift: () => Promise<boolean>;
};

const DriverShiftContext = createContext<DriverShiftContextValue | null>(null);

async function loadOpenShifts(driverId: string): Promise<{ shifts: DriverShift[]; error: string | null }> {
  const { data, error } = await supabase
    .from("shifts")
    .select("id, started_at, ended_at")
    .eq("driver_id", driverId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(5);

  if (error) return { shifts: [], error: error.message };
  return { shifts: (data as DriverShift[]) ?? [], error: null };
}

async function hasOpenTrip(driverId: string, _shiftId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("movements")
    .select("id")
    .eq("driver_id", driverId)
    .eq("status", "en_ruta")
    .limit(1);

  if (error) throw new Error(error.message);
  if ((data?.length ?? 0) > 0) return true;

  try {
    const raw = localStorage.getItem(ACTIVE_DRIVER_TRIP_KEY);
    if (!raw) return false;
    const trip = JSON.parse(raw) as { movementId?: string };
    if (!trip.movementId) return false;
    const { data: live } = await supabase
      .from("movements")
      .select("id, status")
      .eq("id", trip.movementId)
      .eq("driver_id", driverId)
      .maybeSingle();
    return live?.status === "en_ruta";
  } catch {
    return false;
  }
}

function clearStaleTripCache() {
  try {
    localStorage.removeItem(ACTIVE_DRIVER_TRIP_KEY);
  } catch {
    // ignore
  }
}

export function DriverShiftProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [shift, setShift] = useState<DriverShift | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setShift(null);
      setLoading(false);
      return null;
    }
    const { shifts, error: loadError } = await loadOpenShifts(user.id);
    if (loadError) {
      setError(loadError);
      setShift(null);
      setLoading(false);
      return null;
    }
    const current = pickActiveShift(shifts);
    setShift(current);
    setLoading(false);
    return current;
  }, [user]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const startShift = useCallback(async () => {
    if (!user || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { shifts, error: loadError } = await loadOpenShifts(user.id);
      if (loadError) {
        setError(loadError);
        return false;
      }
      const existing = pickActiveShift(shifts);
      if (decideStartShift(existing) === "use_existing" && existing) {
        setShift(existing);
        return true;
      }

      const { data, error: insertError } = await supabase
        .from("shifts")
        .insert({ driver_id: user.id })
        .select("id, started_at, ended_at")
        .single();

      if (insertError || !data?.id) {
        const again = pickActiveShift((await loadOpenShifts(user.id)).shifts);
        if (again) {
          setShift(again);
          return true;
        }
        setError(insertError?.message ?? "No se pudo iniciar el turno.");
        setShift(null);
        return false;
      }

      const created = data as DriverShift;
      const confirmed = pickActiveShift((await loadOpenShifts(user.id)).shifts);
      if (!confirmed || confirmed.id !== created.id) {
        setError("El turno no quedó confirmado. Intenta de nuevo.");
        setShift(confirmed);
        return !!confirmed;
      }
      setShift(confirmed);
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [user]);

  const endShift = useCallback(async () => {
    if (!user || !shift || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const current = pickActiveShift((await loadOpenShifts(user.id)).shifts);
      if (!current || current.id !== shift.id) {
        setError("No se encontró el turno activo.");
        setShift(current);
        return false;
      }

      const activeTrip = await hasOpenTrip(user.id, current.id);
      const closeCheck = canCloseShift(activeTrip);
      if (!closeCheck.ok) {
        setError(CLOSE_BLOCKED_ACTIVE_TRIP);
        return false;
      }

      const endedAt = new Date().toISOString();
      const { data, error: closeError } = await supabase
        .from("shifts")
        .update({ ended_at: endedAt })
        .eq("id", current.id)
        .eq("driver_id", user.id)
        .is("ended_at", null)
        .select("id, ended_at")
        .maybeSingle();

      if (closeError || !data?.ended_at) {
        setError(closeError?.message ?? "No se pudo cerrar el turno.");
        return false;
      }

      await markOffShift(user.id).catch(() => {});
      clearStaleTripCache();
      setShift(null);
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [user, shift]);

  return (
    <DriverShiftContext.Provider
      value={{ shift, loading, busy, error, refresh, startShift, endShift }}
    >
      {children}
    </DriverShiftContext.Provider>
  );
}

export function useDriverShift() {
  const ctx = useContext(DriverShiftContext);
  if (!ctx) {
    throw new Error("useDriverShift must be used within DriverShiftProvider");
  }
  return ctx;
}
