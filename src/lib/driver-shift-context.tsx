import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { markOffShift } from "@/lib/geo";
import {
  ACTIVE_DRIVER_TRIP_KEY,
  CLOSE_BLOCKED_ACTIVE_TRIP,
  DUPLICATE_OPEN_SHIFTS,
  canCloseShift,
  decideStartShift,
  inspectOpenShifts,
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

function shiftLog(message: string, extra?: Record<string, unknown>) {
  if (extra) {
    console.info(`[shift] ${message}`, extra);
    return;
  }
  console.info(`[shift] ${message}`);
}

async function loadOpenShifts(driverId: string): Promise<{ shifts: DriverShift[]; error: string | null }> {
  const { data, error } = await supabase
    .from("shifts")
    .select("id, started_at, ended_at")
    .eq("driver_id", driverId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) return { shifts: [], error: error.message };
  return { shifts: (data as DriverShift[]) ?? [], error: null };
}

async function hasOpenTrip(driverId: string): Promise<{ active: boolean; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from("movements")
      .select("id")
      .eq("driver_id", driverId)
      .eq("status", "en_ruta")
      .limit(1);

    if (error) return { active: false, error: error.message };
    if ((data?.length ?? 0) > 0) return { active: true, error: null };

    const raw = localStorage.getItem(ACTIVE_DRIVER_TRIP_KEY);
    if (!raw) return { active: false, error: null };
    const trip = JSON.parse(raw) as { movementId?: string };
    if (!trip.movementId) return { active: false, error: null };
    const { data: live } = await supabase
      .from("movements")
      .select("id, status")
      .eq("id", trip.movementId)
      .eq("driver_id", driverId)
      .maybeSingle();
    return { active: live?.status === "en_ruta", error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return { active: false, error: message };
  }
}

function clearStaleTripCache() {
  try {
    localStorage.removeItem(ACTIVE_DRIVER_TRIP_KEY);
  } catch {
    // ignore
  }
}

/** Cierra solo filas todavía abiertas. No toca shifts que ya tienen ended_at. */
async function closeOpenShifts(
  driverId: string,
  endedAt: string,
  exceptId?: string,
): Promise<{ closedIds: string[]; error: string | null }> {
  let query = supabase
    .from("shifts")
    .update({ ended_at: endedAt })
    .eq("driver_id", driverId)
    .is("ended_at", null);
  if (exceptId) query = query.neq("id", exceptId);
  const { data, error } = await query.select("id, ended_at");
  if (error) return { closedIds: [], error: error.message };
  return { closedIds: ((data ?? []) as { id: string }[]).map((row) => row.id), error: null };
}

async function closeShiftById(
  driverId: string,
  shiftId: string,
  endedAt: string,
): Promise<{ closed: boolean; error: string | null; endedAt: string | null }> {
  const { data, error } = await supabase
    .from("shifts")
    .update({ ended_at: endedAt })
    .eq("id", shiftId)
    .eq("driver_id", driverId)
    .is("ended_at", null)
    .select("id, ended_at")
    .maybeSingle();

  if (error) return { closed: false, error: error.message, endedAt: null };
  if (!data?.ended_at) {
    return {
      closed: false,
      error: "Supabase no confirmó ended_at (0 filas). Revisa permisos/RLS o el id del turno.",
      endedAt: null,
    };
  }
  return { closed: true, error: null, endedAt: data.ended_at };
}

export function DriverShiftProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [shift, setShift] = useState<DriverShift | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (authLoading) {
      setLoading(true);
      return null;
    }
    if (!user) {
      setShift(null);
      setLoading(false);
      return null;
    }
    const { shifts, error: loadError } = await loadOpenShifts(user.id);
    if (loadError) {
      shiftLog("load open shifts failed", { error: loadError });
      setError(loadError);
      setShift(null);
      setLoading(false);
      return null;
    }
    const { current, extras } = inspectOpenShifts(shifts);
    shiftLog("loaded open shifts", {
      count: shifts.length,
      activeId: current?.id ?? null,
      startedAt: current?.started_at ?? null,
      endedAt: current?.ended_at ?? null,
      extraIds: extras.map((s) => s.id),
    });
    if (current && extras.length > 0) {
      const { error: extraError } = await closeOpenShifts(user.id, new Date().toISOString(), current.id);
      if (extraError) {
        setError(`Turnos duplicados abiertos. Cierra el turno para regularizarlos: ${extraError}`);
        setShift(current);
        setLoading(false);
        return current;
      }
      setError(DUPLICATE_OPEN_SHIFTS);
    }
    setShift(current);
    setLoading(false);
    return current;
  }, [user, authLoading]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const startShift = useCallback(async () => {
    if (authLoading || !user || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { shifts, error: loadError } = await loadOpenShifts(user.id);
      if (loadError) {
        setError(loadError);
        return false;
      }
      const inspected = inspectOpenShifts(shifts);
      if (inspected.current && inspected.extras.length > 0) {
        const { error: extraError } = await closeOpenShifts(
          user.id,
          new Date().toISOString(),
          inspected.current.id,
        );
        if (extraError) {
          setError(`Turnos duplicados abiertos. Cierra el turno para regularizarlos: ${extraError}`);
          setShift(inspected.current);
          return true;
        }
        setError(DUPLICATE_OPEN_SHIFTS);
        setShift(inspected.current);
        return true;
      }
      if (decideStartShift(inspected.current) === "use_existing" && inspected.current) {
        setShift(inspected.current);
        return true;
      }

      const { data, error: insertError } = await supabase
        .from("shifts")
        .insert({ driver_id: user.id })
        .select("id, started_at, ended_at")
        .single();

      if (insertError || !data?.id) {
        const again = inspectOpenShifts((await loadOpenShifts(user.id)).shifts);
        if (again.current) {
          if (again.extras.length > 0) {
            await closeOpenShifts(user.id, new Date().toISOString(), again.current.id);
          }
          setShift(again.current);
          return true;
        }
        setError(insertError?.message ?? "No se pudo iniciar el turno.");
        setShift(null);
        return false;
      }

      const created = data as DriverShift;
      const confirmed = inspectOpenShifts((await loadOpenShifts(user.id)).shifts);
      if (confirmed.extras.length > 0 && confirmed.current) {
        await closeOpenShifts(user.id, new Date().toISOString(), confirmed.current.id);
      }
      if (!confirmed.current || confirmed.current.id !== created.id) {
        setError("El turno no quedó confirmado. Intenta de nuevo.");
        setShift(confirmed.current);
        return !!confirmed.current;
      }
      shiftLog("started", { id: confirmed.current.id, startedAt: confirmed.current.started_at });
      setShift(confirmed.current);
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [user, authLoading]);

  const endShift = useCallback(async () => {
    shiftLog("close requested", { activeId: shift?.id ?? null, startedAt: shift?.started_at ?? null });
    if (authLoading || !user || !shift || busyRef.current) {
      shiftLog("close aborted", {
        authLoading,
        hasUser: !!user,
        hasShift: !!shift,
        busy: busyRef.current,
      });
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const loaded = await loadOpenShifts(user.id);
      if (loaded.error) {
        shiftLog("close load failed", { error: loaded.error });
        setError(loaded.error);
        return false;
      }
      const inspected = inspectOpenShifts(loaded.shifts);
      const target = inspected.current?.id === shift.id ? inspected.current : inspected.current ?? shift;
      shiftLog("active shift id", { requested: shift.id, loaded: inspected.current?.id ?? null });

      const trip = await hasOpenTrip(user.id);
      if (trip.error) {
        shiftLog("close trip check failed", { error: trip.error });
        setError(trip.error);
        return false;
      }
      const closeCheck = canCloseShift(trip.active);
      if (!closeCheck.ok) {
        shiftLog("close blocked active trip", { shiftId: target.id });
        setError(CLOSE_BLOCKED_ACTIVE_TRIP);
        return false;
      }

      const endedAt = new Date().toISOString();
      const byId = await closeShiftById(user.id, target.id, endedAt);
      shiftLog("close update result", {
        shiftId: target.id,
        closed: byId.closed,
        endedAt: byId.endedAt,
        error: byId.error,
      });
      if (!byId.closed) {
        setError(byId.error ?? "No se pudo cerrar el turno.");
        return false;
      }

      if (inspected.extras.length > 0) {
        const extras = await closeOpenShifts(user.id, endedAt, target.id);
        if (extras.error) {
          shiftLog("close extras failed", { error: extras.error });
        }
      }

      const leftover = inspectOpenShifts((await loadOpenShifts(user.id)).shifts);
      shiftLog("remaining open shifts", {
        count: leftover.current ? leftover.extras.length + 1 : leftover.extras.length,
        leftoverId: leftover.current?.id ?? null,
      });
      if (leftover.current) {
        setError("El turno no quedó cerrado por completo. Intenta de nuevo.");
        setShift(leftover.current);
        return false;
      }

      await markOffShift(user.id).catch(() => {});
      clearStaleTripCache();
      setShift(null);
      shiftLog("state after close", { shift: null, signedOut: false });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo cerrar el turno.";
      shiftLog("close exception", { error: message });
      setError(message);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [user, shift, authLoading]);

  return (
    <DriverShiftContext.Provider
      value={{ shift, loading: authLoading || loading, busy, error, refresh, startShift, endShift }}
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
