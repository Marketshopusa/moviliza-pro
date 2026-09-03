import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Acceso · MovilizaPro" },
      {
        name: "description",
        content: "Inicia sesión o crea tu cuenta de conductor para registrar movimientos de vehículos.",
      },
      { property: "og:title", content: "Acceso · MovilizaPro" },
      { property: "og:description", content: "Acceso de conductores y supervisores." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [initials, setInitials] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function traducir(msg: string) {
    if (/already registered/i.test(msg)) return "Ese correo ya está registrado. Usa «Entrar».";
    if (/Invalid login credentials/i.test(msg)) return "Correo o contraseña incorrectos.";
    if (/only request this after/i.test(msg)) return "Espera unos segundos e inténtalo de nuevo.";
    return msg;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName, initials: initials.toUpperCase() },
            emailRedirectTo: window.location.origin,
          },
        });
        if (err) throw err;
        if (!data.session) {
          const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
          if (signInErr) throw signInErr;
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      navigate({ to: "/app" });
    } catch (err) {
      setError(traducir(err instanceof Error ? err.message : "Error de autenticación"));
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="min-h-screen bg-background grid place-items-center px-4 font-sans">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="font-mono font-bold text-2xl tracking-widest">
            MOVILIZA<span className="text-primary">PRO</span>
          </p>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-widest">
            Control de movimientos de vehículos
          </p>
        </div>
        <form onSubmit={submit} className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
          {mode === "signup" && (
            <>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase">Nombre completo</label>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase">Iniciales</label>
                <input
                  value={initials}
                  onChange={(e) => setInitials(e.target.value.toUpperCase())}
                  maxLength={4}
                  required
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono uppercase outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </>
          )}
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-muted-foreground uppercase">Correo</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-muted-foreground uppercase">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {error && <p className="text-xs font-semibold text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-bold py-3 rounded-xl uppercase tracking-widest text-sm"
          >
            {busy ? "Procesando…" : mode === "login" ? "Entrar" : "Crear cuenta"}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
            className="w-full text-xs font-bold text-muted-foreground hover:text-foreground uppercase tracking-widest"
          >
            {mode === "login" ? "¿No tienes cuenta? Regístrate" : "¿Ya tienes cuenta? Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
