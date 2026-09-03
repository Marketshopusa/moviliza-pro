import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { freshnessLabel } from "@/lib/geo";
import type { SiteCode } from "@/lib/offline";
import { deleteUser, listUsers, setUserRole, type ManagedUser } from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated/panel")({
  head: () => ({
    meta: [
      { title: "Panel de supervisión · MovilizaPro" },
      { name: "description", content: "Totales por conductor, terminal y turno con exportación CSV y PDF." },
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

type NoteRow = { id: string; driver_id: string; body: string; created_at: string };

type ShiftRow = { id: string; driver_id: string; started_at: string; ended_at: string | null };

type LocRow = {
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  is_on_shift: boolean;
  recorded_at: string;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Bloques horarios operativos. Un movimiento pertenece al bloque según su hora local. */
const SHIFT_BLOCKS = [
  { id: "noche", label: "TURNO 6:PM - 2:30AM", start: 18 * 60, end: 2 * 60 + 30 },
  { id: "madrugada", label: "TURNO 2:30AM - 10:00AM", start: 2 * 60 + 30, end: 10 * 60 },
  { id: "dia", label: "TURNO 10:00AM - 6:00PM", start: 10 * 60, end: 18 * 60 },
] as const;

function blockOf(iso: string): (typeof SHIFT_BLOCKS)[number]["id"] {
  const d = new Date(iso);
  const mins = d.getHours() * 60 + d.getMinutes();
  for (const b of SHIFT_BLOCKS) {
    const inBlock = b.start < b.end ? mins >= b.start && mins < b.end : mins >= b.start || mins < b.end;
    if (inBlock) return b.id;
  }
  return "dia";
}

function hhmm(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" }) : "—";
}

function PanelPage() {
  const { isSupervisor, isAdmin, loading, user } = useAuth();
  const fetchUsers = useServerFn(listUsers);
  const removeUser = useServerFn(deleteUser);
  const changeRole = useServerFn(setUserRole);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [userMsg, setUserMsg] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [locs, setLocs] = useState<LocRow[]>([]);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [openDriver, setOpenDriver] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(SHIFT_BLOCKS[0].id);

  useEffect(() => {
    if (!isSupervisor) return;
    let active = true;
    async function load() {
      const { data } = await supabase
        .from("driver_locations")
        .select("user_id, latitude, longitude, accuracy, is_on_shift, recorded_at")
        .order("recorded_at", { ascending: false });
      if (active) setLocs((data as LocRow[]) ?? []);
    }
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [isSupervisor]);

  useEffect(() => {
    if (!isSupervisor) return;
    let active = true;
    setBusy(true);
    void (async () => {
      const start = new Date(`${from}T00:00:00`).toISOString();
      const end = new Date(`${to}T23:59:59`).toISOString();
      const [{ data: m }, { data: p }, { data: n }, { data: s }] = await Promise.all([
        supabase
          .from("movements")
          .select(
            "id, movement_number, driver_id, plate_state, plate, vehicle_model, origin, destination, dropoff_location, occurred_at",
          )
          .gte("occurred_at", start)
          .lte("occurred_at", end)
          .order("occurred_at", { ascending: false })
          .limit(1000),
        supabase.from("profiles").select("id, full_name, initials, avatar_url"),
        supabase
          .from("driver_notes")
          .select("id, driver_id, body, created_at")
          .gte("created_at", new Date(new Date(start).getTime() - 30 * 86400_000).toISOString())
          .lte("created_at", end)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("shifts")
          .select("id, driver_id, started_at, ended_at")
          .gte("started_at", new Date(new Date(start).getTime() - 86400_000).toISOString())
          .lte("started_at", end)
          .order("started_at", { ascending: false })
          .limit(500),
      ]);
      if (!active) return;
      setRows((m as Row[]) ?? []);
      setNotes((n as NoteRow[]) ?? []);
      setShifts((s as ShiftRow[]) ?? []);
      const map: Record<string, string> = {};
      const profs = (p as { id: string; full_name: string; initials: string; avatar_url: string | null }[]) ?? [];
      for (const row of profs) {
        map[row.id] = row.full_name || row.initials;
      }
      setNames(map);
      setBusy(false);
      const withAvatar = profs.filter((r) => r.avatar_url);
      if (withAvatar.length > 0) {
        const { data: signed } = await supabase.storage
          .from("driver-avatars")
          .createSignedUrls(withAvatar.map((r) => r.avatar_url as string), 3600);
        if (!active) return;
        const amap: Record<string, string> = {};
        (signed ?? []).forEach((s2, i) => {
          const owner = withAvatar[i];
          if (owner && s2.signedUrl) amap[owner.id] = s2.signedUrl;
        });
        setAvatars(amap);
      }
    })();
    return () => {
      active = false;
    };
  }, [isSupervisor, from, to]);

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setUsers(await fetchUsers({ data: undefined as never }));
    } catch {
      setUserMsg("No se pudo cargar la lista de usuarios.");
    }
  }, [isAdmin, fetchUsers]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const totals = useMemo(() => {
    const out: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
    const back: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
    let internal = 0;
    for (const r of rows) {
      if (r.origin === "X" && r.destination !== "X") out[r.destination as "A" | "B" | "C"] += 1;
      else if (r.destination === "X" && r.origin !== "X") back[r.origin as "A" | "B" | "C"] += 1;
      else internal += 1;
    }
    return { out, back, internal, total: rows.length };
  }, [rows]);

  const byBlock = useMemo(() => {
    const map: Record<string, Row[]> = {};
    for (const b of SHIFT_BLOCKS) map[b.id] = [];
    for (const r of rows) (map[blockOf(r.occurred_at)] ??= []).push(r);
    return map;
  }, [rows]);

  /** Conductores con actividad o cuenta registrada. */
  const drivers = useMemo(() => {
    const ids = new Set<string>();
    rows.forEach((r) => ids.add(r.driver_id));
    notes.forEach((n) => ids.add(n.driver_id));
    locs.forEach((l) => ids.add(l.user_id));
    users.forEach((u) => ids.add(u.id));
    return [...ids].map((id) => ({
      id,
      name: names[id] ?? users.find((u) => u.id === id)?.full_name ?? "Conductor",
      account: users.find((u) => u.id === id) ?? null,
      movements: rows.filter((r) => r.driver_id === id),
      notes: notes.filter((n) => n.driver_id === id),
      shifts: shifts.filter((s) => s.driver_id === id),
      loc: locs.find((l) => l.user_id === id) ?? null,
    }));
  }, [rows, notes, locs, users, shifts, names]);

  function exportCsv() {
    const header = ["numero", "fecha", "turno", "conductor", "estado", "placa", "modelo", "origen", "destino", "ubicacion"];
    const lines = rows.map((r) =>
      [
        r.movement_number,
        new Date(r.occurred_at).toLocaleString("es-US"),
        SHIFT_BLOCKS.find((b) => b.id === blockOf(r.occurred_at))?.label ?? "",
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

  function exportPdf() {
    window.print();
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
      <div className="text-center space-y-0.5">
        <h1>
          <img src="/moviliza-pro-wordmark.png" alt="MOVILIZA-PRO" className="h-8 w-auto object-contain" width={304} height={26} />
        </h1>
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Panel de supervisión</p>
      </div>

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
          className="bg-primary disabled:opacity-50 text-primary-foreground font-bold py-3 rounded-lg uppercase text-xs tracking-widest"
        >
          CSV ({rows.length})
        </button>
        <button
          onClick={exportPdf}
          disabled={rows.length === 0}
          className="bg-panel disabled:opacity-50 text-panel-foreground font-bold py-3 rounded-lg uppercase text-xs tracking-widest"
        >
          PDF
        </button>
      </div>

      {/* MOVIMIENTOS GENERALES POR TURNO */}
      <section className="bg-card border border-border rounded-xl overflow-hidden">
        <h2 className="px-4 pt-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Movimientos generales
        </h2>
        <div className="flex gap-1 p-3 overflow-x-auto">
          {SHIFT_BLOCKS.map((b) => (
            <button
              key={b.id}
              onClick={() => setTab(b.id)}
              className={`shrink-0 text-[10px] font-bold uppercase tracking-wider px-2.5 py-2 rounded-lg border ${
                tab === b.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary text-muted-foreground border-border"
              }`}
            >
              {b.label} ({byBlock[b.id]?.length ?? 0})
            </button>
          ))}
        </div>
        <div className="px-3 pb-3 space-y-2">
          {(byBlock[tab] ?? []).slice(0, 100).map((m) => (
            <div key={m.id} className="bg-secondary p-3 rounded-lg border border-border flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-bold font-mono">
                  #{String(m.movement_number).padStart(3, "0")} · {m.plate_state}-{m.plate}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {names[m.driver_id] ?? "Conductor"} • {new Date(m.occurred_at).toLocaleString("es-US")}
                  {m.dropoff_location ? ` • ${m.dropoff_location}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-bold text-muted-foreground">{SITE_LABEL[m.origin]}</span>
                <span className="text-border">→</span>
                <span className="text-[10px] font-bold text-primary">{SITE_LABEL[m.destination]}</span>
              </div>
            </div>
          ))}
          {(byBlock[tab]?.length ?? 0) === 0 && !busy && (
            <p className="text-xs text-muted-foreground">Sin movimientos en este turno.</p>
          )}
        </div>
      </section>

      {/* MOVIMIENTOS DIARIOS GENERALES */}
      <section className="bg-panel text-panel-foreground rounded-xl p-4 space-y-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-panel-foreground/60">
          Movimientos diarios generales
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {(["A", "B", "C"] as const).map((t) => (
            <div key={t} className="space-y-0.5">
              <p className="text-[10px] uppercase text-panel-foreground/50">TERM {t}</p>
              <p className="font-mono text-sm font-bold">Salidas ↑{totals.out[t]}</p>
              <p className="font-mono text-sm font-bold">Retornos ↓{totals.back[t]}</p>
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest border-t border-panel-foreground/20 pt-2">
          <span>Salidas base {totals.out.A + totals.out.B + totals.out.C}</span>
          <span>Retornos base {totals.back.A + totals.back.B + totals.back.C}</span>
          <span>Total {totals.total}</span>
        </div>
      </section>

      {/* TARJETA POR CONDUCTOR */}
      <section className="space-y-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Conductores ({drivers.length})
        </h2>
        {drivers.map((d) => {
          const open = openDriver === d.id;
          const f = d.loc ? freshnessLabel(d.loc.recorded_at) : null;
          const lastShift = d.shifts[0];
          return (
            <div key={d.id} className="bg-card border border-border rounded-xl overflow-hidden">
              <button onClick={() => setOpenDriver(open ? null : d.id)} className="w-full text-left p-3 flex items-center gap-3">
                <div className="size-10 rounded overflow-hidden bg-panel text-panel-foreground grid place-items-center text-[10px] font-mono font-bold shrink-0">
                  {avatars[d.id] ? (
                    <img src={avatars[d.id]} alt={`Foto de ${d.name}`} className="size-full object-cover" />
                  ) : (
                    d.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate">{d.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {d.movements.length} mov · {d.notes.length} notas
                    {lastShift ? ` · ${hhmm(lastShift.started_at)}–${hhmm(lastShift.ended_at)}` : ""}
                  </p>
                </div>
                {f && (
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-1 rounded border shrink-0 ${
                      f.fresh && d.loc?.is_on_shift ? "text-primary border-primary/40" : "text-muted-foreground border-border"
                    }`}
                  >
                    {d.loc?.is_on_shift ? f.label : "Fuera de turno"}
                  </span>
                )}
              </button>

              {open && (
                <div className="border-t border-border p-3 space-y-4">
                  {/* Turnos */}
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Turnos</p>
                    {d.shifts.length === 0 && <p className="text-xs text-muted-foreground">Sin turnos registrados.</p>}
                    {d.shifts.slice(0, 5).map((s) => (
                      <p key={s.id} className="text-[11px] font-mono">
                        {new Date(s.started_at).toLocaleDateString("es-US")} · entrada {hhmm(s.started_at)} · salida{" "}
                        {hhmm(s.ended_at)}
                      </p>
                    ))}
                  </div>

                  {/* GPS */}
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Ubicación GPS</p>
                    {!d.loc && <p className="text-xs text-muted-foreground">Sin ubicación registrada.</p>}
                    {d.loc && (
                      <>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {d.loc.latitude.toFixed(5)}, {d.loc.longitude.toFixed(5)}
                          {d.loc.accuracy ? ` · ±${Math.round(d.loc.accuracy)} m` : ""}
                        </p>
                        <div className="rounded-lg overflow-hidden border border-border">
                          <iframe
                            title={`Mapa de ${d.name}`}
                            className="w-full h-48"
                            loading="lazy"
                            src={`https://www.openstreetmap.org/export/embed.html?bbox=${d.loc.longitude - 0.005}%2C${d.loc.latitude - 0.004}%2C${d.loc.longitude + 0.005}%2C${d.loc.latitude + 0.004}&layer=mapnik&marker=${d.loc.latitude}%2C${d.loc.longitude}`}
                          />
                          <a
                            href={`https://www.google.com/maps?q=${d.loc.latitude},${d.loc.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                            className="block bg-secondary p-2 text-center text-[10px] font-bold uppercase tracking-widest text-primary"
                          >
                            Abrir en Google Maps
                          </a>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Notas privadas */}
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Notas privadas</p>
                    {d.notes.length === 0 && <p className="text-xs text-muted-foreground">Sin notas.</p>}
                    {d.notes.map((n) => (
                      <div key={n.id} className="bg-secondary p-2 rounded-lg border border-accent/50">
                        <p className="text-[10px] font-bold uppercase text-muted-foreground">
                          {new Date(n.created_at).toLocaleString("es-US")}
                        </p>
                        <p className="text-xs whitespace-pre-wrap">{n.body}</p>
                      </div>
                    ))}
                  </div>

                  {/* Movimientos del conductor */}
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Movimientos ({d.movements.length})
                    </p>
                    {d.movements.slice(0, 30).map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-mono truncate">
                          #{String(m.movement_number).padStart(3, "0")} {m.plate_state}-{m.plate} ·{" "}
                          {new Date(m.occurred_at).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" })}
                          {m.dropoff_location ? ` · ${m.dropoff_location}` : ""}
                        </p>
                        <span className="text-[10px] font-bold shrink-0">
                          {SITE_LABEL[m.origin]} → <span className="text-primary">{SITE_LABEL[m.destination]}</span>
                        </span>
                      </div>
                    ))}
                    {d.movements.length === 0 && <p className="text-xs text-muted-foreground">Sin movimientos.</p>}
                  </div>

                  {/* Cuenta (solo administradores) */}
                  {isAdmin && d.account && (
                    <div className="border-t border-border pt-3 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] text-muted-foreground truncate">{d.account.email}</p>
                      </div>
                      <select
                        value={d.account.role}
                        aria-label={`Rol de ${d.name}`}
                        onChange={async (e) => {
                          const role = e.target.value as "conductor" | "supervisor" | "administrador";
                          try {
                            await changeRole({ data: { userId: d.id, role } });
                            setUserMsg("Rol actualizado");
                            void loadUsers();
                          } catch {
                            setUserMsg("No se pudo cambiar el rol");
                          }
                        }}
                        className="bg-secondary border border-border rounded px-2 py-1 text-[10px] font-bold uppercase"
                      >
                        <option value="conductor">Driver</option>
                        <option value="supervisor">Supervisor</option>
                        <option value="administrador">Admin</option>
                      </select>
                      <button
                        disabled={d.id === user?.id}
                        onClick={async () => {
                          if (!window.confirm(`¿Eliminar definitivamente la cuenta de ${d.name}?`)) return;
                          try {
                            await removeUser({ data: { userId: d.id } });
                            setUserMsg("Cuenta eliminada");
                            void loadUsers();
                          } catch {
                            setUserMsg("No se pudo eliminar la cuenta");
                          }
                        }}
                        className="text-[10px] font-bold uppercase text-destructive disabled:opacity-30"
                      >
                        Eliminar
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {userMsg && <p className="text-[10px] text-muted-foreground">{userMsg}</p>}
      </section>
    </>
  );
}
