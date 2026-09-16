import { evaluateCardScan, operationalScanTerminal, REJECT_NO_PLATE, REJECT_NO_TERMINAL } from "./card-scan-validate";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("amarillo A", operationalScanTerminal("amarillo"), "A");
assertEqual("verde B", operationalScanTerminal("verde"), "B");
assertEqual("azul C", operationalScanTerminal("azul"), "C");
assertEqual("negro invalid", operationalScanTerminal("negro"), null);
assertEqual("naranja invalid", operationalScanTerminal("naranja"), null);
assertEqual("null invalid", operationalScanTerminal(null), null);
assertEqual("AI C without canvas still invalid", operationalScanTerminal(null, "C"), null);

const yellowOk = evaluateCardScan({
  clientColor: "amarillo",
  plate: "KR158B",
  plateState: "FL",
  model: "BMW SERIES 2",
});
assertEqual("yellow+plate ok", yellowOk.ok, true);
if (yellowOk.ok) {
  assertEqual("yellow terminal A", yellowOk.terminal, "A");
  assertEqual("yellow plate", yellowOk.plate, "KR158B");
  assertEqual("yellow state", yellowOk.plateState, "FL");
  assertEqual("yellow model", yellowOk.model, "BMW SERIES 2");
}

const greenOk = evaluateCardScan({
  clientColor: "verde",
  plate: "BZ691Z",
  plateState: "FL",
  model: "BMW X7",
});
assertEqual("green+plate ok", greenOk.ok, true);
if (greenOk.ok) assertEqual("green terminal B", greenOk.terminal, "B");

const blueOk = evaluateCardScan({
  clientColor: "azul",
  plate: "KR158B",
  plateState: "FL",
  model: "BMW SERIES 2",
});
assertEqual("blue+plate ok", blueOk.ok, true);
if (blueOk.ok) assertEqual("blue terminal C", blueOk.terminal, "C");

const noColor = evaluateCardScan({
  clientColor: null,
  aiTerminal: "C",
  plate: "KR158B",
  plateState: "FL",
  model: "BMW SERIES 2",
});
assertEqual("no ABC invalid", noColor.ok, false);
if (!noColor.ok) {
  assertEqual("no ABC reason", noColor.reason, "no_terminal");
  assertEqual("no ABC msg", noColor.message, REJECT_NO_TERMINAL);
}

const black = evaluateCardScan({ clientColor: "negro", plate: "KR158B", plateState: "FL", model: null });
assertEqual("negro invalid", black.ok, false);

const orange = evaluateCardScan({ clientColor: "naranja", plate: "KR158B", plateState: "FL", model: null });
assertEqual("naranja invalid", orange.ok, false);

const noPlate = evaluateCardScan({
  clientColor: "azul",
  plate: null,
  plateState: "FL",
  model: "BMW SERIES 2",
});
assertEqual("ABC without plate not success", noPlate.ok, false);
if (!noPlate.ok) {
  assertEqual("no plate reason", noPlate.reason, "no_plate");
  assertEqual("no plate msg", noPlate.message, REJECT_NO_PLATE);
  assertEqual("no plate does not drop terminal internally", noPlate.terminal, "C");
}

const invalidPhotoDoesNotAccept = evaluateCardScan({
  clientColor: null,
  plate: "KR158B",
  plateState: "FL",
  model: "BMW SERIES 2",
});
assertEqual("invalid scan not ok so photo not accepted", invalidPhotoDoesNotAccept.ok, false);

console.log("card-scan-validate tests ok");
