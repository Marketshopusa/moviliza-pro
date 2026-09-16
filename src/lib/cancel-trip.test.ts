import {
  ACTIVE_DRIVER_TRIP_KEY,
  isActiveTripStatus,
  isCancelledMovement,
  MOVEMENT_STATUS_CANCELADO,
  operationalMovements,
  tripBelongsToActiveShift,
} from "./driver-shift";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("en_ruta is active", isActiveTripStatus("en_ruta"), true);
assertEqual("cancelado is not active", isActiveTripStatus(MOVEMENT_STATUS_CANCELADO), false);
assertEqual("sincronizado is not active", isActiveTripStatus("sincronizado"), false);
assertEqual("cancelado flagged", isCancelledMovement("cancelado"), true);
assertEqual("cancelled alias", isCancelledMovement("cancelled"), true);

const rows = [
  { origin: "X", destination: "C", shift_id: "s2", status: "en_ruta" },
  { origin: "X", destination: "A", shift_id: "s2", status: "cancelado" },
  { origin: "X", destination: "B", shift_id: "s1", status: "en_ruta" },
];
assertEqual("ops exclude cancelled and other shifts", operationalMovements(rows, "s2").length, 1);
assertEqual("old shift isolation", operationalMovements(rows, "s2").some((m) => m.shift_id === "s1"), false);

assertEqual("cache stamp cannot revive other shift", tripBelongsToActiveShift("s2", "s1", "s2"), false);
assertEqual("both ids current", tripBelongsToActiveShift("s2", "s2", "s2"), true);
assertEqual("missing ids never restore", tripBelongsToActiveShift(null, null, "s2"), false);
assertEqual("trip key stable", ACTIVE_DRIVER_TRIP_KEY, "movilizapro_active_driver_trip");

console.log("cancel-trip tests ok");
