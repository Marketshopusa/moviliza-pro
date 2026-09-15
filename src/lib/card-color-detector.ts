/**
 * Detector de color del lado del cliente mediante análisis de lienzo Canvas y espacio HSV.
 * Identifica con rapidez los colores de tarjeta/llavero característicos de las operaciones
 * (Amarillo -> Terminal A, Verde -> Terminal B, Azul -> Terminal C, Negro -> Base X).
 */

export type CardColor = "amarillo" | "verde" | "azul" | "negro" | null;

export async function detectCardColor(imageSource: string | File): Promise<CardColor> {
  if (typeof window === "undefined") return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    let objectUrlToRevoke: string | null = null;

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        // Muestra de 80x80 para procesar en menos de 5ms
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
        let black = 0;
        let validPixels = 0;
        const margin = Math.floor(size * 0.25);

        for (let i = 0; i < imgData.length; i += 4) {
          const pixelIndex = i / 4;
          const x = pixelIndex % size;
          const y = Math.floor(pixelIndex / size);
          const inCenter = x >= margin && x < size - margin && y >= margin && y < size - margin;

          const r = (imgData[i] ?? 0) / 255;
          const g = (imgData[i + 1] ?? 0) / 255;
          const b = (imgData[i + 2] ?? 0) / 255;

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const delta = max - min;
          const v = max; // Value (brillo)
          const s = max === 0 ? 0 : delta / max; // Saturación

          // Omitir píxeles casi blancos / reflejos de flash intensos
          if (v > 0.94 && s < 0.12) continue;

          let h = 0; // Hue (matiz en grados 0-360)
          if (delta > 0) {
            if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
            else if (max === g) h = ((b - r) / delta + 2) * 60;
            else h = ((r - g) / delta + 4) * 60;
          }

          validPixels++;

          // El tag SIXT negro suele ocupar el centro: no lo cuentes como Base X.
          const isBlack = v < 0.2 || (s < 0.15 && v < 0.28);
          if (isBlack) {
            if (!inCenter) black++;
          } else if (s > 0.22 && v > 0.28) {
            if (h >= 36 && h <= 68) yellow++;
            else if (h >= 75 && h <= 165) green++;
            else if (h >= 185 && h <= 260) blue++;
          }
        }

        if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);

        if (validPixels < 50) return resolve(null);

        const candidates: { color: NonNullable<CardColor>; count: number }[] = [
          { color: "amarillo", count: yellow },
          { color: "verde", count: green },
          { color: "azul", count: blue },
          { color: "negro", count: black },
        ];

        candidates.sort((a, b) => b.count - a.count);
        const top = candidates[0];
        const chromatic = candidates.find((c) => c.color !== "negro");

        // Si hay tarjeta de color visible en márgenes, no dejes que el negro residual gane.
        if (
          top?.color === "negro" &&
          chromatic &&
          chromatic.count / validPixels >= 0.1 &&
          chromatic.count > 20
        ) {
          resolve(chromatic.color);
          return;
        }

        // Se requiere un mínimo del 12% de píxeles dominantes de la imagen
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
