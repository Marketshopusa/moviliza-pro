# Envoltorio nativo (Capacitor) — MOVILIZA PRO

Arquitectura (un solo frontend):

```
APP NATIVA (Android / iOS)
  -> WebView Capacitor
  -> URL HTTPS de Vercel (TanStack Start / Nitro SSR)
  -> Supabase + Gemini (server-side)
```

`webDir=public` es un requisito de Capacitor. **No es la UI.** Si el WebView carga `public/index.html`, la config está mal.

## Qué carga al arrancar

Con `bun run cap:sync` (exige `CAPACITOR_SERVER_URL`):

- Android/iOS abren `server.url` = origen HTTPS de Preview (p. ej. `https://….vercel.app`).
- Rutas, login, Drivers, OCR y PTT son la misma app web.
- `window.location.origin` es esa URL → `emailRedirectTo` de signup apunta al Preview (añádela en Supabase Auth redirect URLs).

## Preview vs Production

| Entorno | `CAPACITOR_SERVER_URL` | Cuándo |
|---|---|---|
| Pruebas ahora | URL HTTPS del **Preview** de `migration/vercel-independent` | único permitido en esta rama |
| Production | dominio final | **no** configurar hasta cutover autorizado |

No hardcodear Production en el repo.

## Si falta `CAPACITOR_SERVER_URL`

- `bun run cap:sync` **falla** a propósito (evitaría un APK que solo muestra el placeholder).
- `bunx cap doctor` / `bunx cap sync` directo **no** inyectan URL.
- Un binario generado sin `server.url` mostraría la pantalla roja de `public/index.html`.

```bash
# PowerShell
$env:CAPACITOR_SERVER_URL="https://TU-PREVIEW.vercel.app"
bun run cap:sync
```

GEMINI_API_KEY no entra al cliente ni al WebView; sigue en Vercel.

## Binarios

JDK/Xcode ausentes en este entorno: proyectos `android/` e `ios/` existen; **no hay APK/IPA instalado ni probado.**
