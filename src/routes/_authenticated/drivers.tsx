import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { readVehicleCard, readParkingPhoto } from "@/lib/vehicle-card.functions";
import { getVehiclePosition, type VehiclePosition } from "@/lib/vehicle-positions.functions";
import { cn } from "@/lib/utils";
import { ShiftPanel } from "@/components/ShiftPanel";
import { RutaMapaLeaflet } from "@/components/RutaMapaLeaflet";
import { VehicleSpotMap } from "@/components/VehicleSpotMap";

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
  const [open, setOpen] = useState<Mode | null>(null);

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

/** Opciones de servicio/parqueo en la base (retorno). */
const SERVICIOS = ["Limpieza general", "Change oil", "Tire", "Glas", "Shop", "Special cleaner"] as const;
type Servicio = (typeof SERVICIOS)[number];

function RutaFlow({ mode }: { mode: Mode }) {
  const { user } = useAuth();
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [plateState, setPlateState] = useState("FL");
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [terminal, setTerminal] = useState<Code | null>(null);
  const [revisado, setRevisado] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [movementId, setMovementId] = useState<string | null>(null);

  // Última ubicación guardada del vehículo en Base X (registrada por cleaners).
  const [vehPos, setVehPos] = useState<VehiclePosition | null>(null);

  // Retorno: servicio elegido y sus dos fotos (ubicación del carro y llave).
  const [servicio, setServicio] = useState<Servicio | null>(null);
  const [pendiente, setPendiente] = useState<Servicio | null>(null);
  const [fotoUbicacion, setFotoUbicacion] = useState<string | null>(null);
  const [fotoLlave, setFotoLlave] = useState<string | null>(null);
  // Todas las fotos tomadas durante la ruta (incluidas las usadas para escanear).
  const [fotos, setFotos] = useState<string[]>([]);
  const [subiendo, setSubiendo] = useState<"ubicacion" | "llave" | null>(null);

  // Llegada: foto del número de parqueo y foto de verificación (pantalla del teléfono).
  const [spot, setSpot] = useState("");
  const [verifSpot, setVerifSpot] = useState("");
  const [verifTerminal, setVerifTerminal] = useState<Code | null>(null);
  const [leyendo, setLeyendo] = useState<"spot" | "verif" | null>(null);

  const cardRef = useRef<HTMLInputElement>(null);
  const spotRef = useRef<HTMLInputElement>(null);
  const verifRef = useRef<HTMLInputElement>(null);
  const ubicacionRef = useRef<HTMLInputElement>(null);
  const llaveRef = useRef<HTMLInputElement>(null);
  const readCard = useServerFn(readVehicleCard);
  const readSpot = useServerFn(readParkingPhoto);
  const fetchVehPos = useServerFn(getVehiclePosition);

  // En salida el destino es el terminal; en retorno el destino es la base X.
  const origen = mode === "salida" ? PUNTOS.X : terminal ? PUNTOS[terminal] : null;
  const destino = mode === "salida" ? (terminal ? PUNTOS[terminal] : null) : PUNTOS.X;
  const meta = mode === "salida" ? destino : PUNTOS.X;
  const terminalEsperado: Code | null = mode === "salida" ? terminal : "X";

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  /** Guarda en el sistema cualquier foto tomada (también las usadas para escanear). */
  async function archivarFoto(file: File, kind: string): Promise<string | null> {
    if (!user) return null;
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${user.id}/${Date.now()}-${kind}.${ext}`;
      const { error: upErr } = await supabase.storage.from("vehicle-photos").upload(path, file, { upsert: true });
      if (upErr) return null;
      setFotos((prev) => [...prev, path]);
      if (movementId) {
        const nuevas = [...fotos, path];
        void supabase
          .from("movements")
          .update({ photos: nuevas, photo_path: nuevas[0] ?? null })
          .eq("id", movementId);
      }
      return path;
    } catch {
      return null;
    }
  }

  async function handleCard(file: File) {
    setScanning(true);
    setScanMsg(null);
    setError(null);
    try {
      void archivarFoto(file, "tarjeta");
      const dataUrl = await fileToDataUrl(file);
      const res = await readCard({ data: { image: dataUrl } });
      if (res.plate) setPlate(res.plate);
      if (res.plate_state) setPlateState(res.plate_state);
      if (res.vehicle_model) setModel(res.vehicle_model);
      if (res.terminal && res.terminal !== "X") setTerminal(res.terminal);
      if (res.plate && !res.vehicle_model) {
        const { data: veh } = await supabase
          .from("vehicles")
          .select("vehicle_model")
          .eq("plate", res.plate)
          .maybeSingle();
        if (veh?.vehicle_model) setModel(veh.vehicle_model);
      }
      if (res.plate) {
        try {
          setVehPos(await fetchVehPos({ data: { plate: res.plate } }));
        } catch {
          setVehPos(null);
        }
      } else {
        setVehPos(null);
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

  async function handleSpotPhoto(file: File, kind: "spot" | "verif") {
    setLeyendo(kind);
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await readSpot({ data: { image: dataUrl } });
      if (kind === "spot") {
        setSpot(res.spot ?? "");
        if (!res.spot) setError("No se pudo leer el número de parqueo. Repite la foto.");
      } else {
        setVerifSpot(res.spot ?? "");
        setVerifTerminal(res.terminal);
        if (!res.spot && !res.terminal) setError("No se pudo leer la pantalla. Repite la foto de verificación.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al leer la foto");
    } finally {
      setLeyendo(null);
    }
  }

  // Retorno: al elegir un servicio se abre la cámara (1. ubicación del carro, 2. llave).
  function elegirServicio(s: Servicio) {
    setPendiente(s);
    setError(null);
    ubicacionRef.current?.click();
  }

  async function subirFotoServicio(file: File, kind: "ubicacion" | "llave") {
    if (!user) return;
    setSubiendo(kind);
    setError(null);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${user.id}/${Date.now()}-${kind}.${ext}`;
      const { error: upErr } = await supabase.storage.from("vehicle-photos").upload(path, file, { upsert: true });
      if (upErr) throw new Error(upErr.message);
      if (kind === "ubicacion") {
        setFotoUbicacion(path);
        setSubiendo(null);
        llaveRef.current?.click();
        return;
      }
      setFotoLlave(path);
      setServicio(pendiente);
      setPendiente(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al subir la foto");
      setPendiente(null);
    } finally {
      setSubiendo(null);
    }
  }

  async function iniciarRuta() {
    if (!user || !plate) {
      setError("Escanea la tarjeta: falta la placa.");
      return;
    }
    if (mode === "salida" && !terminal) {
      setError("Escanea la tarjeta: falta el terminal.");
      return;
    }
    if (mode === "salida" && !revisado) {
      setError("Confirma con OK que el vehículo está en condiciones para salir.");
      return;
    }
    setBusy(true);
    setError(null);
    const fotos: string[] = [];

    const { data, error: err } = await supabase
      .from("movements")
      .insert({
        driver_id: user.id,
        plate_state: plateState,
        plate,
        vehicle_model: model || null,
        origin: mode === "salida" ? "X" : terminal ?? "X",
        destination: mode === "salida" ? terminal! : "X",
        dropoff_location: null,
        latitude: position?.lat ?? null,
        longitude: position?.lng ?? null,
        occurred_at: new Date().toISOString(),
        status: "sincronizado",
        notes:
          mode === "salida"
            ? "Vehículo revisado OK antes de iniciar ruta"
            : "Retorno hacia Base X",

        photos: fotos,
        photo_path: fotos[0] ?? null,
      })
      .select("id")
      .single();
    setBusy(false);
    if (err) setError(err.message);
    else {
      setMovementId(data.id);
      setMessage(mode === "salida" ? "Ruta iniciada hacia el terminal." : "Ruta iniciada hacia la base.");
    }
  }

  const distancia = position && meta ? distanciaM(position, meta) : null;
  const enSitio = distancia !== null && distancia <= RADIO_M;
  const coincide =
    !!spot && !!verifSpot && spot === verifSpot && (!verifTerminal || verifTerminal === terminalEsperado);

  async function confirmarLlegada() {
    if (!meta || !movementId) return;
    if (!position || !enSitio) {
      setError(`No estás en la ubicación correcta (${Math.round(distancia ?? 0)} m de ${meta.label}).`);
      return;
    }
    if (mode === "retorno") {
      if (!servicio || !fotoUbicacion || !fotoLlave) {
        setError("Elige el área en la base y toma las dos fotos (parqueo y llave).");
        return;
      }
    } else {
      if (!spot || !verifSpot) {
        setError("Toma las dos fotos: número de parqueo y verificación.");
        return;
      }
      if (spot !== verifSpot) {
        setError(`Error: el parqueo de la foto (${spot}) no coincide con el registrado en el teléfono (${verifSpot}). Corrige el registro.`);
        return;
      }
      if (verifTerminal && verifTerminal !== terminalEsperado) {
        setError(
          `Error de terminal: el teléfono registra Terminal ${verifTerminal} y este movimiento va al Terminal ${terminalEsperado}. Corrige el registro.`,
        );
        return;
      }
    }
    setBusy(true);
    const fotosLlegada = mode === "retorno" ? [fotoUbicacion!, fotoLlave!] : [];
    const { error: err } = await supabase
      .from("movements")
      .update({
        dropoff_location: mode === "retorno" ? servicio : spot,
        notes:
          mode === "retorno"
            ? `Llegada a Base X · área: ${servicio} (fotos parqueo y llave)`
            : `Llegada confirmada por GPS en ${meta.label} · parqueo ${spot} verificado`,
        ...(mode === "retorno" ? { photos: fotosLlegada, photo_path: fotosLlegada[0] } : {}),
        latitude: position.lat,
        longitude: position.lng,
      })
      .eq("id", movementId);
    setBusy(false);
    if (err) setError(err.message);
    else {
      setError(null);
      setMessage(
        mode === "retorno"
          ? `Llegada confirmada en Base X · ${servicio}.`
          : `Llegada confirmada en ${meta.label}, parqueo ${spot}.`,
      );

      setPlate("");
      setModel("");
      setTerminal(null);
      setRevisado(false);
      setMovementId(null);
      setVehPos(null);
      setSpot("");
      setVerifSpot("");
      setVerifTerminal(null);
      setServicio(null);
      setPendiente(null);
      setFotoUbicacion(null);
      setFotoLlave(null);
    }
  }

  return (
    <section className="space-y-4">
      {/* Paso 1: menú desplegable con la cámara y los datos de la tarjeta */}
      {!movementId && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            {mode === "salida" ? "Salida desde Base X" : "Retorno a Base X"}
          </h2>

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
            {scanning ? "Leyendo tarjeta…" : "Tomar foto de la tarjeta / placa"}
          </button>
          {scanMsg && <p className="text-xs text-center text-muted-foreground">{scanMsg}</p>}

          {mode === "salida" && terminal && (
            <div className="flex items-center justify-center gap-2">
              <span className={cn("size-9 rounded-full flex items-center justify-center text-sm font-bold", PUNTOS[terminal].color, PUNTOS[terminal].text)}>
                {terminal}
              </span>
              <span className="text-[11px] font-bold uppercase tracking-widest">{PUNTOS[terminal].label}</span>
            </div>
          )}

          {mode === "retorno" && (
            <div className="flex items-center justify-center gap-2">
              <span className="size-9 rounded-full flex items-center justify-center text-sm font-bold bg-black text-white">X</span>
              <span className="text-[11px] font-bold uppercase tracking-widest">Retorno a Base X</span>
            </div>
          )}

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

          {vehPos && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Ubicación del vehículo en Base X ·{" "}
                {new Date(vehPos.created_at).toLocaleString("es-US", { dateStyle: "short", timeStyle: "short" })}
              </p>
              <VehicleSpotMap
                lat={vehPos.latitude}
                lng={vehPos.longitude}
                label={`${vehPos.plate_state ?? ""} ${vehPos.plate}`.trim()}
                yo={position}
              />
              {position && (
                <p className="text-[10px] text-center font-bold uppercase tracking-widest text-muted-foreground">
                  El vehículo está a {Math.round(distanciaM(position, { lat: vehPos.latitude, lng: vehPos.longitude }))} m de ti
                </p>
              )}
            </div>
          )}

          {mode === "salida" && (
            <button
              type="button"
              onClick={() => setRevisado((v) => !v)}
              className={cn(
                "w-full py-3 rounded-xl font-bold uppercase text-xs tracking-widest border",
                revisado ? "bg-green-600 text-white border-green-600" : "bg-background text-muted-foreground border-border",
              )}
            >
              {revisado ? "OK · Vehículo revisado" : "OK · Confirmar gasolina, limpieza y sin daños"}
            </button>
          )}

          {mode === "retorno" && (
            <p className="text-[10px] font-bold uppercase tracking-widest text-center text-muted-foreground">
              El área de la base se elige al llegar
            </p>
          )}

          <button
            type="button"
            onClick={() => void iniciarRuta()}
            disabled={busy || !plate || (mode === "salida" ? !terminal || !revisado : false)}

            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-bold uppercase text-xs tracking-widest disabled:opacity-60"
          >
            {busy ? "Guardando…" : "Iniciar ruta"}
          </button>

          {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2">{error}</p>}
        </div>
      )}

      {/* Paso 2: ruta activa con mapa y confirmación de llegada */}
      {movementId && (
        <>
          <RutaMapaLeaflet puntos={Object.values(PUNTOS)} origen={origen} destino={destino} yo={position} />

          <div className="bg-card border border-border rounded-xl p-4 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Ruta de driver · {mode === "salida" ? `Base X → ${destino?.label ?? ""}` : `${origen?.label ?? ""} → Base X`}
            </h2>
            <p className="text-xs text-muted-foreground">
              {plateState} {plate} {model ? `· ${model}` : ""}
            </p>

            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={spotRef}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleSpotPhoto(f, "spot");
                e.currentTarget.value = "";
              }}
            />
            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={verifRef}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleSpotPhoto(f, "verif");
                e.currentTarget.value = "";
              }}
            />
            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={ubicacionRef}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void subirFotoServicio(f, "ubicacion");
                e.currentTarget.value = "";
              }}
            />
            <input
              type="file"
              accept="image/*"
              capture="environment"
              ref={llaveRef}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void subirFotoServicio(f, "llave");
                e.currentTarget.value = "";
              }}
            />

            {mode === "retorno" ? (
              <div className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {enSitio
                    ? "Elige el área donde dejas el carro · se abre la cámara (parqueo y llave)"
                    : "Al llegar a la Base X podrás elegir el área"}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {SERVICIOS.map((s) => {
                    const activo = servicio === s;
                    const enProceso = pendiente === s;
                    const principal = s === "Limpieza general";
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => elegirServicio(s)}
                        disabled={!enSitio || subiendo !== null}
                        className={cn(
                          "py-3 rounded-xl font-bold uppercase text-[11px] tracking-widest border disabled:opacity-50",
                          principal && "col-span-2",
                          activo
                            ? "bg-green-600 text-white border-green-600"
                            : enProceso
                              ? "bg-accent text-accent-foreground border-accent"
                              : "bg-background text-muted-foreground border-border",
                        )}
                      >
                        {enProceso
                          ? subiendo === "llave"
                            ? "Foto de la llave…"
                            : "Foto del parqueo…"
                          : activo
                            ? `${s} ✓`
                            : s}
                      </button>
                    );
                  })}
                </div>
                {servicio && fotoUbicacion && fotoLlave && (
                  <p className="text-center text-[11px] font-bold uppercase tracking-widest text-green-700 bg-green-600/10 rounded-lg p-2">
                    {servicio} · fotos listas (parqueo + llave)
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => spotRef.current?.click()}
                    disabled={leyendo !== null}
                    className="py-3 rounded-xl bg-accent text-accent-foreground font-bold uppercase text-[11px] tracking-widest disabled:opacity-60"
                  >
                    {leyendo === "spot" ? "Leyendo…" : spot ? `Parqueo ${spot}` : "Foto del parqueo"}
                  </button>
                  <button
                    type="button"
                    onClick={() => verifRef.current?.click()}
                    disabled={leyendo !== null}
                    className="py-3 rounded-xl bg-accent text-accent-foreground font-bold uppercase text-[11px] tracking-widest disabled:opacity-60"
                  >
                    {leyendo === "verif" ? "Leyendo…" : verifSpot || verifTerminal ? `Verif. ${verifSpot}${verifTerminal ? ` · ${verifTerminal}` : ""}` : "Foto verificación"}
                  </button>
                </div>

                {spot && verifSpot && (
                  <p
                    className={cn(
                      "text-center text-[11px] font-bold uppercase tracking-widest rounded-lg p-2",
                      coincide ? "text-green-700 bg-green-600/10" : "text-white bg-red-600",
                    )}
                  >
                    {coincide
                      ? `Verificado: ${spot} en Terminal ${terminalEsperado}`
                      : `No coincide: parqueo ${spot} vs ${verifSpot}${verifTerminal ? ` · Terminal ${verifTerminal}` : ""}. Corrige el registro.`}
                  </p>
                )}
              </>
            )}

            <button
              type="button"
              onClick={() => void confirmarLlegada()}
              disabled={busy || !enSitio || (mode === "retorno" ? !servicio || !fotoUbicacion || !fotoLlave : !coincide)}
              className={cn(
                "w-full py-4 rounded-xl font-bold uppercase text-xs tracking-widest",
                enSitio && (mode === "retorno" ? !!servicio && !!fotoUbicacion && !!fotoLlave : coincide)
                  ? "bg-green-600 text-white"
                  : "bg-muted text-muted-foreground",
              )}
            >
              Llegada
            </button>


            {meta && distancia !== null && (
              <p className={cn("text-center text-[11px] font-bold uppercase tracking-widest", enSitio ? "text-green-700" : "text-muted-foreground")}>
                {enSitio ? `Estás en ${meta.label}` : `A ${Math.round(distancia)} m de ${meta.label}`}
              </p>
            )}

            {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2">{error}</p>}
            {message && !error && (
              <p className="text-center text-xs font-bold uppercase tracking-widest text-primary bg-primary/10 rounded-lg p-2">{message}</p>
            )}
          </div>
        </>
      )}
    </section>
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
