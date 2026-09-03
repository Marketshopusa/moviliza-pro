import { Link, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import type { ReactNode } from "react";

export function AppShell({ children }: { children?: ReactNode }) {
  const { profile, role, isSupervisor } = useAuth();

  return (
    <div className="min-h-screen bg-background font-sans">
      <header className="sticky top-0 z-20 bg-card/90 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
          <Link to="/" className="font-mono font-bold text-sm tracking-widest">
            MOVILIZA<span className="text-primary">PRO</span>
          </Link>
          <div className="flex items-center gap-3">
            {isSupervisor ? (
              <Link
                to="/panel"
                className="text-[10px] font-bold uppercase tracking-widest text-primary border border-primary/40 rounded px-2 py-1"
              >
                {role}
              </Link>
            ) : (
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground border border-border rounded px-2 py-1">
                {role}
              </span>
            )}

            <div className="size-8 rounded bg-panel text-panel-foreground grid place-items-center text-xs font-mono font-bold">
              {profile?.initials ?? "?"}
            </div>
            <button
              onClick={() => supabase.auth.signOut()}
              className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5 pb-24 space-y-6">{children ?? <Outlet />}</main>
      <nav className="fixed bottom-0 inset-x-0 z-20 bg-card border-t border-border">
        <div className="mx-auto max-w-5xl flex justify-around">
          <NavItem to="/app" label="Registrar" />
          <NavItem to="/movimientos" label="Historial" />
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
