export type DriverShift = {
  id: string;
  started_at: string;
  ended_at: string | null;
};

export type ShiftMovement = {
  origin: string;
  destination: string;
  shift_id: string | null;
  status?: string;
};

export const ACTIVE_DRIVER_TRIP_KEY = "movilizapro_active_driver_trip";

export const CLOSE_BLOCKED_ACTIVE_TRIP =
  "Tienes un viaje activo. Finalízalo antes de cerrar el turno.";

export function isOperationAllowed(shift: DriverShift | null | undefined): boolean {
  return !!shift?.id && !shift.ended_at;
}

export function decideStartShift(existing: DriverShift | null): "use_existing" | "insert" {
  return existing && !existing.ended_at ? "use_existing" : "insert";
}

export function canCloseShift(hasActiveTrip: boolean): { ok: true } | { ok: false; reason: "active_trip" } {
  if (hasActiveTrip) return { ok: false, reason: "active_trip" };
  return { ok: true };
}

export function operationalMovements<T extends { shift_id: string | null }>(
  rows: T[],
  shiftId: string,
): T[] {
  return rows.filter((row) => row.shift_id === shiftId);
}

export function countShiftMovements(rows: ShiftMovement[], shiftId: string) {
  const current = operationalMovements(rows, shiftId);
  return {
    total: current.length,
    toBase: current.filter((m) => m.destination === "X").length,
    fromBase: current.filter((m) => m.origin === "X").length,
  };
}

export function canInsertDriverMovement(shiftId: string | null | undefined): boolean {
  return typeof shiftId === "string" && shiftId.length > 0;
}

export function tripBelongsToActiveShift(
  storedShiftId: string | null | undefined,
  movementShiftId: string | null | undefined,
  activeShiftId: string,
): boolean {
  if (storedShiftId) return storedShiftId === activeShiftId;
  if (movementShiftId) return movementShiftId === activeShiftId;
  return false;
}

export function isActiveTripStatus(status: string | null | undefined): boolean {
  return status === "en_ruta";
}

export const DUPLICATE_OPEN_SHIFTS =
  "Había más de un turno abierto (estado inconsistente). Solo permanece el más reciente; los duplicados abiertos se cerraron. Los turnos ya finalizados no se modificaron.";

export function inspectOpenShifts(rows: DriverShift[]): {
  current: DriverShift | null;
  extras: DriverShift[];
} {
  const open = rows
    .filter((s) => !s.ended_at)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return { current: open[0] ?? null, extras: open.slice(1) };
}

export function pickActiveShift(rows: DriverShift[]): DriverShift | null {
  return inspectOpenShifts(rows).current;
}

export type ShiftGate = "loading" | "off" | "on";

/** Nunca tratar loading como En turno. */
export function resolveShiftGate(
  authLoading: boolean,
  shiftLoading: boolean,
  shift: DriverShift | null | undefined,
): ShiftGate {
  if (authLoading || shiftLoading) return "loading";
  if (shift?.id && !shift.ended_at) return "on";
  return "off";
}
