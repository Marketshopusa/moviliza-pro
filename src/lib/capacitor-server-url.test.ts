import { requireCapacitorServerUrl, resolveCapacitorServerUrl } from "./capacitor-server-url";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("missing is null", resolveCapacitorServerUrl(""), null);
assertEqual("blank is null", resolveCapacitorServerUrl("   "), null);

const preview = resolveCapacitorServerUrl("https://moviliza-preview.vercel.app/drivers");
assertEqual("preview origin only", preview?.url, "https://moviliza-preview.vercel.app");
assertEqual("preview host", preview?.hostname, "moviliza-preview.vercel.app");

let httpsFail = false;
try {
  resolveCapacitorServerUrl("http://example.com");
} catch {
  httpsFail = true;
}
assertEqual("http rejected", httpsFail, true);

let localFail = false;
try {
  resolveCapacitorServerUrl("https://localhost");
} catch {
  localFail = true;
}
assertEqual("localhost rejected", localFail, true);

let requiredFail = false;
try {
  requireCapacitorServerUrl("");
} catch (err) {
  requiredFail = err instanceof Error && err.message.includes("placeholder");
}
assertEqual("require explains placeholder risk", requiredFail, true);

console.log("capacitor-server-url tests ok");
