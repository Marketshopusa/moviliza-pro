import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import type { SiteCode } from "@/lib/offline";

export const Route = createFileRoute("/_authenticated/panel")({
  head: () => ({
    meta: [
      { title: "Panel de supervisión · MovilizaPro" },
      { name: "description", content: "Totales por conductor, terminal y ruta con exportación CSV." },
      { property: "og:title", content: "Panel de supervisión · MovilizaPro" },
      { property: "og:description", content: "Control operativo de movimientos entre Base X y terminales A, B y C." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PanelPage,
});

const SITE_LABEL: Record<SiteCode, string> = { X: "BASE X", A: "TERM A", B: "TERM B", C: "TERM C" };

type Row = {
  id: string;
  movement_number: number;
  driver_id: string;
  plate_state: string;
  plate: string;
  vehicle_model: string | null;
  origin: SiteCode;
  destination: SiteCode;
  dropoff_location: string | null;
  occurred_at: string;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

type NoteRow = { id: string; driver_id: string; body: string; created_at: string };

type LocRow = {
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  is_on_shift: boolean;
  recorded_at: string;
};

function PanelPage() {
  const { isSupervisor, loading } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSupervisor) return;
    let active = true;
    setBusy(true);
    void (async () => {
      const start = new Date(`${from}T00:00:00`).toISOString();
      const end = new Date(`${to}T23:59:59`).toISOString();
      const [{ data: m }, { data: p }, { data: n }] = await Promise.all([
        supabase
          .from("movements")
          .select(
            "id, movement_number, driver_id, plate_state, plate, vehicle_model, origin, destination, dropoff_location, occurred_at",
          )
          .gte("occurred_at", start)
          .lte("occurred_at", end)
          .order("occurred_at", { ascending: false })
          .limit(1000),
        supabase.from("profiles").select("id, full_name, initials"),
        supabase
          .from("driver_notes")
          .select("id, driver_id, body, created_at")
          .gte("created_at", start)
          .lte("created_at", end)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      if (!active) return;
      setRows((m as Row[]) ?? []);
      setNotes((n as NoteRow[]) ?? []);
      const map: Record<string, string> = {};
      for (const row of (p as { id: string; full_name: string; initials: string }[]) ?? []) {
        map[row.id] = row.full_name || row.initials;
      }
      setNames(map);
      setBusy(false);
    })();
    return () => {
      active = false;
    };
  }, [isSupervisor, from, to]);


  const stats = useMemo(() => {
    const byDriver = new Map<string, number>();
    const bySite: Record<SiteCode, { in: number; out: number }> = {
      X: { in: 0, out: 0 },
      A: { in: 0, out: 0 },
      B: { in: 0, out: 0 },
      C: { in: 0, out: 0 },
    };
    for (const r of rows) {
      byDriver.set(r.driver_id, (byDriver.get(r.driver_id) ?? 0) + 1);
      bySite[r.destination].in += 1;
      bySite[r.origin].out += 1;
    }
    return { byDriver: [...byDriver.entries()].sort((a, b) => b[1] - a[1]), bySite };
  }, [rows]);

  function exportCsv() {
    const header = ["numero", "fecha", "conductor", "estado", "placa", "modelo", "origen", "destino", "ubicacion"];
    const lines = rows.map((r) =>
      [
        r.movement_number,
        new Date(r.occurred_at).toLocaleString("es-US"),
        names[r.driver_id] ?? r.driver_id,
        r.plate_state,
        r.plate,
        r.vehicle_model ?? "",
        r.origin,
        r.destination,
        r.dropoff_location ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `movimientos_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p className="text-xs text-muted-foreground">Cargando…</p>;

  if (!isSupervisor)
    return (
      <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
        <h1 className="text-base font-bold uppercase tracking-widest">Acceso restringido</h1>
        <p className="text-xs text-muted-foreground">Este panel es solo para supervisores y administradores.</p>
      </div>
    );

  return (
    <>
      <h1 className="text-lg font-bold uppercase tracking-widest">Panel de supervisión</h1>

      <div className="bg-card border border-border rounded-xl p-4 grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-[10px] font-bold uppercase text-muted-foreground">Desde</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] font-bold uppercase text-muted-foreground">Hasta</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="col-span-2 bg-primary disabled:opacity-50 text-primary-foreground font-bold py-3 rounded-lg uppercase text-xs tracking-widest"
        >
          Exportar CSV ({rows.length})
        </button>
      </div>

      <div className="bg-panel text-panel-foreground rounded-xl p-4 grid grid-cols-4 gap-3">
        {(Object.keys(SITE_LABEL) as SiteCode[]).map((s) => (
          <div key={s}>
            <p className="text-[10px] uppercase text-panel-foreground/50">{SITE_LABEL[s]}</p>
            <p className="font-mono text-sm font-bold">↓{stats.bySite[s].in} ↑{stats.bySite[s].out}</p>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Por conductor</h2>
        {stats.byDriver.map(([id, count]) => (
          <div key={id} className="bg-card border border-border rounded-lg p-3 flex justify-between items-center">
            <span className="text-xs font-semibold">{names[id] ?? "Conductor"}</span>
            <span className="font-mono font-bold text-sm">{String(count).padStart(2, "0")}</span>
          </div>
        ))}
        {stats.byDriver.length === 0 && !busy && (
          <p className="text-xs text-muted-foreground">Sin movimientos en el rango seleccionado.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Movimientos</h2>
        {rows.slice(0, 50).map((m) => (
          <div key={m.id} className="bg-card p-3 rounded-lg border border-border flex items-center justify-between">
            <div>
              <p className="text-xs font-bold font-mono">
                #{String(m.movement_number).padStart(3, "0")} · {m.plate_state}-{m.plate}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {names[m.driver_id] ?? "Conductor"} • {new Date(m.occurred_at).toLocaleString("es-US")}
                {m.dropoff_location ? ` • ${m.dropoff_location}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-muted-foreground">{SITE_LABEL[m.origin]}</span>
              <span className="text-border">→</span>
              <span className="text-[10px] font-bold text-primary">{SITE_LABEL[m.destination]}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Notas privadas de conductores
        </h2>
        {notes.map((n) => (
          <div key={n.id} className="bg-card p-3 rounded-lg border border-border space-y-1">
            <p className="text-[10px] font-bold uppercase text-muted-foreground">
              {names[n.driver_id] ?? "Conductor"} • {new Date(n.created_at).toLocaleString("es-US")}
            </p>
            <p className="text-xs whitespace-pre-wrap">{n.body}</p>
          </div>
        ))}
        {notes.length === 0 && !busy && (
          <p className="text-xs text-muted-foreground">Sin notas en el rango seleccionado.</p>
        )}
      </section>

    </>
  );
}
