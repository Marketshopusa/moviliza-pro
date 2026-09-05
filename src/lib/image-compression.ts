/**
 * Utilidad de compresión y redimensionamiento de imágenes en el navegador del cliente.
 * Reduce fotos de cámaras modernas (8-15 MB) a menos de 150 KB manteniendo alta nitidez
 * para lectura de placas, números de parqueo y auditoría vehicular.
 */

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  mimeType?: "image/webp" | "image/jpeg";
}

const DEFAULT_OPTIONS: Required<CompressionOptions> = {
  maxWidth: 1280,
  maxHeight: 1280,
  quality: 0.78,
  mimeType: "image/webp",
};

/**
 * Comprime un archivo File o Blob en el navegador utilizando HTML5 Canvas.
 * Si el navegador no soporta compresión WebP, automáticamente usa JPEG.
 */
export async function compressImage(
  file: File | Blob,
  options: CompressionOptions = {},
): Promise<File> {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // Si no estamos en un entorno con DOM/Canvas (ej. SSR o Node), devolver el archivo original
  if (typeof window === "undefined" || typeof document === "undefined") {
    if (file instanceof File) return file;
    return new File([file], "photo.jpg", { type: file.type || "image/jpeg" });
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => {
      // En caso de falla de lectura, devolver el archivo original
      resolve(
        file instanceof File
          ? file
          : new File([file], "photo.jpg", { type: file.type || "image/jpeg" }),
      );
    };

    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => {
        resolve(
          file instanceof File
            ? file
            : new File([file], "photo.jpg", { type: file.type || "image/jpeg" }),
        );
      };

      img.onload = () => {
        try {
          let { width, height } = img;

          // Calcular nuevas dimensiones manteniendo la relación de aspecto
          if (width > config.maxWidth || height > config.maxHeight) {
            if (width / height > config.maxWidth / config.maxHeight) {
              height = Math.round((height * config.maxWidth) / width);
              width = config.maxWidth;
            } else {
              width = Math.round((width * config.maxHeight) / height);
              height = config.maxHeight;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, width);
          canvas.height = Math.max(1, height);

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(
              file instanceof File
                ? file
                : new File([file], "photo.jpg", { type: file.type || "image/jpeg" }),
            );
            return;
          }

          // Dibujar con suavizado para máxima legibilidad de números y textos
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, width, height);

          // Determinar nombre y extensión
          const originalName = file instanceof File ? file.name : "photo.jpg";
          const baseName = originalName.replace(/\.[^/.]+$/, "");

          // Intentar WebP; si el navegador no lo soporta en toBlob, probar JPEG
          const exportMime = config.mimeType;

          canvas.toBlob(
            (blob) => {
              if (blob) {
                const ext = exportMime === "image/webp" ? "webp" : "jpg";
                const compressedFile = new File([blob], `${baseName}.${ext}`, {
                  type: blob.type || exportMime,
                  lastModified: Date.now(),
                });
                resolve(compressedFile);
              } else {
                // Fallback a JPEG
                canvas.toBlob(
                  (jpegBlob) => {
                    if (jpegBlob) {
                      const compressedFile = new File([jpegBlob], `${baseName}.jpg`, {
                        type: "image/jpeg",
                        lastModified: Date.now(),
                      });
                      resolve(compressedFile);
                    } else {
                      resolve(
                        file instanceof File
                          ? file
                          : new File([file], "photo.jpg", { type: "image/jpeg" }),
                      );
                    }
                  },
                  "image/jpeg",
                  config.quality,
                );
              }
            },
            exportMime,
            config.quality,
          );
        } catch {
          resolve(
            file instanceof File
              ? file
              : new File([file], "photo.jpg", { type: file.type || "image/jpeg" }),
          );
        }
      };

      img.src = event.target?.result as string;
    };

    reader.readAsDataURL(file);
  });
}
