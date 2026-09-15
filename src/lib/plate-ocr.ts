// Browser-only OCR helpers for reading a license plate.
// tesseract.js is heavy, so it is imported lazily only when the driver scans.

const PLATE_RE = /^[A-Z0-9]{5,8}$/;

const STATE_NAMES: Record<string, string> = {
  FLORIDA: "FL",
  GEORGIA: "GA",
  ALABAMA: "AL",
  TEXAS: "TX",
  "NEW YORK": "NY",
  "NEW JERSEY": "NJ",
  CALIFORNIA: "CA",
  "SOUTH CAROLINA": "SC",
  "NORTH CAROLINA": "NC",
  TENNESSEE: "TN",
  VIRGINIA: "VA",
  ARIZONA: "AZ",
  ILLINOIS: "IL",
  OHIO: "OH",
  MICHIGAN: "MI",
  PENNSYLVANIA: "PA",
  MARYLAND: "MD",
  LOUISIANA: "LA",
  MISSISSIPPI: "MS",
  INDIANA: "IN",
};

const ALLOWED_STATE_CODES = new Set(Object.values(STATE_NAMES));

export type PlateRead = { plate: string; state: string | null };

function isPlateToken(token: string): boolean {
  return PLATE_RE.test(token) && /\d/.test(token) && /[A-Z]/.test(token);
}

/**
 * Extrae estado (2 letras) y placa de textos tipo:
 * FL - KR158B / FL–KR158B / FL KR158B / FL-KR158B / KR158B
 */
export function parsePlateText(raw: string): PlateRead {
  const text = raw.toUpperCase();

  let namedState: string | null = null;
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (text.includes(name)) {
      namedState = code;
      break;
    }
  }

  const comboRe = /\b([A-Z]{2})\s*[-–—]?\s*([A-Z0-9]{5,8})\b/g;
  const combos: { state: string; plate: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = comboRe.exec(text)) !== null) {
    const stateCode = match[1];
    const plateToken = match[2];
    if (
      stateCode &&
      plateToken &&
      ALLOWED_STATE_CODES.has(stateCode) &&
      isPlateToken(plateToken)
    ) {
      combos.push({ state: stateCode, plate: plateToken });
    }
  }
  if (combos.length > 0) {
    const best = [...combos].sort((a, b) => b.plate.length - a.plate.length)[0];
    if (best) return { plate: best.plate, state: best.state };
  }

  const stateWords = new Set(Object.keys(STATE_NAMES).flatMap((n) => n.split(" ")));
  const tokens = text
    .replace(/[^A-Z0-9\n ]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => isPlateToken(t) && !stateWords.has(t));
  const plate = tokens.sort((a, b) => b.length - a.length)[0] ?? "";
  return { plate, state: namedState };
}

type MinimalWorker = {
  recognize: (image: unknown) => Promise<{ data: { text?: string } }>;
  terminate: () => Promise<unknown>;
};

export async function createPlateWorker(): Promise<MinimalWorker> {
  const { createWorker } = await import("tesseract.js");
  const worker = (await createWorker("eng")) as unknown as MinimalWorker & {
    setParameters?: (p: Record<string, string>) => Promise<unknown>;
  };
  await worker.setParameters?.({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
    // Modo "texto disperso": ideal para una placa dentro de la guía y mucho más rápido.
    tessedit_pageseg_mode: "11",
    // Sin diccionarios: las placas son alfanuméricas, así se acelera la lectura.
    load_system_dawg: "0",
    load_freq_dawg: "0",
  });
  return worker;
}

export async function readPlateFrom(worker: MinimalWorker, image: unknown): Promise<PlateRead> {
  const { data } = await worker.recognize(image);
  return parsePlateText(data.text ?? "");
}

export async function scanPlateFromImage(file: File): Promise<string> {
  const worker = await createPlateWorker();
  try {
    const read = await readPlateFrom(worker, file);
    return read.plate;
  } finally {
    await worker.terminate();
  }
}
