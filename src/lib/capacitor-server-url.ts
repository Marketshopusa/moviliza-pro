const BLOCKED_HOST_MARKERS = ["localhost", "127.0.0.1"];

export type NativeServerTarget = {
  url: string;
  hostname: string;
};

/**
 * Native WebView must load the hosted TanStack/SSR app, never public/index.html.
 * Preview: CAPACITOR_SERVER_URL=https://<preview>.vercel.app
 * Production: only after explicit cutover (do not set that host in this branch).
 */
export function resolveCapacitorServerUrl(
  raw: string | null | undefined,
): NativeServerTarget | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("CAPACITOR_SERVER_URL no es una URL válida.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("CAPACITOR_SERVER_URL debe ser https (la app SSR vive en Vercel).");
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST_MARKERS.some((marker) => host === marker)) {
    throw new Error("CAPACITOR_SERVER_URL no puede ser localhost. Usa la URL HTTPS de Preview.");
  }

  return { url: parsed.origin, hostname: parsed.hostname };
}

export function requireCapacitorServerUrl(raw: string | null | undefined): NativeServerTarget {
  const target = resolveCapacitorServerUrl(raw);
  if (!target) {
    throw new Error(
      "Falta CAPACITOR_SERVER_URL. Sin ella, Android/iOS cargarían public/index.html (placeholder) y NO la app MOVILIZA PRO. Define la URL HTTPS del Preview de esta rama, luego: bun run cap:sync",
    );
  }
  return target;
}
