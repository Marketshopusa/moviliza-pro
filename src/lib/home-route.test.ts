import { AUTHENTICATED_HOME, isAuthenticatedHome, postAuthRedirect } from "./home-route";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("home is drivers", AUTHENTICATED_HOME, "/drivers");
assertEqual("login redirect", postAuthRedirect(), "/drivers");
assertEqual("drivers is home", isAuthenticatedHome("/drivers"), true);
assertEqual("daw is not home", isAuthenticatedHome("/app"), false);

const dir = dirname(fileURLToPath(import.meta.url));
const auth = readFileSync(join(dir, "../routes/auth.tsx"), "utf8");
if (auth.includes('navigate({ to: "/app" })')) {
  throw new Error("login must not send users to DAW /app");
}
if (!auth.includes('navigate({ to: "/drivers" })') && !auth.includes("postAuthRedirect")) {
  throw new Error("login must navigate to /drivers");
}

console.log("home-route tests ok");
