import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { readVehicleCard } from "@/lib/vehicle-card.functions";
import { cn } from "@/lib/utils";
import { ShiftPanel } from "@/components/ShiftPanel";
import { RutaMapaLeaflet } from "@/components/RutaMapaLeaflet";

export const Route = createFileRoute("/_authenticated/drivers")({
  head: () => ({
    meta: [
      { title: "Drivers · MovilizaPro" },
      { name: "description", content: "Escaneo por color, ruta automática y confirmación de llegada por GPS." },
      { property: "og:title", content: "Drivers · MovilizaPro" },
      { property: "og:description", content: "Escaneo por color, ruta automática y confirmación de llegada por GPS." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DriversPage,
});

type Code = "A" | "B" | "C" | "X";
type Mode = "salida" | "retorno";
type Punto = { code: Code; label: string; lat: number; lng: number; color: string; text: string; ring: string; line: string };

/** Puntos operativos reales (áreas de renta SIXT del aeropuerto y base). */
const PUNTOS: Record<Code, Punto> = {
  X: { code: "X", label: "Base X", lat: 28.4506186, lng: -81.3183711, color: "bg-black", text: "text-white", ring: "ring-gray-500", line: "#111827" },
  A: { code: "A", label: "Terminal A", lat: 28.4336994, lng: -81.3106776, color: "bg-yellow-400", text: "text-yellow-900", ring: "ring-yellow-300", line: "#facc15" },
  B: { code: "B", label: "Terminal B", lat: 28.4287389, lng: -81.3082106, color: "bg-green-500", text: "text-white", ring: "ring-green-300", line: "#22c55e" },
  C: { code: "C", label: "Terminal C", lat: 28.4130398, lng: -81.3093816, color: "bg-blue-500", text: "text-white", ring: "ring-blue-300", line: "#3b82f6" },
};

/** Radio permitido para confirmar llegada (metros). */
const RADIO_M = 50;

function distanciaM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function DriversPage() {
  const [open, setOpen] = useState<Mode | null>("salida");

  return (
    <div className="space-y-4">
      <ShiftPanel />

      <h1 className="text-lg font-bold uppercase tracking-widest">Drivers</h1>

      <div className="grid grid-cols-2 gap-2">
        {(["salida", "retorno"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setOpen(open === m ? null : m)}
            className={cn(
              "py-3 rounded-lg text-sm font-bold uppercase tracking-widest border",
              open === m ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {open && <RutaFlow key={open} mode={open} />}
    </div>
  );
}

function RutaFlow({ mode }: { mode: Mode }) {
  const { user } = useAuth();
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [plateState, setPlateState] = useState("FL");
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [terminal, setTerminal] = useState<Code | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropoff, setDropoff] = useState("");
  const [movementId, setMovementId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const readCard = useServerFn(readVehicleCard);

  // En salida el destino es el terminal; en retorno el destino es la base X.
  const origen = mode === "salida" ? PUNTOS.X : terminal ? PUNTOS[terminal] : null;
  const destino = mode === "salida" ? (terminal ? PUNTOS[terminal] : null) : PUNTOS.X;
  const meta = mode === "salida" ? destino : PUNTOS.X;

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function handleFile(file: File) {
    setScanning(true);
    setScanMsg(null);
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await readCard({ data: { image: dataUrl } });
      if (res.plate) setPlate(res.plate);
      if (res.plate_state) setPlateState(res.plate_state);
      if (res.vehicle_model) setModel(res.vehicle_model);
      if (res.terminal && res.terminal !== "X") setTerminal(res.terminal);
      // Autocompleta el modelo desde el registro interno de vehículos.
      if (res.plate && !res.vehicle_model) {
        const { data: veh } = await supabase
          .from("vehicles")
          .select("vehicle_model")
          .eq("plate", res.plate)
          .maybeSingle();
        if (veh?.vehicle_model) setModel(veh.vehicle_model);
      }
      const partes: string[] = [];
      if (res.plate) partes.push(`${res.plate_state ?? ""} ${res.plate}`.trim());
      if (res.terminal && res.terminal !== "X") partes.push(`color ${res.card_color} → Terminal ${res.terminal}`);
      setScanMsg(partes.length ? `Leído: ${partes.join(" · ")}` : "No se detectó la tarjeta. Intenta de nuevo.");
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "Error al leer la foto");
    } finally {
      setScanning(false);
    }
  }

  async function registrar() {
    if (!user || !plate || !terminal) {
      setError("Escanea la tarjeta: falta placa o terminal.");
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("movements")
      .insert({
        driver_id: user.id,
        plate_state: plateState,
        plate,
        vehicle_model: model || null,
        origin: mode === "salida" ? "X" : terminal,
        destination: mode === "salida" ? terminal : "X",
        dropoff_location: dropoff || null,
        latitude: position?.lat ?? null,
        longitude: position?.lng ?? null,
        occurred_at: new Date().toISOString(),
        status: "sincronizado",
        photos: [],
        photo_path: null,
      })
      .select("id")
      .single();
    setBusy(false);
    if (err) setError(err.message);
    else {
      setMovementId(data.id);
      setMessage(mode === "salida" ? "Salida registrada. Confirma la llegada al terminal." : "Retorno registrado. Confirma la llegada a la base.");
    }
  }

  const distancia = position && meta ? distanciaM(position, meta) : null;
  const enSitio = distancia !== null && distancia <= RADIO_M;

  async function confirmarLlegada() {
    if (!meta) return;
    if (!position) {
      setError("No estás en la ubicación correcta: activa el GPS.");
      return;
    }
    if (!enSitio) {
      setError(`No estás en la ubicación correcta (${Math.round(distancia ?? 0)} m de ${meta.label}).`);
      return;
    }
    if (!movementId) {
      setError("Primero registra el movimiento.");
      return;
    }
    setBusy(true);
    const { error: err } = await supabase
      .from("movements")
      .update({
        dropoff_location: dropoff || null,
        notes: `Llegada confirmada por GPS en ${meta.label}`,
        latitude: position.lat,
        longitude: position.lng,
      })
      .eq("id", movementId);
    setBusy(false);
    if (err) setError(err.message);
    else {
      setError(null);
      setMessage(`Llegada confirmada en ${meta.label}.`);
      setPlate("");
      setModel("");
      setDropoff("");
      setTerminal(null);
      setMovementId(null);
    }
  }

  return (
    <section className="space-y-4">
      <RutaMapa origen={origen} destino={destino} yo={position} />

      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
          Ruta de driver · {mode === "salida" ? "Salida desde Base X" : "Retorno a Base X"}
        </h2>

        <div className="grid grid-cols-3 gap-2">
          {(["A", "B", "C"] as Code[]).map((c) => {
            const p = PUNTOS[c];
            return (
              <div
                key={c}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl border p-2",
                  terminal === c ? `ring-2 ${p.ring} border-transparent` : "border-border",
                )}
              >
                <span className={cn("size-9 rounded-full flex items-center justify-center text-sm font-bold", p.color, p.text)}>{c}</span>
                <span className="text-[9px] font-bold uppercase text-center leading-tight">{p.label}</span>
              </div>
            );
          })}
        </div>

        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={fileRef}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={scanning}
          className="w-full py-4 rounded-xl bg-accent text-accent-foreground font-bold uppercase text-xs tracking-widest disabled:opacity-60"
        >
          {scanning ? "Leyendo tarjeta…" : "Escanear tarjeta / placa"}
        </button>
        {scanMsg && <p className="text-xs text-center text-muted-foreground">{scanMsg}</p>}

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Estado</label>
            <input
              value={plateState}
              onChange={(e) => setPlateState(e.target.value.toUpperCase())}
              maxLength={2}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-bold uppercase"
            />
          </div>
          <div className="col-span-2">
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Placa</label>
            <input
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder="ABC123"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-bold uppercase tracking-widest"
            />
          </div>
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Modelo</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Marca / modelo"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {mode === "salida" ? "Sección donde lo dejas (ej. D19)" : "Área en base (cleaners, shop, tire, oil)"}
          </label>
          <input
            value={dropoff}
            onChange={(e) => setDropoff(e.target.value.toUpperCase())}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm uppercase"
          />
        </div>

        <button
          type="button"
          onClick={() => void registrar()}
          disabled={busy || !plate || !terminal || !!movementId}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-bold uppercase text-xs tracking-widest disabled:opacity-60"
        >
          {busy ? "Guardando…" : mode === "salida" ? "Registrar salida" : "Registrar retorno"}
        </button>

        <button
          type="button"
          onClick={() => void confirmarLlegada()}
          disabled={busy || !enSitio || !movementId}
          className={cn(
            "w-full py-4 rounded-xl font-bold uppercase text-xs tracking-widest",
            enSitio && movementId ? "bg-green-600 text-white" : "bg-muted text-muted-foreground",
          )}
        >
          Llegada
        </button>
        {meta && distancia !== null && (
          <p className={cn("text-center text-[11px] font-bold uppercase tracking-widest", enSitio ? "text-green-700" : "text-muted-foreground")}>
            {enSitio ? `Estás en ${meta.label}` : `A ${Math.round(distancia)} m de ${meta.label}`}
          </p>
        )}

        {error && (
          <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2">{error}</p>
        )}
        {message && !error && (
          <p className="text-center text-xs font-bold uppercase tracking-widest text-primary bg-primary/10 rounded-lg p-2">{message}</p>
        )}
      </div>
    </section>
  );
}

/** Mapa con la ruta pintada del color del terminal. */
function RutaMapa({
  origen,
  destino,
  yo,
}: {
  origen: Punto | null;
  destino: Punto | null;
  yo: { lat: number; lng: number } | null;
}) {
  const pts = [origen, destino].filter(Boolean) as Punto[];
  const lats = [...pts.map((p) => p.lat), ...(yo ? [yo.lat] : [])];
  const lngs = [...pts.map((p) => p.lng), ...(yo ? [yo.lng] : [])];
  const pad = 0.006;
  const minLat = (lats.length ? Math.min(...lats) : 28.42) - pad;
  const maxLat = (lats.length ? Math.max(...lats) : 28.46) + pad;
  const minLng = (lngs.length ? Math.min(...lngs) : -81.33) - pad;
  const maxLng = (lngs.length ? Math.max(...lngs) : -81.3) + pad;

  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${minLng}%2C${minLat}%2C${maxLng}%2C${maxLat}&layer=mapnik`;
  const xy = (p: { lat: number; lng: number }) => ({
    x: ((p.lng - minLng) / (maxLng - minLng)) * 100,
    y: ((maxLat - p.lat) / (maxLat - minLat)) * 100,
  });

  return (
    <div className="relative rounded-xl overflow-hidden border border-border bg-card h-[380px]">
      <iframe title="Mapa de ruta" src={src} className="w-full h-full" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 w-full h-full">
        {origen && destino && (
          <line
            x1={xy(origen).x}
            y1={xy(origen).y}
            x2={xy(destino).x}
            y2={xy(destino).y}
            stroke={destino.code === "X" ? origen.line : destino.line}
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="pointer-events-none absolute inset-0">
        {pts.map((p) => {
          const c = xy(p);
          return (
            <span
              key={p.code}
              style={{ left: `${c.x}%`, top: `${c.y}%` }}
              className={cn(
                "absolute -translate-x-1/2 -translate-y-1/2 size-7 rounded-full border-2 border-white shadow flex items-center justify-center text-[11px] font-bold",
                p.color,
                p.text,
              )}
            >
              {p.code}
            </span>
          );
        })}
        {yo && (
          <span
            style={{ left: `${xy(yo).x}%`, top: `${xy(yo).y}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 size-3 rounded-full bg-sky-500 border-2 border-white shadow"
          />
        )}
      </div>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
}
