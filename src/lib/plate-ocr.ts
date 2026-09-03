// Browser-only OCR helper for reading a license plate from a photo.
// tesseract.js is heavy, so it is imported lazily only when the driver scans.

const PLATE_RE = /^[A-Z0-9]{5,8}$/;

function pickPlate(text: string): string {
  const tokens = text
    .toUpperCase()
    .replace(/[^A-Z0-9\n ]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => PLATE_RE.test(t) && /\d/.test(t) && /[A-Z]/.test(t));
  if (tokens.length === 0) return "";
  // Prefer the longest candidate (plates are usually the longest alphanumeric run).
  return tokens.sort((a, b) => b.length - a.length)[0] ?? "";
}

export async function scanPlateFromImage(file: File): Promise<string> {
  const { default: Tesseract } = await import("tesseract.js");
  const { data } = await Tesseract.recognize(file, "eng", {
    // @ts-expect-error tessedit options are accepted at runtime
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  });
  return pickPlate(data.text ?? "");
}
