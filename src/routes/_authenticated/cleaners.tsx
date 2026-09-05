import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { readVehicleCard } from "@/lib/vehicle-card.functions";
import { detectCardColor } from "@/lib/card-color-detector";
import { saveVehiclePosition } from "@/lib/vehicle-positions.functions";
import { compressImage } from "@/lib/image-compression";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/cleaners")({
  head: () => ({
    meta: [
      { title: "Cleaners · MovilizaPro" },
      { name: "description", content: "Registro de ubicación GPS de vehículos en Base X al estacionarlos." },
      { property: "og:title", content: "Cleaners · MovilizaPro" },
      { property: "og:description", content: "Registro de ubicación GPS de vehículos en Base X al estacionarlos." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CleanersPage,
});

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("No se pudo leer la imagen"));
    r.readAsDataURL(file);
  });
}

function getPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Este teléfono no tiene GPS disponible."));
      return;
    }
    const ok = (pos: GeolocationPosition) =>
      resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    navigator.geolocation.getCurrentPosition(
      ok,
      () => {
        // Reintento con precisión normal si el modo preciso no responde.
        navigator.geolocation.getCurrentPosition(
          ok,
          () => reject(new Error("Activa el GPS del teléfono para guardar la ubicación.")),
          { enableHighAccuracy: false, timeout: 20000, maximumAge: 60_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

function CleanersPage() {
  const { user } = useAuth();
  const [plateState, setPlateState] = useState("FL");
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);

  const cardRef = useRef<HTMLInputElement>(null);
  const ubicacionRef = useRef<HTMLInputElement>(null);
  const readCard = useServerFn(readVehicleCard);
  const savePosition = useServerFn(saveVehiclePosition);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function handleCard(rawFile: File) {
    setScanning(true);
    setScanMsg(null);
    setError(null);
    try {
      const file = await compressImage(rawFile);
      const [dataUrl, clientColor] = await Promise.all([
        fileToDataUrl(file),
        detectCardColor(file),
      ]);
      const res = await readCard({ data: { image: dataUrl, clientColor } });
      if (res.plate) setPlate(res.plate);
      if (res.plate_state) setPlateState(res.plate_state);
      if (res.vehicle_model) setModel(res.vehicle_model);
      if (res.plate && !res.vehicle_model) {
        const { data: veh } = await supabase
          .from("vehicles")
          .select("vehicle_model")
          .eq("plate", res.plate)
          .maybeSingle();
        if (veh?.vehicle_model) setModel(veh.vehicle_model);
      }
      setScanMsg(res.plate ? `Leído: ${res.plate_state ?? ""} ${res.plate}`.trim() : "No se detectó la tarjeta. Intenta de nuevo.");
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "Error al leer la foto");
    } finally {
      setScanning(false);
    }
  }

  async function handleUbicacion(rawFile: File) {
    if (!user) return;
    setSubiendo(true);
    setError(null);
    setOk(null);
    try {
      const file = await compressImage(rawFile);
      const ext = file.name.split(".").pop() || "webp";
      const path = `${user.id}/cleaner-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("vehicle-photos").upload(path, file, { upsert: true });
      if (upErr) throw new Error(upErr.message);
      setPhotoPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al subir la foto");
    } finally {
      setSubiendo(false);
    }
  }

  async function guardar() {
    if (!plate) {
      setError("Escanea la tarjeta: falta la placa.");
      return;
    }
    if (!photoPath) {
      setError("Toma la foto de ubicación del vehículo.");
      return;
    }
    setGuardando(true);
    setError(null);
    setOk(null);
    try {
      const pos = position ?? (await getPosition());
      await savePosition({
        data: {
          plate,
          plate_state: plateState,
          vehicle_model: model || null,
          photo_path: photoPath,
          latitude: pos.lat,
          longitude: pos.lng,
        },
      });
      setOk(`Ubicación guardada: ${plateState} ${plate} quedó registrado en el mapa de Base X.`);
      setPlate("");
      setModel("");
      setPhotoPath(null);
      setScanMsg(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold uppercase tracking-widest">Cleaners</h1>
      <p className="text-xs text-muted-foreground">
        Al estacionar un vehículo en Base X: escanea la tarjeta de la llave y toma la foto de ubicación.
        El GPS guardará el punto exacto para que el driver lo ubique en el mapa.
      </p>

      {/* Paso 1: escanear tarjeta */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">1 · Tarjeta de la llave</h2>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={cardRef}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleCard(f);
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => cardRef.current?.click()}
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
      </div>

      {/* Paso 2: foto de ubicación con GPS */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">2 · Foto de ubicación</h2>
        <p className="text-[11px] text-muted-foreground">
          Tómala parado junto al vehículo ya estacionado. Se guardará el punto GPS exacto.
        </p>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={ubicacionRef}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleUbicacion(f);
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => ubicacionRef.current?.click()}
          disabled={subiendo || !plate}
          className={cn(
            "w-full py-4 rounded-xl font-bold uppercase text-xs tracking-widest border disabled:opacity-60",
            photoPath
              ? "bg-green-600 text-white border-green-600"
              : "bg-primary text-primary-foreground border-primary",
          )}
        >
          {subiendo ? "Subiendo foto…" : photoPath ? "Foto lista ✓ · repetir" : "Tomar foto de ubicación"}
        </button>
        <p className="text-[10px] text-center font-bold uppercase tracking-widest text-muted-foreground">
          {position ? `GPS activo · ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}` : "Buscando señal GPS…"}
        </p>
      </div>

      <button
        type="button"
        onClick={() => void guardar()}
        disabled={guardando || !plate || !photoPath}
        className="w-full py-4 rounded-xl bg-primary text-primary-foreground font-bold uppercase text-xs tracking-widest disabled:opacity-60"
      >
        {guardando ? "Guardando…" : "Guardar ubicación del vehículo"}
      </button>

      {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2">{error}</p>}
      {ok && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-green-600 rounded-lg p-2">{ok}</p>}
    </div>
  );
}
