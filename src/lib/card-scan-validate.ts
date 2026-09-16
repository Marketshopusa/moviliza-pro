import type { CardColor } from "@/lib/card-color-detector";
import { terminalFromCardColor } from "@/lib/card-scan-message";
import { isOperationalPlate, normalizePlateToken } from "@/lib/plate-ocr";

export const REJECT_NO_TERMINAL =
  "Foto no válida. Coloca la llave sobre el color del terminal y vuelve a tomar la foto.";

export const REJECT_NO_PLATE =
  "No se leyó la placa. Coloca la llave sobre el color del terminal y vuelve a tomar la foto.";

export type ScanTerminal = "A" | "B" | "C";

export function operationalScanTerminal(
  clientColor: CardColor,
  aiTerminal?: "A" | "B" | "C" | "X" | null,
): ScanTerminal | null {
  const fromColor = terminalFromCardColor(clientColor);
  if (fromColor === "A" || fromColor === "B" || fromColor === "C") return fromColor;
  if (aiTerminal === "A" || aiTerminal === "B" || aiTerminal === "C") {
    // Sin color de canvas A/B/C no se acepta terminal de IA (evita close-up / naranja / negro).
    return null;
  }
  return null;
}

export type CardScanVerdict =
  | {
      ok: true;
      terminal: ScanTerminal;
      plate: string;
      plateState: string | null;
      model: string | null;
    }
  | {
      ok: false;
      reason: "no_terminal" | "no_plate";
      message: string;
      terminal: ScanTerminal | null;
      plate: string | null;
    };

export function evaluateCardScan(input: {
  clientColor: CardColor;
  aiTerminal?: "A" | "B" | "C" | "X" | null;
  plate: string | null;
  plateState: string | null;
  model: string | null;
}): CardScanVerdict {
  const terminal = operationalScanTerminal(input.clientColor, input.aiTerminal);
  const plate = isOperationalPlate(input.plate) ? normalizePlateToken(input.plate) : null;
  const plateState = input.plateState?.trim() ? input.plateState.trim().toUpperCase() : null;
  const model = input.model?.trim() ? input.model.trim() : null;

  if (!terminal) {
    return { ok: false, reason: "no_terminal", message: REJECT_NO_TERMINAL, terminal: null, plate };
  }
  if (!plate) {
    return { ok: false, reason: "no_plate", message: REJECT_NO_PLATE, terminal, plate: null };
  }
  return { ok: true, terminal, plate, plateState, model };
}
