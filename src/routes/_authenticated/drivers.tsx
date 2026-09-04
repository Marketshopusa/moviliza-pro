import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { readVehicleCard } from "@/lib/vehicle-card.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/drivers")({
  head: () => ({
    meta: [
      { title: "Drivers · MovilizaPro" },
      { name: "description", content: "Mapa de ruta, escaneo de tarjeta y registro de salidas/retornos." },
      { property: "og:title", content: "Drivers · MovilizaPro" },
      { property: "og:description", content: "Mapa de ruta, escaneo de tarjeta y registro de salidas/retornos." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DriversPage,
});

type Tab = "salida" | "retorno";
type DestCode = "A" | "B" | "C" | "X";

const DESTINOS: { code: DestCode; label: string; color: string; text: string; ring: string }[] = [
  { code: "A", label: "Terminal A", color: "bg-yellow-400", text: "text-yellow-900", ring: "ring-yellow-300" },
  { code: "B", label: "Terminal B", color: "bg-green-500", text: "text-white", ring: "ring-green-300" },
  { code: "C", label: "Terminal C", color: "bg-blue-500", text: "text-white", ring: "ring-blue-300" },
  { code: "X", label: "Base X", color: "bg-black", text: "text-white", ring: "ring-gray-500" },
];

function DriversPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("salida");
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [plateState, setPlateState] = useState("FL");
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [destination, setDestination] = useState<DestCode | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const readCard = useServerFn(readVehicleCard);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function handleFile(file: File) {
    setScanning(true);
    setScanMsg(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await readCard({ data: { image: dataUrl } });
      if (res.plate) setPlate(res.plate);
      if (res.plate_state) setPlateState(res.plate_state);
      if (res.vehicle_model) setModel(res.vehicle_model);
      setScanMsg(res.plate ? `Leído: ${res.plate_state} ${res.plate}` : "No se detectó placa. Intenta de nuevo.");
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "Error al leer la foto");
    } finally {
      setScanning(false);
    }
  }

  async function guardarSalida() {
    if (!user || !plate || !destination) {
      setMessage("Completa placa y destino.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("movements").insert({
      driver_id: user.id,
      plate_state: plateState,
      plate,
      vehicle_model: model || null,
      origin: "X",
      destination: destination as "A" | "B" | "C",
      dropoff_location: null,
      latitude: position?.lat ?? null,
      longitude: position?.lng ?? null,
      occurred_at: new Date().toISOString(),
      status: "sincronizado",
      photos: [],
      photo_path: null,
    });
    setBusy(false);
    if (error) {
      setMessage(error.message);
    } else {
      setMessage("Salida registrada.");
      setPlate("");
      setModel("");
      setDestination(null);
    }
  }

  const mapSrc = position
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${position.lng - 0.005}%2C${position.lat - 0.004}%2C${position.lng + 0.005}%2C${position.lat + 0.004}&layer=mapnik&marker=${position.lat}%2C${position.lng}`
    : "https://www.openstreetmap.org/export/embed.html?bbox=-80.35%2C25.75%2C-80.1%2C25.95&layer=mapnik";

  return (
    <div className="space-y-4">
      <ShiftPanel />

      <h1 className="text-lg font-bold uppercase tracking-widest">Drivers</h1>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setTab("salida")}
          className={cn(
            "py-3 rounded-lg text-sm font-bold uppercase tracking-widest border",
            tab === "salida" ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground",
          )}
        >
          Salida
        </button>
        <button
          type="button"
          onClick={() => setTab("retorno")}
          className={cn(
            "py-3 rounded-lg text-sm font-bold uppercase tracking-widest border",
            tab === "retorno" ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground",
          )}
        >
          Retorno
        </button>
      </div>

      <div className="rounded-xl overflow-hidden border border-border bg-card h-[380px]">
        <iframe
          title="Mapa de ruta"
          src={mapSrc}
          className="w-full h-full"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>

      {tab === "salida" ? (
        <section className="bg-card border border-border rounded-xl p-4 space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Ruta de driver</h2>


          <div className="space-y-3">
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
              {scanning ? "Leyendo foto…" : "Escanear tarjeta / placa"}
            </button>
            {scanMsg && <p className="text-xs text-center text-muted-foreground">{scanMsg}</p>}

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Estado</label>
                <input
                  value={plateState}
                  onChange={(e) => setPlateState(e.target.value.toUpperCase())}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-bold uppercase"
                  maxLength={2}
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Placa</label>
                <input
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-bold uppercase tracking-widest"
                  placeholder="ABC123"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Modelo</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="Marca / modelo"
              />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Destino</p>
            <div className="grid grid-cols-4 gap-2">
              {DESTINOS.map((d) => (
                <button
                  key={d.code}
                  type="button"
                  onClick={() => setDestination(d.code)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border p-2 transition-all",
                    destination === d.code ? `ring-2 ${d.ring} border-transparent` : "border-border bg-card",
                  )}
                >
                  <span className={cn("size-10 rounded-full flex items-center justify-center text-sm font-bold", d.color, d.text)}>
                    {d.code}
                  </span>
                  <span className="text-[9px] font-bold uppercase leading-tight text-center">{d.label}</span>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void guardarSalida()}
            disabled={busy || !plate || !destination}
            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-bold uppercase text-xs tracking-widest disabled:opacity-60"
          >
            {busy ? "Guardando…" : "Guardar salida"}
          </button>
        </section>
      ) : (
        <section className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
          <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Retorno</p>
          <p className="text-xs text-muted-foreground">Próximamente: escanea la tarjeta de retorno y selecciona el terminal de origen.</p>
        </section>
      )}

      {message && (
        <p className="text-center text-xs font-bold uppercase tracking-widest text-primary bg-primary/10 rounded-lg p-2">{message}</p>
      )}
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
