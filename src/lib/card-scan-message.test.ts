import {
  formatCardScanMessage,
  parseAiTerminal,
  terminalFromCardColor,
} from "./card-scan-message";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("naranja !OCR X", terminalFromCardColor("naranja"), null);
assertEqual("amarillo A", terminalFromCardColor("amarillo"), "A");
assertEqual("verde B", terminalFromCardColor("verde"), "B");
assertEqual("azul C", terminalFromCardColor("azul"), "C");
assertEqual("negro !X", terminalFromCardColor("negro"), null);
assertEqual("negro !A", terminalFromCardColor("negro"), null);
assertEqual("negro !B", terminalFromCardColor("negro") === "B", false);
assertEqual("negro !C", terminalFromCardColor("negro") === "C", false);
assertEqual("parse C", parseAiTerminal("C"), "C");
assertEqual("parse X", parseAiTerminal("X"), "X");
assertEqual("parse junk", parseAiTerminal("term"), null);

const colorOnly = formatCardScanMessage({
  plate: null,
  plateState: null,
  model: null,
  terminal: "C",
  cardColor: "azul",
  engine: "none",
});
if (!colorOnly.includes("Color de tarjeta") || colorOnly.includes("OCR IA")) {
  throw new Error(`color-only must not claim IA: ${colorOnly}`);
}

const orangeMsg = formatCardScanMessage({
  plate: null,
  plateState: null,
  model: null,
  terminal: null,
  cardColor: "naranja",
  engine: "none",
});
if (orangeMsg.includes("Base X") || orangeMsg.includes("Terminal")) {
  throw new Error(`naranja must not produce OCR location: ${orangeMsg}`);
}

const blackMsg = formatCardScanMessage({
  plate: "KR158B",
  plateState: "FL",
  model: null,
  terminal: null,
  cardColor: "negro",
  engine: "gemini",
});
if (blackMsg.includes("Base X")) {
  throw new Error(`negro must not produce Base X: ${blackMsg}`);
}

const ia = formatCardScanMessage({
  plate: "KR158B",
  plateState: "FL",
  model: "BMW SERIES 2",
  terminal: "C",
  cardColor: "azul",
  engine: "gemini",
});
if (!ia.startsWith("OCR IA:") || !ia.includes("KR158B")) {
  throw new Error(`IA message: ${ia}`);
}

const local = formatCardScanMessage({
  plate: "KR158B",
  plateState: "FL",
  model: null,
  terminal: null,
  cardColor: "verde",
  engine: "tesseract",
});
if (!local.startsWith("OCR local:")) {
  throw new Error(`local message: ${local}`);
}

console.log("card-scan-message tests ok");
