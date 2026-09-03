import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useLocationBeacon, markOffShift } from "@/lib/geo";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function AppShell({ children }: { children?: ReactNode }) {
  const { profile, role, isSupervisor, user } = useAuth();
  const [avatar, setAvatar] = useState<string | null>(null);

  // El GPS se activa en el teléfono donde el conductor inicia sesión.
  useLocationBeacon(user?.id, !isSupervisor);

  useEffect(() => {
    let active = true;
    if (!profile?.avatar_url) {
      setAvatar(null);
      return;
    }
    void supabase.storage
      .from("driver-avatars")
      .createSignedUrl(profile.avatar_url, 3600)
      .then(({ data }) => {
        if (active) setAvatar(data?.signedUrl ?? null);
      });
    return () => {
      active = false;
    };
  }, [profile?.avatar_url]);

  async function salir() {
    if (user) await markOffShift(user.id).catch(() => {});
    await supabase.auth.signOut();
  }

  const perfilIncompleto = !!profile && (!profile.avatar_url || !profile.initials);

  return (
    <div className={cn("min-h-screen font-sans", role === "administrador" ? "bg-background-admin" : "bg-background")}>
      <header className="sticky top-0 z-20 bg-card/90 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-5xl px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 sm:py-0 sm:h-16">
          <Link to="/" className="flex items-center gap-2">
            <img
              src="/logo-moviliza-pro-icon.png"
              alt="MOVILIZA-PRO"
              className="h-[72px] w-auto object-contain -my-2 relative z-10"
              width={1024}
              height={1024}
            />
            <img
              src="/moviliza-pro-wordmark.png"
              alt="MOVILIZA-PRO"
              className="h-5 w-auto object-contain"
              width={304}
              height={26}
            />
          </Link>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-3">
              {isSupervisor ? (
                <Link
                  to="/panel"
                  className="hidden sm:inline-block text-[10px] font-bold uppercase tracking-widest text-primary border border-primary/40 rounded px-2 py-1"
                >
                  {role}
                </Link>
              ) : (
                <span className="hidden sm:inline-block text-[10px] font-bold uppercase tracking-widest text-muted-foreground border border-border rounded px-2 py-1">
                  {role}
                </span>
              )}

              <Link to="/perfil" className="size-8 rounded overflow-hidden bg-panel text-panel-foreground grid place-items-center text-xs font-mono font-bold">
                {avatar ? (
                  <img src={avatar} alt={`Foto de perfil de ${profile?.full_name ?? "conductor"}`} className="size-full object-cover" />
                ) : (
                  (profile?.initials ?? "?")
                )}
              </Link>
              <button
                onClick={() => void salir()}
                className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                Salir
              </button>
            </div>
            {isSupervisor ? (
              <Link
                to="/panel"
                className="sm:hidden text-[10px] font-bold uppercase tracking-widest text-primary border border-primary/40 rounded px-2 py-1"
              >
                {role}
              </Link>
            ) : (
              <span className="sm:hidden text-[10px] font-bold uppercase tracking-widest text-muted-foreground border border-border rounded px-2 py-1">
                {role}
              </span>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5 pb-24 space-y-6">
        {perfilIncompleto && (
          <Link
            to="/perfil"
            className="block bg-accent/15 border border-accent/40 rounded-xl p-3 text-xs font-semibold"
          >
            Completa tu perfil: agrega tu foto e iniciales para que los supervisores puedan identificarte.
          </Link>
        )}
        {children ?? <Outlet />}
      </main>
      <nav className="fixed bottom-0 inset-x-0 z-20 bg-card border-t border-border">
        <div className="mx-auto max-w-5xl flex justify-around">
          <NavItem to="/app" label="Registrar" />
          <NavItem to="/movimientos" label="Historial" />
          <NavItem to="/perfil" label="Perfil" />
          {isSupervisor && <NavItem to="/panel" label="Panel" />}
        </div>
      </nav>
    </div>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="py-3 px-4 text-[11px] font-bold uppercase tracking-widest text-muted-foreground"
      activeProps={{ className: "text-primary border-t-2 border-primary" }}
    >
      {label}
    </Link>
  );
}
