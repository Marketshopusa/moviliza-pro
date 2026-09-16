import { requireCapacitorServerUrl, resolveCapacitorServerUrl } from "./src/lib/capacitor-server-url";

const fromEnv = resolveCapacitorServerUrl(process.env["CAPACITOR_SERVER_URL"]);

if (process.env["CAPACITOR_REQUIRE_SERVER_URL"] === "1") {
  requireCapacitorServerUrl(process.env["CAPACITOR_SERVER_URL"]);
}

const config = {
  appId: "pro.moviliza.app",
  appName: "MOVILIZA PRO",
  webDir: "public",
  server: fromEnv
    ? {
        url: fromEnv.url,
        hostname: fromEnv.hostname,
        androidScheme: "https" as const,
        iosScheme: "https" as const,
      }
    : {
        androidScheme: "https" as const,
        iosScheme: "https" as const,
      },
  android: {
    allowMixedContent: false,
  },
};

export default config;
