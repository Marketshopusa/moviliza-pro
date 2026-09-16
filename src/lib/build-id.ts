export const BUILD_ID = String(import.meta.env["VITE_GIT_SHA"] ?? "local");
export const VERCEL_ENV = String(import.meta.env["VITE_VERCEL_ENV"] ?? "");

export function shouldShowBuildMark(): boolean {
  return import.meta.env.DEV || VERCEL_ENV === "preview" || VERCEL_ENV === "development";
}

export function logBuildId(): void {
  if (!shouldShowBuildMark()) return;
  console.info("[build]", BUILD_ID, VERCEL_ENV || import.meta.env.MODE);
}
