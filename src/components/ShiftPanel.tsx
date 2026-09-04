import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { markOffShift } from "@/lib/geo";
import { readPending } from "@/lib/offline";
import { PushToTalk } from "@/components/PushToTalk";

type Shift = { id: string; started_at: string; ended_at: string | null };
type Row = { origin: string; destination: string; occurred_at: string };

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" });
}

export function ShiftPanel() {
  const { user } = useAuth();
  const [shift, setShift] = useState<Shift | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!user) return;
    const [{ data: s }, { data: m }] = await Promise.all([
      supabase.from("shifts").select("id, started_at, ended_at").eq("driver_id", user.id).is("ended_at", null).maybeSingle(),
      supabase
        .from("movements")
        .select("origin, destination, occurred_at")
        .eq("driver_id", user.id)
        .order("occurred_at", { ascending: false })
        .limit(50),
    ]);
    setShift((s as Shift) ?? null);
    setRows((m as Row[]) ?? []);
    setPendingCount(readPending().length);
  }, [user]);

  useEffect(() => {
    void refresh();
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [refresh]);

  const totals = useMemo(() => {
    const today = new Date().toDateString();
    const todays = rows.filter((m) => new Date(m.occurred_at).toDateString() === today);
    return {
      total: todays.length,
      toBase: todays.filter((m) => m.destination === "X").length,
      fromBase: todays.filter((m) => m.origin === "X").length,
    };
  }, [rows]);

  async function cerrarTurno() {
    if (!user) return;
    if (shift) {
      await supabase.from("shifts").update({ ended_at: new Date().toISOString() }).eq("id", shift.id);
    }
    await markOffShift(user.id).catch(() => {});
    await supabase.auth.signOut();
  }

  async function iniciarTurno() {
    if (!user) return;
    await supabase.from("shifts").insert({ driver_id: user.id });
    void refresh();
  }

  return (
    <div className="bg-panel rounded-xl p-5 text-panel-foreground shadow-lg">
      <div className="flex justify-between items-center mb-4 gap-3">
        <PushToTalk />

        <div className="flex flex-col items-end gap-2 shrink-0">
          <span
            className={`text-[10px] font-bold px-2 py-1 rounded border uppercase ${
              online
                ? "bg-green-500/20 text-green-500 border-green-500/40"
                : "bg-accent/20 text-accent border-accent/30"
            }`}
          >
            {online ? "En línea" : `Offline · ${pendingCount}`}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-panel-foreground/50 text-right">
            {shift ? `Turno desde ${hhmm(shift.started_at)}` : "Sin turno"}
          </span>
          {shift ? (
            <button
              onClick={() => void cerrarTurno()}
              className="text-[10px] font-bold uppercase tracking-widest bg-red-600 text-white px-3 py-1.5 rounded"
            >
              Cerrar turno
            </button>
          ) : (
            <button
              onClick={() => void iniciarTurno()}
              className="text-[10px] font-bold uppercase tracking-widest bg-panel-foreground text-panel px-3 py-1.5 rounded"
            >
              Iniciar turno
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 border-t border-panel-foreground/10 pt-4">
        <div>
          <p className="text-panel-foreground/50 text-[10px] uppercase mb-1">Movimientos</p>
          <p className="text-lg font-mono font-bold">{String(totals.total).padStart(2, "0")}</p>
        </div>
        <div>
          <p className="text-panel-foreground/50 text-[10px] uppercase mb-1">Hacia Base X</p>
          <p className="text-lg font-mono font-bold">{String(totals.toBase).padStart(2, "0")}</p>
        </div>
        <div>
          <p className="text-panel-foreground/50 text-[10px] uppercase mb-1">Desde Base X</p>
          <p className="text-lg font-mono font-bold">{String(totals.fromBase).padStart(2, "0")}</p>
        </div>
      </div>
    </div>
  );
}
