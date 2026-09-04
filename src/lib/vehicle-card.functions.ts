import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

/**
 * Lee la tarjeta/placa del vehículo desde una foto y devuelve estado, placa y modelo.
 */
export const readVehicleCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ image: z.string().min(20) }).parse(data))
  .handler(async ({ data }): Promise<CardRead> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Falta la configuración de IA");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash",
        messages: [
          {
            role: "system",
            content:
              "Eres un lector de tarjetas de vehículos y placas de EE.UU. Devuelve SOLO un JSON con las claves plate_state (código de 2 letras del estado, ej FL), plate (solo caracteres alfanuméricos en mayúscula), vehicle_model (marca y modelo) y card_color. card_color es el color DOMINANTE del fondo o superficie sobre la que está apoyada la tarjeta/llave: usa exactamente 'amarillo', 'verde', 'azul' o 'negro'. Usa null si el dato no aparece.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extrae estado, placa y modelo de esta foto." },
              { type: "image_url", image_url: { url: data.image } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) throw new Error("Demasiadas lecturas seguidas. Espera unos segundos.");
      if (res.status === 402) throw new Error("Sin créditos de IA disponibles.");
      throw new Error(`No se pudo leer la foto (${res.status}): ${body.slice(0, 160)}`);
    }

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null);
    const colorRaw = (str(parsed["card_color"]) ?? "").toLowerCase();
    const color: CardRead["card_color"] = colorRaw.includes("amarill")
      ? "amarillo"
      : colorRaw.includes("verde")
        ? "verde"
        : colorRaw.includes("azul")
          ? "azul"
          : colorRaw.includes("negro")
            ? "negro"
            : null;
    const terminal: CardRead["terminal"] =
      color === "amarillo" ? "A" : color === "verde" ? "B" : color === "azul" ? "C" : color === "negro" ? "X" : null;
    return {
      plate_state: str(parsed["plate_state"]),
      plate: str(parsed["plate"])?.replace(/[^A-Z0-9]/g, "") ?? null,
      vehicle_model: str(parsed["vehicle_model"]),
      card_color: color,
      terminal,
      raw,
    };
  });

export type SpotRead = {
  /** Número de parqueo leído, por ejemplo D16. */
  spot: string | null;
  /** Terminal leído en la foto (A, B, C o X). */
  terminal: "A" | "B" | "C" | "X" | null;
  raw: string;
};

/**
 * Lee una foto de parqueo o de la pantalla del teléfono y devuelve
 * el número de parqueo y el terminal registrado.
 */
export const readParkingPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ image: z.string().min(20) }).parse(data))
  .handler(async ({ data }): Promise<SpotRead> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Falta la configuración de IA");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash",
        messages: [
          {
            role: "system",
            content:
              "Lees fotos de señalización de parqueo o de la pantalla de un teléfono con el registro de un vehículo. Devuelve SOLO un JSON con las claves spot (el número o código de parqueo, por ejemplo 'D16', sin espacios ni guiones, en mayúscula) y terminal (una sola letra A, B, C o X si aparece el terminal). Usa null si el dato no aparece.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extrae el número de parqueo y el terminal de esta foto." },
              { type: "image_url", image_url: { url: data.image } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) throw new Error("Demasiadas lecturas seguidas. Espera unos segundos.");
      if (res.status === 402) throw new Error("Sin créditos de IA disponibles.");
      throw new Error(`No se pudo leer la foto (${res.status}): ${body.slice(0, 160)}`);
    }

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    const spotRaw = typeof parsed["spot"] === "string" ? parsed["spot"].toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const termRaw = typeof parsed["terminal"] === "string" ? parsed["terminal"].toUpperCase().replace(/[^ABCX]/g, "") : "";
    const terminal = (["A", "B", "C", "X"] as const).find((t) => t === termRaw) ?? null;
    return { spot: spotRaw || null, terminal, raw };
  });
