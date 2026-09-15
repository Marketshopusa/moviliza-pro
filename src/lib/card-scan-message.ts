import type { CardColor } from "@/lib/card-color-detector";

export type CardOcrEngine = "gemini" | "openai" | "tesseract" | "none";

export function terminalFromCardColor(color: CardColor): "A" | "B" | "C" | "X" | null {
  if (color === "amarillo") return "A";
  if (color === "verde") return "B";
  if (color === "azul") return "C";
  // El negro del tag SIXT no se traduce a Base X; eso solo lo confirma Gemini/texto.
  return null;
}

export function parseAiTerminal(raw: unknown): "A" | "B" | "C" | "X" | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase().replace(/[^ABCX]/g, "");
  if (t === "A" || t === "B" || t === "C" || t === "X") return t;
  return null;
}

function terminalPhrase(
  terminal: "A" | "B" | "C" | "X" | null,
  color: CardColor,
): string | null {
  const t = terminal ?? terminalFromCardColor(color);
  if (t === "A" || t === "B" || t === "C") return `Terminal ${t}`;
  if (t === "X") return "Base X";
  return null;
}

export function formatCardScanMessage(input: {
  plate: string | null;
  plateState: string | null;
  model: string | null;
  terminal: "A" | "B" | "C" | "X" | null;
  cardColor: CardColor;
  engine: CardOcrEngine;
}): string {
  const dest = terminalPhrase(input.terminal, input.cardColor);
  const colorNote = input.cardColor
    ? `Color de tarjeta: ${input.cardColor}${dest ? ` → ${dest}` : ""}`
    : null;

  if (input.plate) {
    const vehicle = `${input.plateState ?? ""} ${input.plate}`.trim();
    const bits = [vehicle];
    if (input.model) bits.push(input.model);
    if (colorNote) bits.push(colorNote);
    if (input.engine === "gemini" || input.engine === "openai") {
      return `OCR IA: ${bits.join(" · ")}`;
    }
    if (input.engine === "tesseract") {
      return `OCR local: ${bits.join(" · ")}`;
    }
    return `Placa: ${bits.join(" · ")}`;
  }

  if (colorNote) {
    return `${colorNote}. Ingresa o vuelve a fotografiar la placa (el color no cuenta como lectura de vehículo).`;
  }

  return "No se leyó la placa. Vuelve a fotografiar la llave sobre la tarjeta, de frente o girada.";
}
