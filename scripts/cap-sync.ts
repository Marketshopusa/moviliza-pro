import { spawnSync } from "node:child_process";
import { requireCapacitorServerUrl } from "../src/lib/capacitor-server-url";

const target = requireCapacitorServerUrl(process.env["CAPACITOR_SERVER_URL"]);
console.info(`[cap] native WebView -> ${target.url} (host ${target.hostname})`);

const sync = spawnSync("bunx", ["cap", "sync"], { stdio: "inherit", shell: true, env: process.env });
process.exit(sync.status ?? 1);
