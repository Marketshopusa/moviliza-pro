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

export type PlateRead = { plate: string; state: string | null };

export function parsePlateText(raw: string): PlateRead {
  const text = raw.toUpperCase();
  let state: string | null = null;
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (text.includes(name)) {
      state = code;
      break;
    }
  }
  const stateWords = new Set(Object.keys(STATE_NAMES).flatMap((n) => n.split(" ")));
  const tokens = text
    .replace(/[^A-Z0-9\n ]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        PLATE_RE.test(t) &&
        /\d/.test(t) &&
        /[A-Z]/.test(t) &&
        !stateWords.has(t),
    );
  const plate = tokens.sort((a, b) => b.length - a.length)[0] ?? "";
  return { plate, state };
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
