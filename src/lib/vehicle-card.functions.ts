import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parsePlateText } from "@/lib/plate-ocr";
import {
  parseAiTerminal,
  terminalFromCardColor,
  type CardOcrEngine,
} from "@/lib/card-scan-message";
import type { CardColor } from "@/lib/card-color-detector";

export type CardRead = {
  plate_state: string | null;
  plate: string | null;
  vehicle_model: string | null;
  /** Color de fondo de la tarjeta de referencia: naranja, amarillo, verde, azul (negro no es ubicación). */
  card_color: "naranja" | "amarillo" | "verde" | "azul" | "negro" | null;
  /** Terminal deducido del color: A, B, C o X. */
  terminal: "A" | "B" | "C" | "X" | null;
  engine: CardOcrEngine;
  raw: string;
};

export type SpotRead = {
  /** Número de parqueo leído, por ejemplo D16. */
  spot: string | null;
  /** Terminal leído en la foto (A, B, C o X). */
  terminal: "A" | "B" | "C" | "X" | null;
  raw: string;
};

const GEMINI_TIMEOUT_MS = 16_000;
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash"] as const;

const CARD_SYSTEM_PROMPT =
  "Eres un lector experto de tarjetas de vehículos SIXT en el aeropuerto de Orlando (MCO).\n" +
  "La foto muestra una llave de vehículo con una etiqueta plástica negra rectangular (llavero/tag). " +
  "IMPORTANTE: La etiqueta PUEDE ESTAR GIRADA 90° O EN CUALQUIER ÁNGULO — rota mentalmente la imagen y lee de todas formas.\n\n" +
  "PASO 1 — LEE LA ETIQUETA NEGRA DEL LLAVERO (no es la tarjeta de terminal):\n" +
  "   - Franja negra con letras BLANCAS GRANDES: contiene ESTADO (2 letras) + guión + PLACA. Ejemplo: 'FL – KR158B' o 'FL - BZ691Z'.\n" +
  "     Pon el estado en plate_state y la placa en plate (sin guiones ni espacios).\n" +
  "   - Línea debajo de la franja: marca y modelo del auto (ej: BMW SERIES 2, BMW X7, NISSAN ALTIMA). Ponlo en vehicle_model.\n" +
  "   - Ignora íconos pequeños, combustible, transmisión, color del auto, códigos de barras y texto irrelevante.\n\n" +
  "PASO 2 — TERMINAL: usa la TARJETA O CÍRCULO DE COLOR de referencia, no el tag negro.\n" +
  "   - BLACK / NEGRO NO ES UN COLOR DE TERMINAL. El negro puede ser el tag SIXT, un borde, impresión, sombra o fondo. Nunca infieras X, A, B ni C solo porque haya negro.\n" +
  "   - Fondo NARANJA / ORANGE o texto Base X → terminal: X, card_color: naranja\n" +
  "   - Fondo AMARILLO / YELLOW o texto Terminal A → terminal: A, card_color: amarillo\n" +
  "   - Fondo VERDE / GREEN o texto Terminal B → terminal: B, card_color: verde\n" +
  "   - Fondo AZUL / BLUE o texto Terminal C → terminal: C, card_color: azul\n\n" +
  "Responde ÚNICAMENTE con JSON válido, sin markdown:\n" +
  '{"plate_state":"FL","plate":"KR158B","vehicle_model":"BMW SERIES 2","card_color":"azul","terminal":"C"}\n' +
  "Si no puedes leer un campo con certeza, usa null para ese campo.";

const SPOT_SYSTEM_PROMPT =
  "Eres un lector experto de números de parqueo pintados sobre el piso/asfalto, columnas, letreros o pantallas de registro vehicular en aeropuertos.\n" +
  "Lee con máxima precisión los caracteres alfanuméricos pintados en el suelo o mostrados en la pantalla.\n" +
  "Devuelve EXCLUSIVAMENTE un objeto JSON válido con las claves:\n" +
  "spot (el número o código de parqueo, por ejemplo 'D16', 'B04', '204', '112', sin espacios ni guiones, en mayúscula, o null si no se distingue),\n" +
  "terminal (terminal del aeropuerto: 'A', 'B', 'C' o 'X', o null si no aparece).";

function buildCardPrompt(clientColor?: CardColor | undefined): string {
  let hint = "";
  if (
    clientColor === "naranja" ||
    clientColor === "amarillo" ||
    clientColor === "verde" ||
    clientColor === "azul"
  ) {
    hint =
      `\nPista del detector Canvas (tarjeta de color, no el tag): card_color aparente "${clientColor}". ` +
      "Confírmalo mirando el fondo de color. BLACK/NEGRO no es un terminal.";
  }
  return CARD_SYSTEM_PROMPT + hint;
}

function ocrLog(level: "log" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  if (extra) {
    console[level](`[ocr] ${message}`, extra);
    return;
  }
  console[level](`[ocr] ${message}`);
}

function parseGeminiErrorBody(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string; status?: string } };
    const msg = json.error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.slice(0, 180);
  } catch {
    // cuerpo no JSON
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Consulta la API oficial de Google Gemini Vision.
 * Solo GEMINI_API_KEY de servidor. Nunca registra el valor de la clave.
 */
async function callGeminiVision(prompt: string, imageDataUrl: string): Promise<string | null> {
  const geminiKey = process.env["GEMINI_API_KEY"];

  if (!geminiKey) {
    ocrLog("warn", "GEMINI_API_KEY ausente; se omite Gemini");
    return null;
  }
  if (geminiKey.startsWith("AQ.")) {
    ocrLog("warn", "GEMINI_API_KEY rechazada: prefijo no soportado");
    return null;
  }

  const [meta, rawBase64] = imageDataUrl.split(",");
  const mimeMatch = meta?.match(/data:(.*?);base64/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const base64Data = rawBase64 || imageDataUrl;

  for (const model of GEMINI_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const res = await fetch(`${endpoint}?key=${encodeURIComponent(geminiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
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
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
      });

      if (res.status === 404) {
        ocrLog("warn", "modelo Gemini no disponible", { model, status: 404 });
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        ocrLog("warn", "Gemini HTTP error", {
          model,
          status: res.status,
          detail: parseGeminiErrorBody(errText),
        });
        continue;
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim()) {
        ocrLog("log", "Gemini OK", { model });
        return text;
      }
      ocrLog("warn", "Gemini sin texto en candidatos", { model });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : "unknown";
      ocrLog("warn", "Gemini excepción", { model, name, message: message.slice(0, 180) });
    }
  }
  return null;
}

/**
 * Consulta alternativa mediante endpoints estándar compatibles con OpenAI / Groq / OpenRouter.
 */
async function callOpenAIVision(prompt: string, imageDataUrl: string): Promise<string | null> {
  const openaiKey = process.env["OPENAI_API_KEY"] || process.env["AI_API_KEY"];
  if (!openaiKey) {
    ocrLog("log", "OpenAI/AI_API_KEY ausente; se omite OpenAI Vision");
    return null;
  }

  const baseUrl = (process.env["AI_BASE_URL"] || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env["AI_MODEL"] || "gpt-4o-mini";

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
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

    if (!res.ok) {
      ocrLog("warn", "OpenAI Vision HTTP error", { status: res.status, model });
      return null;
    }

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content ?? null;
    if (content) ocrLog("log", "OpenAI Vision OK", { model });
    return content;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    ocrLog("warn", "OpenAI Vision excepción", { message: message.slice(0, 180) });
    return null;
  }
}

/**
 * Ejecuta OCR local en el servidor con temporizador de seguridad estricto (3.5s)
 * para garantizar que la interfaz jamás se quede bloqueada.
 */
async function callLocalOCR(imageDataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ocrLog("warn", "Tesseract timeout 3.5s");
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
        await worker.terminate().catch((termErr: unknown) => {
          const message = termErr instanceof Error ? termErr.message : "terminate failed";
          ocrLog("warn", "Tesseract terminate", { message: message.slice(0, 120) });
        });
        resolve(result.data.text || "");
      } catch (err) {
        clearTimeout(timeout);
        const message = err instanceof Error ? err.message : "unknown";
        ocrLog("warn", "Tesseract error", { message: message.slice(0, 180) });
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
  if (val.includes("naranj") || val.includes("orange")) return "naranja";
  if (val.includes("amarill") || val.includes("yellow")) return "amarillo";
  if (val.includes("verd") || val.includes("green")) return "verde";
  if (val.includes("azul") || val.includes("blue")) return "azul";
  if (val.includes("negr") || val.includes("black")) return "negro";
  return null;
}

function operationalClientColor(color: CardColor | undefined): CardColor {
  if (color === "naranja" || color === "amarillo" || color === "verde" || color === "azul") {
    return color;
  }
  return null;
}

function parseAiJson(aiRaw: string): Record<string, unknown> {
  const cleanRaw = aiRaw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const match = cleanRaw.match(/\{[\s\S]*\}/);
  try {
    return match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : "json";
    ocrLog("warn", "JSON de IA inválido", { message: message.slice(0, 120) });
    return {};
  }
}

function mergeCardRead(input: {
  parsed: Record<string, unknown>;
  clientColor?: CardColor | undefined;
  engine: CardOcrEngine;
  raw: string;
  ocrText?: string;
}): CardRead {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null);
  const parsedColor = parseCardColor(str(input.parsed["card_color"]));
  const clientOp = operationalClientColor(input.clientColor);
  const finalColor = (parsedColor && parsedColor !== "negro" ? parsedColor : null) || clientOp || null;
  let aiTerminal = parseAiTerminal(input.parsed["terminal"]);
  if (aiTerminal === "X" && parsedColor === "negro") {
    aiTerminal = null;
  }
  const terminal = aiTerminal ?? terminalFromCardColor(finalColor);

  let plate = str(input.parsed["plate"])?.replace(/[^A-Z0-9]/g, "") ?? null;
  let plateState = str(input.parsed["plate_state"]);
  let vehicleModel = str(input.parsed["vehicle_model"]);

  if (input.ocrText && (!plate || !plateState || !vehicleModel)) {
    const plateRead = parsePlateText(input.ocrText);
    if (!plate && plateRead.plate) plate = plateRead.plate;
    if (!plateState && plateRead.state) plateState = plateRead.state;
    if (!vehicleModel) vehicleModel = extractVehicleModelFromText(input.ocrText);
  }

  return {
    plate_state: plateState,
    plate,
    vehicle_model: vehicleModel,
    card_color: finalColor,
    terminal,
    engine: input.engine,
    raw: input.raw,
  };
}

export async function processVehicleCard(data: {
  image: string;
  clientColor?: CardRead["card_color"] | undefined;
}): Promise<CardRead> {
  const prompt = buildCardPrompt(data.clientColor);

  let engine: CardOcrEngine = "none";
  let aiRaw = await callGeminiVision(prompt, data.image);
  if (aiRaw) engine = "gemini";

  if (!aiRaw) {
    aiRaw = await callOpenAIVision(prompt, data.image);
    if (aiRaw) engine = "openai";
  }

  if (aiRaw) {
    const parsed = parseAiJson(aiRaw);
    const merged = mergeCardRead({
      parsed,
      clientColor: data.clientColor,
      engine,
      raw: aiRaw,
    });
    if (!merged.plate) {
      const ocrText = await callLocalOCR(data.image);
      const filled = mergeCardRead({
        parsed,
        clientColor: data.clientColor,
        engine: ocrText ? "tesseract" : engine,
        raw: `${aiRaw}\n${ocrText}`,
        ocrText,
      });
      return filled;
    }
    return merged;
  }

  const ocrText = await callLocalOCR(data.image);
  const plateRead = parsePlateText(ocrText);
  const model = extractVehicleModelFromText(ocrText);
  const finalColor = operationalClientColor(data.clientColor);

  return {
    plate_state: plateRead.state,
    plate: plateRead.plate || null,
    vehicle_model: model,
    card_color: finalColor,
    terminal: terminalFromCardColor(finalColor),
    engine: ocrText ? "tesseract" : "none",
    raw: ocrText,
  };
}

export async function processParkingPhoto(data: { image: string }): Promise<SpotRead> {
  let aiRaw = await callGeminiVision(SPOT_SYSTEM_PROMPT, data.image);

  if (!aiRaw) {
    aiRaw = await callOpenAIVision(SPOT_SYSTEM_PROMPT, data.image);
  }

  if (aiRaw) {
    const parsed = parseAiJson(aiRaw);
    const spotRaw =
      typeof parsed["spot"] === "string" ? parsed["spot"].toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const terminal = parseAiTerminal(parsed["terminal"]);

    return {
      spot: spotRaw || null,
      terminal,
      raw: aiRaw,
    };
  }

  const ocrText = await callLocalOCR(data.image);

  const spotMatch =
    ocrText.match(/\b([A-Z]\s*[-–]?\s*\d{1,4}|\d{1,4}\s*[-–]?\s*[A-Z])\b/i) ||
    ocrText.match(/(?:SPOT|PARKING|SPACE|LUGAR|CAJ[OÓ]N)\s*[:#]?\s*([A-Z0-9]{2,5})\b/i);

  const spotClean = spotMatch?.[1] ? spotMatch[1].replace(/[\s-–]/g, "").toUpperCase() : null;

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
 * Lee la tarjeta/placa del vehículo desde una foto y devuelve estado, placa, modelo y terminal.
 * Endpoint sin requireSupabaseAuth (P2). Gate de UI: rutas /_authenticated.
 */
export const readVehicleCard = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        image: z.string().min(20),
        clientColor: z.enum(["naranja", "amarillo", "verde", "azul", "negro"]).nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<CardRead> => {
    return processVehicleCard(data);
  });

/**
 * Lee una foto de parqueo o de la pantalla del teléfono y devuelve
 * el número de parqueo y el terminal registrado.
 */
export const readParkingPhoto = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ image: z.string().min(20) }).parse(data))
  .handler(async ({ data }): Promise<SpotRead> => {
    return processParkingPhoto(data);
  });
