import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth, type AppRole } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useLocationBeacon } from "@/lib/geo";
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


  const perfilIncompleto = !!profile && (!profile.avatar_url || !profile.initials);

  return (
    <div className={cn("min-h-screen font-sans", role === "administrador" ? "bg-background-admin" : "bg-background")}>
      <header className="sticky top-0 z-20 bg-card/90 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-5xl px-4 flex items-center justify-between py-2">
          <Link to="/" className="flex flex-col items-center leading-none">
            <img
              src="/logo-moviliza-pro-icon.png"
              alt="MOVILIZA-PRO"
              className="h-12 w-auto object-contain"
              width={1024}
              height={1024}
            />
            <img
              src="/moviliza-pro-wordmark.png"
              alt="MOVILIZA-PRO"
              className="h-4 w-auto object-contain -mt-0.5"
              width={304}
              height={26}
            />
          </Link>
          <div className="flex flex-col items-center gap-1">
            <Link to="/perfil" className="size-14 rounded-xl overflow-hidden bg-panel text-panel-foreground grid place-items-center text-sm font-mono font-bold shadow-sm">
              {avatar ? (
                <img src={avatar} alt={`Foto de perfil de ${profile?.full_name ?? "conductor"}`} className="size-full object-cover" />
              ) : (
                (profile?.initials ?? "?")
              )}
            </Link>
            <RoleBadge />
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
          <NavItem to="/app" label="DAW" />
          <NavItem to="/drivers" label="DRIVERS" />
          <NavItem to="/movimientos" label="Historial" />
          <NavItem to="/perfil" label="Perfil" />
          {isSupervisor && <NavItem to="/panel" label="Panel" />}
        </div>
      </nav>
    </div>
  );
}

function RoleBadge({ className }: { className?: string }) {
  const { role, isSupervisor } = useAuth();
  const label: Record<AppRole, string> = {
    conductor: "DRIVER",
    supervisor: "SUPERVISOR",
    administrador: "ADMINISTRADOR",
  };
  const badgeClasses: Record<AppRole, string> = {
    conductor: "text-green-600 border-green-500/40 bg-green-500/10",
    supervisor: "text-primary border-primary/40",
    administrador: "text-primary border-primary/40",
  };
  const classes = cn(
    "inline-block text-[10px] font-bold uppercase tracking-widest border rounded px-2 py-1",
    badgeClasses[role],
    className
  );
  return isSupervisor ? (
    <Link to="/panel" className={classes}>
      {label[role]}
    </Link>
  ) : (
    <span className={classes}>{label[role]}</span>
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
