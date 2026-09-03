import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { queueMovement, readPending, syncPending, uploadPhoto, type SiteCode } from "@/lib/offline";

export const Route = createFileRoute("/_authenticated/app")({
  head: () => ({
    meta: [
      { title: "Nuevo movimiento · MovilizaPro" },
      { name: "description", content: "Registra un movimiento con foto, placa, origen y destino." },
      { property: "og:title", content: "Nuevo movimiento · MovilizaPro" },
      { property: "og:description", content: "Registro rápido de movimientos con evidencia fotográfica." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DriverHome,
});

const SITES: SiteCode[] = ["X", "A", "B", "C"];
const SITE_LABEL: Record<SiteCode, string> = { X: "BASE X", A: "TERM A", B: "TERM B", C: "TERM C" };
const STATES = ["FL", "GA", "AL", "SC", "NC", "TX", "NY", "CA"];

type Shift = { id: string; started_at: string; ended_at: string | null };
type MovementRow = {
  id: string;
  movement_number: number;
  plate_state: string;
  plate: string;
  vehicle_model: string | null;
  origin: SiteCode;
  destination: SiteCode;
  occurred_at: string;
};

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" });
}

function DriverHome() {
  const { user, profile } = useAuth();
  const [shift, setShift] = useState<Shift | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState(true);
  const [plateState, setPlateState] = useState("FL");
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [origin, setOrigin] = useState<SiteCode | null>(null);
  const [destination, setDestination] = useState<SiteCode | null>(null);
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    if (!user) return;
    const [{ data: s }, { data: m }] = await Promise.all([
      supabase.from("shifts").select("id, started_at, ended_at").eq("driver_id", user.id).is("ended_at", null).maybeSingle(),
      supabase
        .from("movements")
        .select("id, movement_number, plate_state, plate, vehicle_model, origin, destination, occurred_at")
        .eq("driver_id", user.id)
        .order("occurred_at", { ascending: false })
        .limit(20),
    ]);
    setShift((s as Shift) ?? null);
    setMovements((m as MovementRow[]) ?? []);
    setPendingCount(readPending().length);
  }

  useEffect(() => {
    void refresh();
    const update = () => setPendingCount(readPending().length);
    const goOnline = async () => {
      setOnline(true);
      const n = await syncPending();
      if (n > 0) {
        setMessage(`${n} movimiento(s) sincronizado(s)`);
        void refresh();
      }
    };
    const goOffline = () => setOnline(false);
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    window.addEventListener("movpro:pending", update);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("movpro:pending", update);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const totals = useMemo(() => {
    const today = new Date().toDateString();
    const todays = movements.filter((m) => new Date(m.occurred_at).toDateString() === today);
    return {
      total: todays.length,
      toBase: todays.filter((m) => m.destination === "X").length,
      fromBase: todays.filter((m) => m.origin === "X").length,
    };
  }, [movements]);

  async function toggleShift() {
    if (!user) return;
    if (shift) {
      await supabase.from("shifts").update({ ended_at: new Date().toISOString() }).eq("id", shift.id);
      setMessage("Turno cerrado");
    } else {
      await supabase.from("shifts").insert({ driver_id: user.id });
      setMessage("Turno iniciado");
    }
    void refresh();
  }

  function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setPhoto({ file, preview: URL.createObjectURL(file) });
  }

  function resetForm() {
    setPlate("");
    setModel("");
    setOrigin(null);
    setDestination(null);
    setPhoto(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function readGeo(): Promise<{ lat: number | null; lng: number | null }> {
    if (typeof navigator === "undefined" || !navigator.geolocation)
      return Promise.resolve({ lat: null, lng: null });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ lat: null, lng: null }), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          clearTimeout(timer);
          resolve({ lat: null, lng: null });
        },
      );
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !origin || !destination || !plate.trim() || !photo) return;
    if (origin === destination) {
      setMessage("El origen y el destino no pueden ser iguales");
      return;
    }
    setBusy(true);
    setMessage(null);
    const cleanPlate = plate.trim().toUpperCase().replace(/\s+/g, "");
    const duplicate = movements.find(
      (m) =>
        m.plate === cleanPlate &&
        m.origin === origin &&
        m.destination === destination &&
        Date.now() - new Date(m.occurred_at).getTime() < 5 * 60 * 1000,
    );
    if (duplicate) {
      setBusy(false);
      setMessage("Movimiento duplicado: misma placa y ruta hace menos de 5 minutos");
      return;
    }
    const geo = await readGeo();
    const occurredAt = new Date().toISOString();
    try {
      const photoPath = await uploadPhoto(user.id, photo.file);
      const { error } = await supabase.from("movements").insert({
        driver_id: user.id,
        shift_id: shift?.id ?? null,
        plate_state: plateState,
        plate: cleanPlate,
        vehicle_model: model.trim() || null,
        origin,
        destination,
        occurred_at: occurredAt,
        latitude: geo.lat,
        longitude: geo.lng,
        photo_path: photoPath,
        status: "sincronizado",
      });
      if (error) throw error;
      setMessage(`Registrado: ${plateState}-${cleanPlate} · ${origin} → ${destination}`);
      resetForm();
      void refresh();
    } catch {
      const reader = new FileReader();
      reader.onload = () => {
        queueMovement({
          localId: crypto.randomUUID(),
          driver_id: user.id,
          shift_id: shift?.id ?? null,
          plate_state: plateState,
          plate: cleanPlate,
          vehicle_model: model.trim() || null,
          origin,
          destination,
          occurred_at: occurredAt,
          latitude: geo.lat,
          longitude: geo.lng,
          notes: null,
          photoDataUrl: typeof reader.result === "string" ? reader.result : null,
        });
        setPendingCount(readPending().length);
        setMessage("Sin conexión: guardado y se sincronizará automáticamente");
        resetForm();
      };
      reader.readAsDataURL(photo.file);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = Boolean(plate.trim() && origin && destination && photo && !busy);

  return (
    <>
      <div className="bg-panel rounded-xl p-5 text-panel-foreground shadow-lg">
        <div className="flex justify-between items-start mb-4">
          <div>
            <p className="text-panel-foreground/50 text-xs font-medium uppercase tracking-wider">
              {shift ? "Turno activo" : "Sin turno"}
            </p>
            <p className="text-xl font-bold">{shift ? `Desde ${hhmm(shift.started_at)}` : "Inicia tu turno"}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span
              className={`text-[10px] font-bold px-2 py-1 rounded border uppercase ${online ? "bg-success/20 text-success border-success/30" : "bg-accent/20 text-accent border-accent/30"}`}
            >
              {online ? "En línea" : `Offline · ${pendingCount}`}
            </span>
            <button
              onClick={toggleShift}
              className="text-[10px] font-bold uppercase tracking-widest bg-panel-foreground text-panel px-3 py-1.5 rounded"
            >
              {shift ? "Cerrar turno" : "Iniciar turno"}
            </button>
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

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Nuevo registro</h2>
        <form onSubmit={submit} className="bg-card rounded-xl border border-border p-4 shadow-sm space-y-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full aspect-[3/2] bg-secondary border-2 border-dashed border-border rounded-lg grid place-items-center overflow-hidden"
          >
            {photo ? (
              <img src={photo.preview} alt="Foto del vehículo registrada" className="size-full object-cover" />
            ) : (
              <div className="text-center">
                <div className="size-12 bg-muted rounded-full mx-auto mb-2 grid place-items-center border border-border">
                  <span className="text-muted-foreground text-xs font-bold">FOTO</span>
                </div>
                <span className="text-[10px] font-semibold uppercase text-muted-foreground">Captura obligatoria</span>
              </div>
            )}
          </button>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={pickPhoto} className="hidden" />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-muted-foreground uppercase">Estado placa</label>
              <select
                value={plateState}
                onChange={(e) => setPlateState(e.target.value)}
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-medium outline-none focus:ring-2 focus:ring-ring"
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-muted-foreground uppercase">Nº placa</label>
              <input
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
                placeholder="DM25CV"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold uppercase outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-bold text-muted-foreground uppercase">Marca / modelo</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Toyota Corolla"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-medium outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-muted-foreground uppercase">Origen</label>
              <div className="flex gap-1 flex-wrap">
                {SITES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setOrigin(s)}
                    className={`px-2 py-1 rounded text-[10px] font-bold ${origin === s ? "bg-primary text-primary-foreground" : "bg-secondary border border-border text-muted-foreground"}`}
                  >
                    {SITE_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1 text-right">
              <label className="text-[10px] font-bold text-muted-foreground uppercase">Destino</label>
              <div className="flex gap-1 justify-end flex-wrap">
                {SITES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDestination(s)}
                    className={`px-2 py-1 rounded text-[10px] font-bold ${destination === s ? "bg-accent text-accent-foreground" : "bg-secondary border border-border text-muted-foreground"}`}
                  >
                    {SITE_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {origin && destination && plate && (
            <p className="font-mono text-sm font-bold">
              {plateState}-{plate} · {origin} → {destination} · {profile?.initials}
            </p>
          )}
          {message && <p className="text-xs font-semibold text-primary">{message}</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-bold py-4 rounded-xl transition-all uppercase tracking-widest text-sm"
          >
            {busy ? "Registrando…" : "Registrar movimiento"}
          </button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Historial reciente</h2>
        <div className="space-y-2">
          {movements.slice(0, 5).map((m) => (
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
                    {m.vehicle_model || "Sin modelo"} • {hhmm(m.occurred_at)}
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
          {movements.length === 0 && <p className="text-xs text-muted-foreground">Aún no hay movimientos registrados.</p>}
        </div>
      </section>
    </>
  );
}
