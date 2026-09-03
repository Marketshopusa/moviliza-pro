import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import type { SiteCode } from "@/lib/offline";

export const Route = createFileRoute("/_authenticated/movimientos")({
  head: () => ({
    meta: [
      { title: "Historial de movimientos · MovilizaPro" },
      { name: "description", content: "Consulta tus movimientos registrados por fecha, ruta y placa." },
      { property: "og:title", content: "Historial de movimientos · MovilizaPro" },
      { property: "og:description", content: "Historial completo de traslados entre la Base X y las terminales." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HistoryPage,
});

const SITE_LABEL: Record<SiteCode, string> = { X: "BASE X", A: "TERM A", B: "TERM B", C: "TERM C" };

type Row = {
  id: string;
  movement_number: number;
  plate_state: string;
  plate: string;
  vehicle_model: string | null;
  origin: SiteCode;
  destination: SiteCode;
  occurred_at: string;
  status: string;
};

function HistoryPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void supabase
      .from("movements")
      .select("id, movement_number, plate_state, plate, vehicle_model, origin, destination, occurred_at, status")
      .eq("driver_id", user.id)
      .order("occurred_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!active) return;
        setRows((data as Row[]) ?? []);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user?.id]);

  const filtered = useMemo(() => {
    const term = q.trim().toUpperCase();
    if (!term) return rows;
    return rows.filter((r) => `${r.plate_state}-${r.plate} ${r.vehicle_model ?? ""}`.toUpperCase().includes(term));
  }, [rows, q]);

  const grouped = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const key = new Date(r.occurred_at).toLocaleDateString("es-US", { day: "2-digit", month: "long", year: "numeric" });
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <>
      <h1 className="text-lg font-bold uppercase tracking-widest">Historial</h1>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar por placa o modelo"
        className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      {loading && <p className="text-xs text-muted-foreground">Cargando movimientos…</p>}
      {!loading && filtered.length === 0 && <p className="text-xs text-muted-foreground">No hay movimientos.</p>}
      {grouped.map(([day, list]) => (
        <section key={day} className="space-y-2">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {day} · {list.length} movimiento(s)
          </h2>
          <div className="space-y-2">
            {list.map((m) => (
              <div key={m.id} className="bg-card p-3 rounded-lg border border-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="size-10 bg-secondary rounded border border-border grid place-items-center font-mono font-bold text-xs text-muted-foreground">
                    #{String(m.movement_number).padStart(3, "0")}
                  </div>
                  <div>
                    <p className="text-xs font-bold font-mono">
                      {m.plate_state}-{m.plate}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {m.vehicle_model || "Sin modelo"} •{" "}
                      {new Date(m.occurred_at).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-muted-foreground">{SITE_LABEL[m.origin]}</span>
                  <span className="text-border">→</span>
                  <span className="text-[10px] font-bold text-primary">{SITE_LABEL[m.destination]}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
