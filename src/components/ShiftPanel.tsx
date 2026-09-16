import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { readPending } from "@/lib/offline";
import { PushToTalk } from "@/components/PushToTalk";
import { useDriverShift } from "@/lib/driver-shift-context";
import { countShiftMovements } from "@/lib/driver-shift";

type Row = { origin: string; destination: string; shift_id: string | null };

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" });
}

export function ShiftPanel() {
  const { user } = useAuth();
  const { shift, busy, error, endShift } = useDriverShift();
  const [rows, setRows] = useState<Row[]>([]);
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshRows = useCallback(async () => {
    if (!user || !shift) {
      setRows([]);
      return;
    }
    const { data: m } = await supabase
      .from("movements")
      .select("origin, destination, shift_id")
      .eq("driver_id", user.id)
      .eq("shift_id", shift.id)
      .order("occurred_at", { ascending: false })
      .limit(200);
    setRows((m as Row[]) ?? []);
    setPendingCount(readPending().length);
  }, [user, shift]);

  useEffect(() => {
    void refreshRows();
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [refreshRows]);

  const totals = useMemo(() => (shift ? countShiftMovements(rows, shift.id) : { total: 0, toBase: 0, fromBase: 0 }), [rows, shift]);

  if (!shift) return null;

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
          <span className="text-[10px] font-bold uppercase tracking-wider text-green-500">En turno</span>
          <span className="text-[10px] uppercase tracking-wider text-panel-foreground/50 text-right">
            Desde {hhmm(shift.started_at)}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void endShift()}
            className="text-sm font-bold bg-red-600 text-white px-4 py-2.5 rounded min-h-11 disabled:opacity-60"
          >
            {busy ? "Cerrando…" : "Cerrar turno"}
          </button>
        </div>
      </div>
      {error ? <p className="text-xs text-red-400 mb-3 text-right">{error}</p> : null}
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
