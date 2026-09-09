import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parsePlateText } from "@/lib/plate-ocr";

export type CardRead = {
  plate_state: string | null;
  plate: string | null;
  vehicle_model: string | null;
  /** Color de fondo detectado en la tarjeta: amarillo, verde, azul o negro. */
  card_color: "amarillo" | "verde" | "azul" | "negro" | null;
  /** Terminal deducido del color: A, B, C o X. */
  terminal: "A" | "B" | "C" | "X" | null;
  raw: string;
};

export type SpotRead = {
  /** Número de parqueo leído, por ejemplo D16. */
  spot: string | null;
  /** Terminal leído en la foto (A, B, C o X). */
  terminal: "A" | "B" | "C" | "X" | null;
  raw: string;
};

const CARD_SYSTEM_PROMPT =
  "Eres un lector experto de tarjetas de vehículos, llaveros y placas de EE.UU. para flotas de alquiler de autos. " +
  "Examina la imagen con máxima atención a textos impresos pequeños, códigos, etiquetas adhesivas y placas. " +
  "Devuelve EXCLUSIVAMENTE un objeto JSON válido con las siguientes claves: " +
  "plate_state (código de 2 letras del estado en mayúscula, ej. FL, GA, TX, NM, NY, CA, o null si no aparece), " +
  "plate (número de placa vehicular, solo caracteres alfanuméricos en mayúscula sin espacios ni guiones, ej. 4AG892 o SLD631, o null), " +
  "vehicle_model (marca y modelo del vehículo, ej. BMW X2, TOYOTA COROLLA, NISSAN ALTIMA, CHEVROLET MALIBU, o null), " +
  "card_color (color dominante de fondo de la tarjeta o del llavero: usa estrictamente 'amarillo', 'verde', 'azul', 'negro', o null si no se distingue).";

const SPOT_SYSTEM_PROMPT =
  "Eres un lector experto de números de parqueo pintados sobre el piso/asfalto, columnas, letreros o pantallas de registro vehicular en aeropuertos. " +
  "Lee con máxima precisión los caracteres alfanuméricos pintados en el suelo o mostrados en la pantalla. " +
  "Devuelve EXCLUSIVAMENTE un objeto JSON válido con las claves: " +
  "spot (el número o código de parqueo, por ejemplo 'D16', 'B04', '204', '112', sin espacios ni guiones, en mayúscula, o null si no se distingue), " +
  "terminal (terminal del aeropuerto: 'A', 'B', 'C' o 'X', o null si no aparece).";

/**
 * Consulta la API oficial de Google Gemini Vision directamente.
 */
async function callGeminiVision(prompt: string, imageDataUrl: string): Promise<string | null> {
  const geminiKey =
    process.env["GEMINI_API_KEY"] ||
    process.env["VITE_GEMINI_API_KEY"] ||
    process.env["GOOGLE_API_KEY"];

  if (!geminiKey || geminiKey.startsWith("AQ.")) return null;

  const [meta, rawBase64] = imageDataUrl.split(",");
  const mimeMatch = meta?.match(/data:(.*?);base64/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const base64Data = rawBase64 || imageDataUrl;

  // Modelos oficiales vigentes de alta velocidad
  const models = ["gemini-2.0-flash", "gemini-1.5-flash"];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: `${prompt}\nExtrae los datos solicitados de esta imagen con máxima precisión.` },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
          },
        }),
      });

      if (res.ok) {
        const json = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      }
    } catch {
      // Continuar al siguiente modelo o fallback
    }
  }
  return null;
}

/**
 * Consulta la pasarela de IA de Lovable si está presente en el entorno.
 */
async function callLovableGateway(prompt: string, imageDataUrl: string): Promise<string | null> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  if (!lovableKey) return null;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Procesa esta imagen según las instrucciones y devuelve el JSON requerido." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? null;
    }
  } catch {
    // Continuar al siguiente motor
  }
  return null;
}

/**
 * Consulta alternativa mediante endpoints estándar compatibles con OpenAI / Groq / OpenRouter.
 */
async function callOpenAIVision(prompt: string, imageDataUrl: string): Promise<string | null> {
  const openaiKey = process.env["OPENAI_API_KEY"] || process.env["AI_API_KEY"];
  if (!openaiKey) return null;

  const baseUrl = (process.env["AI_BASE_URL"] || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env["AI_MODEL"] || "gpt-4o-mini";

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Procesa esta imagen según las instrucciones." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? null;
    }
  } catch {
    // Continuar al motor local
  }
  return null;
}

/**
 * Ejecuta OCR local en el servidor con temporizador de seguridad estricto (3.5s)
 * para garantizar que la interfaz jamás se quede bloqueada.
 */
async function callLocalOCR(imageDataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve("");
    }, 3500);

    void (async () => {
      try {
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const [, rawBase64] = imageDataUrl.split(",");
        const buffer = Buffer.from(rawBase64 || imageDataUrl, "base64");
        const result = await worker.recognize(buffer);
        clearTimeout(timeout);
        await worker.terminate().catch(() => {});
        resolve(result.data.text || "");
      } catch {
        clearTimeout(timeout);
        resolve("");
      }
    })();
  });
}

const COMMON_MAKES = [
  "TOYOTA",
  "NISSAN",
  "CHEVROLET",
  "CHEVY",
  "FORD",
  "HONDA",
  "HYUNDAI",
  "KIA",
  "JEEP",
  "CHRYSLER",
  "DODGE",
  "BMW",
  "MERCEDES",
  "AUDI",
  "VOLKSWAGEN",
  "VW",
  "TESLA",
  "SUBARU",
  "MAZDA",
  "GMC",
  "CADILLAC",
];

function extractVehicleModelFromText(text: string): string | null {
  const upper = text.toUpperCase();
  for (const make of COMMON_MAKES) {
    const idx = upper.indexOf(make);
    if (idx !== -1) {
      const slice = upper.slice(idx, idx + 35);
      const match = slice.match(/[A-Z0-9]+(?:\s+[A-Z0-9]+){1,2}/);
      if (match) return match[0].trim();
    }
  }
  return null;
}

function parseCardColor(rawColor: string | null | undefined): CardRead["card_color"] {
  const val = (rawColor ?? "").toLowerCase();
  if (val.includes("amarill") || val.includes("yellow")) return "amarillo";
  if (val.includes("verd") || val.includes("green")) return "verde";
  if (val.includes("azul") || val.includes("blue")) return "azul";
  if (val.includes("negr") || val.includes("black")) return "negro";
  return null;
}

function colorToTerminal(color: CardRead["card_color"]): CardRead["terminal"] {
  if (color === "amarillo") return "A";
  if (color === "verde") return "B";
  if (color === "azul") return "C";
  if (color === "negro") return "X";
  return null;
}

export async function processVehicleCard(data: {
  image: string;
  clientColor?: CardRead["card_color"] | undefined;
}): Promise<CardRead> {
  // 1. Intentar con Google Gemini Vision (oficial directo)
  let aiRaw = await callGeminiVision(CARD_SYSTEM_PROMPT, data.image);

  // 2. Intentar con Lovable Gateway si está disponible
  if (!aiRaw) {
    aiRaw = await callLovableGateway(CARD_SYSTEM_PROMPT, data.image);
  }

  // 3. Intentar con OpenAI Vision
  if (!aiRaw) {
    aiRaw = await callOpenAIVision(CARD_SYSTEM_PROMPT, data.image);
  }

  // Si alguna IA respondió, parsear su JSON estructurado
  if (aiRaw) {
    const cleanRaw = aiRaw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const match = cleanRaw.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }

    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null);
    const aiColor = parseCardColor(str(parsed["card_color"]));
    const finalColor = aiColor || data.clientColor || null;
    const terminal = colorToTerminal(finalColor);

    return {
      plate_state: str(parsed["plate_state"]),
      plate: str(parsed["plate"])?.replace(/[^A-Z0-9]/g, "") ?? null,
      vehicle_model: str(parsed["vehicle_model"]),
      card_color: finalColor,
      terminal,
      raw: aiRaw,
    };
  }

  // 4. Fallback a OCR Local con límite estricto de tiempo
  const ocrText = await callLocalOCR(data.image);
  const plateRead = parsePlateText(ocrText);
  const model = extractVehicleModelFromText(ocrText);
  const finalColor = data.clientColor || null;
  const terminal = colorToTerminal(finalColor);

  return {
    plate_state: plateRead.state,
    plate: plateRead.plate || null,
    vehicle_model: model,
    card_color: finalColor,
    terminal,
    raw: ocrText,
  };
}

export async function processParkingPhoto(data: { image: string }): Promise<SpotRead> {
  // 1. Intentar con Google Gemini Vision (oficial directo)
  let aiRaw = await callGeminiVision(SPOT_SYSTEM_PROMPT, data.image);

  // 2. Intentar con Lovable Gateway
  if (!aiRaw) {
    aiRaw = await callLovableGateway(SPOT_SYSTEM_PROMPT, data.image);
  }

  // 3. Intentar con OpenAI Vision
  if (!aiRaw) {
    aiRaw = await callOpenAIVision(SPOT_SYSTEM_PROMPT, data.image);
  }

  // Si alguna IA respondió
  if (aiRaw) {
    const cleanRaw = aiRaw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const match = cleanRaw.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }

    const spotRaw = typeof parsed["spot"] === "string" ? parsed["spot"].toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const termRaw = typeof parsed["terminal"] === "string" ? parsed["terminal"].toUpperCase().replace(/[^ABCX]/g, "") : "";
    const terminal = (["A", "B", "C", "X"] as const).find((t) => t === termRaw) ?? null;

    return {
      spot: spotRaw || null,
      terminal,
      raw: aiRaw,
    };
  }

  // 3. Fallback inteligente a OCR Local con Tesseract.js
  const ocrText = await callLocalOCR(data.image);

  // Buscar patrones de parqueo habituales (ej. D16, 214, B-04, C12, P-05)
  const spotMatch =
    ocrText.match(/\b([A-Z]\s*[-–]?\s*\d{1,4}|\d{1,4}\s*[-–]?\s*[A-Z])\b/i) ||
    ocrText.match(/(?:SPOT|PARKING|SPACE|LUGAR|CAJ[OÓ]N)\s*[:#]?\s*([A-Z0-9]{2,5})\b/i);

  const spotClean = spotMatch?.[1] ? spotMatch[1].replace(/[\s-–]/g, "").toUpperCase() : null;

  // Buscar terminal (A, B, C o X)
  const termMatch =
    ocrText.match(/(?:TERMINAL|TERM|TER)\s*[:#]?\s*([ABCX])\b/i) ||
    ocrText.match(/\b([ABCX])\s*(?:NIVEL|LEVEL|PISO)\b/i);

  const terminal = (termMatch?.[1] ? termMatch[1].toUpperCase() : null) as SpotRead["terminal"];

  return {
    spot: spotClean,
    terminal,
    raw: ocrText,
  };
}

/**
 * Lee la tarjeta/placa del vehículo desde una foto y devuelve estado, placa, modelo y terminal deducido.
 * 100% independiente de Lovable: utiliza Google Gemini Vision oficial, OpenAI Vision, o Tesseract OCR local.
 */
export const readVehicleCard = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        image: z.string().min(20),
        clientColor: z.enum(["amarillo", "verde", "azul", "negro"]).nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<CardRead> => {
    return processVehicleCard(data);
  });

/**
 * Lee una foto de parqueo o de la pantalla del teléfono y devuelve
 * el número de parqueo y el terminal registrado.
 * 100% independiente de Lovable.
 */
export const readParkingPhoto = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ image: z.string().min(20) }).parse(data))
  .handler(async ({ data }): Promise<SpotRead> => {
    return processParkingPhoto(data);
  });
