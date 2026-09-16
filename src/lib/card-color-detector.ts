/**
 * Detector de color del lado del cliente (Canvas + HSV).
 *
 * Colores operativos del ESCÁNER (foto):
 *   amarillo -> Terminal A
 *   verde    -> Terminal B
 *   azul     -> Terminal C
 *
 * Base X es naranja solo en mapa/GPS/UI. No se detecta por foto.
 * El negro (tag SIXT, bordes, sombras) NO es un punto operativo.
 * `naranja` permanece en el tipo como valor interno no operativo.
 */

export type CardColor = "naranja" | "amarillo" | "verde" | "azul" | "negro" | null;

/** Identidad visual canónica de Base X (Tailwind orange-500). No usar en OCR. */
export const BASE_X_ORANGE_HEX = "#f97316";
export const BASE_X_ORANGE_BG = "bg-orange-500";
export const BASE_X_ORANGE_TEXT = "text-white";
export const BASE_X_ORANGE_RING = "ring-orange-300";

/**
 * Rangos HSV no solapados (hue 0–360).
 * Amarillo A: 36–68. Verde B / azul C sin cambio.
 */
export const HSV_YELLOW = { hMin: 36, hMax: 68, sMin: 0.22, vMin: 0.28 } as const;
export const HSV_GREEN = { hMin: 75, hMax: 165, sMin: 0.22, vMin: 0.28 } as const;
export const HSV_BLUE = { hMin: 185, hMax: 260, sMin: 0.22, vMin: 0.28 } as const;

export function rgbToHsv(r255: number, g255: number, b255: number): { h: number; s: number; v: number } {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max;
  const s = max === 0 ? 0 : delta / max;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / delta + 2) * 60;
    else h = ((r - g) / delta + 4) * 60;
  }
  return { h, s, v };
}

/** Clasifica un píxel. `negro` es diagnóstico interno; no es ubicación. Naranja no es color de escáner. */
export function classifyCardPixel(h: number, s: number, v: number): Exclude<CardColor, null> | null {
  if (v < 0.2 || (s < 0.15 && v < 0.28)) return "negro";
  if (s > HSV_YELLOW.sMin && v > HSV_YELLOW.vMin) {
    if (h >= HSV_YELLOW.hMin && h <= HSV_YELLOW.hMax) return "amarillo";
    if (h >= HSV_GREEN.hMin && h <= HSV_GREEN.hMax) return "verde";
    if (h >= HSV_BLUE.hMin && h <= HSV_BLUE.hMax) return "azul";
  }
  return null;
}

export async function detectCardColor(imageSource: string | File): Promise<CardColor> {
  if (typeof window === "undefined") return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    let objectUrlToRevoke: string | null = null;

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const size = 80;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
          return resolve(null);
        }

        ctx.drawImage(img, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size).data;

        let yellow = 0;
        let green = 0;
        let blue = 0;
        let validPixels = 0;

        for (let i = 0; i < imgData.length; i += 4) {
          const r = imgData[i] ?? 0;
          const g = imgData[i + 1] ?? 0;
          const b = imgData[i + 2] ?? 0;
          const { h, s, v } = rgbToHsv(r, g, b);

          if (v > 0.94 && s < 0.12) continue;
          validPixels++;

          const cls = classifyCardPixel(h, s, v);
          if (cls === "amarillo") yellow++;
          else if (cls === "verde") green++;
          else if (cls === "azul") blue++;
          // naranja, negro y residuales no votan ubicación
        }

        if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);

        if (validPixels < 50) return resolve(null);

        const candidates: { color: "amarillo" | "verde" | "azul"; count: number }[] = [
          { color: "amarillo", count: yellow },
          { color: "verde", count: green },
          { color: "azul", count: blue },
        ];

        candidates.sort((a, b) => b.count - a.count);
        const top = candidates[0];

        if (top && top.count / validPixels >= 0.12 && top.count > 25) {
          resolve(top.color);
        } else {
          resolve(null);
        }
      } catch {
        if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
        resolve(null);
      }
    };

    img.onerror = () => {
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      resolve(null);
    };

    if (typeof imageSource === "string") {
      img.src = imageSource;
    } else {
      objectUrlToRevoke = URL.createObjectURL(imageSource);
      img.src = objectUrlToRevoke;
    }
  });
}
