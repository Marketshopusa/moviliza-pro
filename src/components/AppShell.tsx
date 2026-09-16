import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth, type AppRole } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useLocationBeacon } from "@/lib/geo";
import { useDriverShift } from "@/lib/driver-shift-context";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function AppShell({ children }: { children?: ReactNode }) {
  const { profile, role, isSupervisor, user, loading: authLoading } = useAuth();
  const { shift, loading: shiftLoading } = useDriverShift();
  const [avatar, setAvatar] = useState<string | null>(null);

  const beaconOn = role === "conductor" && !isSupervisor && !!shift && !shiftLoading && !authLoading;
  useLocationBeacon(user?.id, beaconOn);

  useEffect(() => {
    let active = true;
    if (authLoading) return;
    if (!profile?.avatar_url) {
      setAvatar(null);
      return;
    }
    const path = profile.avatar_url;
    void supabase.storage
      .from("driver-avatars")
      .createSignedUrl(path, 3600)
      .then(({ data, error }) => {
        if (!active) return;
        if (data?.signedUrl) {
          setAvatar(data.signedUrl);
          return;
        }
        if (error) {
          const { data: pub } = supabase.storage.from("driver-avatars").getPublicUrl(path);
          setAvatar(pub.publicUrl || null);
          return;
        }
        setAvatar(null);
      });
    return () => {
      active = false;
    };
  }, [profile?.avatar_url, authLoading]);


  const perfilIncompleto = !!profile && (!profile.avatar_url || !profile.initials);

  return (
    <div className={cn("min-h-dvh max-w-full overflow-x-hidden font-sans", role === "administrador" ? "bg-background-admin" : "bg-background")}>
      <header className="sticky top-0 z-20 bg-card/90 backdrop-blur border-b border-border pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-5xl w-full min-w-0 px-3 sm:px-4 flex items-center justify-between py-2 gap-2">
          <Link to="/" className="flex flex-col items-center leading-none">
            <img
              src="/logo-moviliza-pro-icon.png"
              alt="MOVILIZA-PRO"
              className="h-12 w-auto max-w-16 object-contain"
              width={1024}
              height={1024}
            />
            <img
              src="/moviliza-pro-wordmark.png"
              alt="MOVILIZA-PRO"
              className="h-4 w-auto max-w-28 object-contain -mt-0.5"
              width={304}
              height={26}
            />
          </Link>
          <div className="flex flex-col items-center gap-1">
            <Link to="/perfil" className="size-14 rounded-xl overflow-hidden bg-panel text-panel-foreground grid place-items-center text-sm font-mono font-bold shadow-sm">
              {avatar ? (
                <img src={avatar} alt={`Foto de perfil de ${profile?.full_name ?? "conductor"}`} className="size-full object-cover" />
              ) : authLoading ? null : (
                (profile?.initials ?? "?")
              )}
            </Link>
            <RoleBadge />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl w-full min-w-0 px-3 sm:px-4 py-5 pb-[calc(5.75rem+env(safe-area-inset-bottom))] space-y-6 overflow-x-hidden">
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
      <nav className="fixed bottom-0 inset-x-0 z-20 bg-card border-t border-border pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto max-w-5xl w-full min-w-0 flex justify-between px-1">
          <NavItem to="/drivers" label="Drivers" />
          <NavItem to="/cleaners" label="Cleaners" />
          <NavItem to="/app" label="DAW" />
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
      className="flex-1 min-w-0 text-center py-2.5 px-0.5 text-[8px] sm:text-[10px] font-bold uppercase tracking-tight text-muted-foreground leading-tight break-words"
      activeProps={{ className: "text-primary border-t-2 border-primary" }}
    >
      {label}
    </Link>
  );
}
