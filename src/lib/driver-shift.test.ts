import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalFromCardColor } from "./card-scan-message";
import {
  canCloseShift,
  canInsertDriverMovement,
  countShiftMovements,
  decideStartShift,
  isOperationAllowed,
  operationalMovements,
  pickActiveShift,
  tripBelongsToActiveShift,
} from "./driver-shift";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const shift = { id: "s1", started_at: "2026-09-14T22:00:00.000Z", ended_at: null };

assertEqual("active shift allows ops", isOperationAllowed(shift), true);
assertEqual("no shift blocks ops", isOperationAllowed(null), false);
assertEqual("ended shift blocks ops", isOperationAllowed({ ...shift, ended_at: "2026-09-15T06:30:00.000Z" }), false);

assertEqual("start with none inserts", decideStartShift(null), "insert");
assertEqual("start with active reuses", decideStartShift(shift), "use_existing");

assertEqual("close ok without trip", canCloseShift(false).ok, true);
assertEqual("close blocked with trip", canCloseShift(true).ok, false);

assertEqual("insert requires shift_id", canInsertDriverMovement(shift.id), true);
assertEqual("insert empty blocked", canInsertDriverMovement(null), false);
assertEqual("insert blank blocked", canInsertDriverMovement(""), false);

const rows = [
  { origin: "X", destination: "A", shift_id: "s1", occurred_at: "2026-09-14T23:00:00.000Z" },
  { origin: "A", destination: "X", shift_id: "s1", occurred_at: "2026-09-15T02:10:00.000Z" },
  { origin: "X", destination: "B", shift_id: "s0", occurred_at: "2026-09-15T02:15:00.000Z" },
  { origin: "C", destination: "X", shift_id: null, occurred_at: "2026-09-15T02:20:00.000Z" },
];

assertEqual("ops list only current shift", operationalMovements(rows, "s1").length, 2);
assertEqual("other shift excluded", operationalMovements(rows, "s1").some((m) => m.shift_id === "s0"), false);

const counts = countShiftMovements(rows, "s1");
assertEqual("counter total by shift not date", counts.total, 2);
assertEqual("counter from base includes after midnight", counts.fromBase, 1);
assertEqual("counter to base includes after midnight", counts.toBase, 1);

assertEqual("trip matches stored shift", tripBelongsToActiveShift("s1", "s0", "s1"), true);
assertEqual("stale trip rejected", tripBelongsToActiveShift("s0", "s0", "s1"), false);
assertEqual("movement shift used if no stored", tripBelongsToActiveShift(null, "s1", "s1"), true);

const picked = pickActiveShift([
  { id: "old", started_at: "2026-09-14T18:00:00.000Z", ended_at: "2026-09-14T20:00:00.000Z" },
  { id: "open", started_at: "2026-09-14T22:00:00.000Z", ended_at: null },
]);
assertEqual("pick open not closed", picked?.id, "open");

assertEqual("ocr naranja still not X", terminalFromCardColor("naranja"), null);
assertEqual("ocr amarillo A", terminalFromCardColor("amarillo"), "A");
assertEqual("ocr verde B", terminalFromCardColor("verde"), "B");
assertEqual("ocr azul C", terminalFromCardColor("azul"), "C");
assertEqual("ocr negro none", terminalFromCardColor("negro"), null);

const dir = dirname(fileURLToPath(import.meta.url));
const shiftPanel = readFileSync(join(dir, "../components/ShiftPanel.tsx"), "utf8");
if (shiftPanel.includes("signOut")) {
  throw new Error("ShiftPanel must not sign out on close");
}
const shiftCtx = readFileSync(join(dir, "./driver-shift-context.tsx"), "utf8");
if (shiftCtx.includes("signOut")) {
  throw new Error("driver-shift-context must not sign out on close");
}

console.log("driver-shift tests ok");
