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
  const { isSupervisor, isAdmin, loading, user } = useAuth();
  const fetchUsers = useServerFn(listUsers);
  const removeUser = useServerFn(deleteUser);
  const changeRole = useServerFn(setUserRole);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [userMsg, setUserMsg] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [locs, setLocs] = useState<LocRow[]>([]);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<LocRow | null>(null);

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
        supabase.from("profiles").select("id, full_name, initials, avatar_url"),
        supabase
          .from("driver_notes")
          .select("id, driver_id, body, created_at")
          .gte("created_at", new Date(new Date(start).getTime() - 30 * 86400_000).toISOString())
          .lte("created_at", end)
          .order("created_at", { ascending: false })
          .limit(200),

      ]);
      if (!active) return;
      setRows((m as Row[]) ?? []);
      setNotes((n as NoteRow[]) ?? []);
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
        (signed ?? []).forEach((s, i) => {
          const owner = withAvatar[i];
          if (owner && s.signedUrl) amap[owner.id] = s.signedUrl;
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
          className="col-span-2 bg-primary disabled:opacity-50 text-primary-foreground font-bold py-3 rounded-lg uppercase text-xs tracking-widest"
        >
          Exportar CSV ({rows.length})
        </button>
      </div>

      {isAdmin && (
        <section className="space-y-2">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Usuarios de la plataforma ({users.length})
          </h2>
          {users.map((u) => (
            <div key={u.id} className="bg-card border border-border rounded-lg p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold truncate">{u.full_name || u.email || u.id}</p>
                <p className="text-[10px] text-muted-foreground truncate">{u.email}</p>
              </div>
              <select
                value={u.role}
                aria-label={`Rol de ${u.full_name || u.email}`}
                onChange={async (e) => {
                  const role = e.target.value as "conductor" | "supervisor" | "administrador";
                  try {
                    await changeRole({ data: { userId: u.id, role } });
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
                disabled={u.id === user?.id}
                onClick={async () => {
                  if (!window.confirm(`¿Eliminar definitivamente la cuenta de ${u.full_name || u.email}?`)) return;
                  try {
                    await removeUser({ data: { userId: u.id } });
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
          ))}
          {userMsg && <p className="text-[10px] text-muted-foreground">{userMsg}</p>}
        </section>
      )}



      <section className="space-y-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
          Notas privadas de conductores
          {notes.length > 0 && (
            <span className="bg-accent text-accent-foreground rounded px-1.5 py-0.5 font-mono">{notes.length}</span>
          )}
        </h2>
        {notes.map((n) => (
          <div key={n.id} className="bg-card p-3 rounded-lg border border-accent/50 space-y-1">
            <div className="flex items-center gap-2">
              <div className="size-7 rounded overflow-hidden bg-panel text-panel-foreground grid place-items-center text-[9px] font-mono font-bold shrink-0">
                {avatars[n.driver_id] ? (
                  <img
                    src={avatars[n.driver_id]}
                    alt={`Foto de ${names[n.driver_id] ?? "conductor"}`}
                    className="size-full object-cover"
                  />
                ) : (
                  (names[n.driver_id] ?? "?").slice(0, 2).toUpperCase()
                )}
              </div>
              <p className="text-[10px] font-bold uppercase text-muted-foreground">
                {names[n.driver_id] ?? "Conductor"} • {new Date(n.created_at).toLocaleString("es-US")}
              </p>
            </div>
            <p className="text-xs whitespace-pre-wrap">{n.body}</p>
          </div>
        ))}
        {notes.length === 0 && !busy && (
          <p className="text-xs text-muted-foreground">Sin notas de conductores en los últimos 30 días.</p>
        )}
      </section>



      <section className="space-y-2">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          GPS de conductores (solo administración)
        </h2>
        {locs.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Aún no hay ubicaciones. El GPS se activa en el teléfono del conductor al iniciar sesión.
          </p>
        )}
        {locs.map((l) => {
          const f = freshnessLabel(l.recorded_at);
          return (
            <button
              key={l.user_id}
              onClick={() => setFocus(focus?.user_id === l.user_id ? null : l)}
              className="w-full text-left bg-card border border-border rounded-lg p-3 flex items-center gap-3"
            >
              <div className="size-9 rounded overflow-hidden bg-panel text-panel-foreground grid place-items-center text-[10px] font-mono font-bold shrink-0">
                {avatars[l.user_id] ? (
                  <img
                    src={avatars[l.user_id]}
                    alt={`Foto de ${names[l.user_id] ?? "conductor"}`}
                    className="size-full object-cover"
                  />
                ) : (
                  (names[l.user_id] ?? "?").slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold truncate">{names[l.user_id] ?? "Conductor"}</p>
                <p className="text-[10px] text-muted-foreground font-mono">
                  {l.latitude.toFixed(5)}, {l.longitude.toFixed(5)}
                  {l.accuracy ? ` · ±${Math.round(l.accuracy)} m` : ""}
                </p>
              </div>
              <span
                className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border ${
                  f.fresh && l.is_on_shift
                    ? "text-primary border-primary/40"
                    : "text-muted-foreground border-border"
                }`}
              >
                {l.is_on_shift ? f.label : "Fuera de turno"}
              </span>
            </button>
          );
        })}
        {focus && (
          <div className="rounded-xl overflow-hidden border border-border">
            <iframe
              title={`Mapa de ${names[focus.user_id] ?? "conductor"}`}
              className="w-full h-64"
              loading="lazy"
              src={`https://www.openstreetmap.org/export/embed.html?bbox=${focus.longitude - 0.005}%2C${focus.latitude - 0.004}%2C${focus.longitude + 0.005}%2C${focus.latitude + 0.004}&layer=mapnik&marker=${focus.latitude}%2C${focus.longitude}`}
            />
            <a
              href={`https://www.google.com/maps?q=${focus.latitude},${focus.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="block bg-card p-2 text-center text-[10px] font-bold uppercase tracking-widest text-primary"
            >
              Abrir en Google Maps
            </a>
          </div>
        )}
      </section>

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




    </>
  );
}
