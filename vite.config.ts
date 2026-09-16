import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const gitSha = (process.env["VERCEL_GIT_COMMIT_SHA"] || process.env["GITHUB_SHA"] || "local").slice(0, 12);
const vercelEnv = process.env["VERCEL_ENV"] || "";

export default defineConfig({
  define: {
    "import.meta.env.VITE_GIT_SHA": JSON.stringify(gitSha),
    "import.meta.env.VITE_VERCEL_ENV": JSON.stringify(vercelEnv),
  },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      // Keep the SSR error wrapper in src/server.ts (same entry Lovable used).
      server: { entry: "server" },
    }),
    nitro(
      process.env["NITRO_PRESET"]
        ? { preset: process.env["NITRO_PRESET"] }
        : process.env["VERCEL"]
          ? { preset: "vercel" }
          : {},
    ),
    viteReact(),
  ],
});
