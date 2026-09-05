import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { readVehicleCard, readParkingPhoto } from "@/lib/vehicle-card.functions";
import { detectCardColor } from "@/lib/card-color-detector";
import { getVehiclePosition, type VehiclePosition } from "@/lib/vehicle-positions.functions";
import { cn } from "@/lib/utils";
import { ShiftPanel } from "@/components/ShiftPanel";
import { RutaMapaLeaflet } from "@/components/RutaMapaLeaflet";
import { VehicleSpotMap } from "@/components/VehicleSpotMap";
import { compressImage } from "@/lib/image-compression";

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

/**
 * Radio permitido para confirmar llegada (metros).
 * La base X es un lote grande y los terminales tienen varios niveles de parqueo,
 * por eso cada punto tiene su propio radio.
 */
const RADIO_POR_PUNTO: Record<Code, number> = { X: 300, A: 150, B: 150, C: 150 };
/** Tolerancia extra según la precisión que reporte el teléfono. */
const TOLERANCIA_MAX_M = 120;

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
  const [accuracy, setAccuracy] = useState<number | null>(null);
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

  // Selector manual de emergencia (exclusivo para fallas de cámara o tarjeta ilegible)
  const [showManualOverride, setShowManualOverride] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);
  const [manualReason, setManualReason] = useState("");

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
    const ids: number[] = [];
    const ok = (pos: GeolocationPosition) => {
      setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setAccuracy(pos.coords.accuracy ?? null);
    };
    ids.push(
      navigator.geolocation.watchPosition(
        ok,
        () => {
          // Si el GPS de alta precisión falla (interiores), seguimos con precisión normal.
          ids.push(
            navigator.geolocation.watchPosition(ok, () => {}, {
              enableHighAccuracy: false,
              maximumAge: 60_000,
            }),
          );
        },
        { enableHighAccuracy: true, maximumAge: 20_000 },
      ),
    );
    return () => ids.forEach((id) => navigator.geolocation.clearWatch(id));
  }, []);

  /** Guarda en el sistema cualquier foto tomada (también las usadas para escanear), comprimida a máx 1280px / ~120KB. */
  async function archivarFoto(rawFile: File, kind: string): Promise<string | null> {
    if (!user) return null;
    try {
      const file = await compressImage(rawFile);
      const ext = file.name.split(".").pop() || "webp";
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

  async function handleCard(rawFile: File) {
    setScanning(true);
    setScanMsg(null);
    setError(null);
    try {
      const file = await compressImage(rawFile);
      void archivarFoto(file, "tarjeta");
      const [dataUrl, clientColor] = await Promise.all([
        fileToDataUrl(file),
        detectCardColor(file),
      ]);
      const res = await readCard({ data: { image: dataUrl, clientColor } });
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

  async function handleSpotPhoto(rawFile: File, kind: "spot" | "verif") {
    setLeyendo(kind);
    setError(null);
    try {
      const file = await compressImage(rawFile);
      void archivarFoto(file, kind === "spot" ? "parqueo" : "verificacion");
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

  async function subirFotoServicio(rawFile: File, kind: "ubicacion" | "llave") {
    if (!user) return;
    setSubiendo(kind);
    setError(null);
    try {
      const file = await compressImage(rawFile);
      const ext = file.name.split(".").pop() || "webp";
      const path = `${user.id}/${Date.now()}-${kind}.${ext}`;
      const { error: upErr } = await supabase.storage.from("vehicle-photos").upload(path, file, { upsert: true });
      if (upErr) throw new Error(upErr.message);
      setFotos((prev) => [...prev, path]);
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
      setError("Falta el terminal de destino. Escanea la tarjeta o usa el selector de emergencia.");
      return;
    }
    if (mode === "retorno" && !terminal) {
      setError("Elige el terminal desde donde regresa el vehículo (A, B o C).");
      return;
    }
    if (mode === "salida" && !revisado) {
      setError("Confirma con OK que el vehículo está en condiciones para salir.");
      return;
    }
    if (manualOverride && !manualReason.trim()) {
      setError("Debes indicar el motivo de la excepción manual de emergencia.");
      return;
    }

    setBusy(true);
    setError(null);

    const auditTag = manualOverride ? ` · [EXCEPCIÓN MANUAL: ${manualReason}]` : "";
    const notesText =
      mode === "salida"
        ? `Vehículo revisado OK antes de iniciar ruta${auditTag}`
        : `Retorno hacia Base X${auditTag}`;

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
        notes: notesText,
        photos: fotos,
        photo_path: fotos[0] ?? null,
      })
      .select("id")
      .single();
    setBusy(false);
    if (err) setError(err.message);
    else {
      setMovementId(data.id);
      setMessage(mode === "salida" ? `Ruta iniciada hacia ${PUNTOS[terminal!].label}.` : "Ruta iniciada hacia Base X.");
    }
  }

  const distancia = position && meta ? distanciaM(position, meta) : null;
  const radioPermitido = meta
    ? RADIO_POR_PUNTO[meta.code] + Math.min(accuracy ?? 0, TOLERANCIA_MAX_M)
    : 0;
  const enSitio = distancia !== null && distancia <= radioPermitido;

  // Detección estricta de terminal incorrecto:
  // Si el conductor se encuentra en las inmediaciones de otro terminal
  const otroPuntoCercano = position
    ? (Object.values(PUNTOS) as Punto[]).find((p) => {
        if (!meta || p.code === meta.code) return false;
        return distanciaM(position, p) <= RADIO_POR_PUNTO[p.code] + 60;
      }) ?? null
    : null;

  const coincide =
    !!spot &&
    !!verifSpot &&
    spot.trim().toUpperCase() === verifSpot.trim().toUpperCase() &&
    (!verifTerminal || verifTerminal === terminalEsperado);

  async function confirmarLlegada() {
    if (!meta || !movementId) return;

    // 1. RECHAZO TAJANTE: Terminal incorrecto
    if (otroPuntoCercano) {
      setError(
        `TERMINAL INCORRECTO: El GPS detecta que estás en ${otroPuntoCercano.label}. Tu destino obligatorio asignado es ${meta.label}. La aplicación no te dejará cerrar la ruta aquí. Traslada el vehículo al ${meta.label}.`,
      );
      return;
    }

    // 2. RECHAZO: Fuera de la geocerca permitida
    if (!position || !enSitio) {
      setError(
        `GPS NO RECONOCE LA LLEGADA: Te encuentras a ${Math.round(distancia ?? 0)} m de ${meta.label} (radio permitido: ${Math.round(radioPermitido)} m). Acércate al área asignada para poder confirmar la llegada.`,
      );
      return;
    }

    // 3. Validación obligatoria de fotos y correspondencia
    if (mode === "retorno") {
      if (!servicio || !fotoUbicacion || !fotoLlave) {
        setError("Elige el área en la base y toma las dos fotos requeridas (parqueo y llave).");
        return;
      }
    } else {
      if (!spot || !verifSpot) {
        setError("Toma las dos fotos obligatorias: número de parqueo y pantalla de verificación.");
        return;
      }
      if (spot.trim().toUpperCase() !== verifSpot.trim().toUpperCase()) {
        setError(
          `Error de parqueo: El parqueo fotografiado (${spot}) no coincide con el registrado (${verifSpot}). Corrige el registro.`,
        );
        return;
      }
      if (verifTerminal && verifTerminal !== terminalEsperado) {
        setError(
          `Error de terminal: La foto de verificación indica Terminal ${verifTerminal}, pero tu destino obligatorio es Terminal ${terminalEsperado}. Corrige la entrega.`,
        );
        return;
      }
    }

    setBusy(true);
    const todas = [...new Set([...fotos, ...(mode === "retorno" ? [fotoUbicacion!, fotoLlave!] : [])])];
    const gpsAudit = ` · GPS: ±${Math.round(accuracy ?? 0)}m (distancia al punto: ${Math.round(distancia ?? 0)}m)`;
    const cleanSpot = spot.trim().toUpperCase();

    const { error: err } = await supabase
      .from("movements")
      .update({
        dropoff_location: mode === "retorno" ? servicio : cleanSpot,
        notes:
          mode === "retorno"
            ? `Llegada a Base X · área: ${servicio} (fotos parqueo y llave)${gpsAudit}`
            : `Llegada confirmada por GPS en ${meta.label} · parqueo ${cleanSpot} verificado${gpsAudit}`,
        photos: todas,
        photo_path: todas[0] ?? null,
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
          : `Llegada confirmada en ${meta.label}, parqueo ${cleanSpot}.`,
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
      setShowManualOverride(false);
      setManualOverride(false);
      setManualReason("");
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
            <div className="flex items-center justify-center gap-3 p-3 bg-secondary/50 rounded-xl border border-border">
              <span className={cn("size-10 rounded-full flex items-center justify-center text-base font-bold shadow", PUNTOS[terminal].color, PUNTOS[terminal].text)}>
                {terminal}
              </span>
              <div className="text-left">
                <span className="text-xs font-bold uppercase tracking-wider block">{PUNTOS[terminal].label}</span>
                <span className="text-[10px] text-muted-foreground uppercase font-medium">
                  {manualOverride ? "Asignado manualmente (Emergencia)" : "Detectado por color de tarjeta"}
                </span>
              </div>
            </div>
          )}

          {/* Selector manual de emergencia (exclusivo para fallas extremas) */}
          {mode === "salida" && (
            <div className="pt-1">
              {!showManualOverride ? (
                <button
                  type="button"
                  onClick={() => setShowManualOverride(true)}
                  className="w-full text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-amber-500 py-1.5 transition-colors flex items-center justify-center gap-1.5"
                >
                  <span>⚠️</span> ¿Falla de escaneo o tarjeta ilegible? Selector de emergencia
                </button>
              ) : (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <span>⚠️</span> Selector Manual de Emergencia
                      </p>
                      <p className="text-[10px] text-muted-foreground leading-snug">
                        Solo para casos extremos de tarjeta rota o cámara averiada. Esta excepción quedará registrada con tu usuario para auditoría administrativa.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowManualOverride(false);
                        setManualOverride(false);
                        setManualReason("");
                      }}
                      className="text-xs font-bold text-muted-foreground hover:text-foreground px-1"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Terminal de destino asignado:
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {(["A", "B", "C"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            setTerminal(t);
                            setManualOverride(true);
                          }}
                          className={cn(
                            "py-2.5 rounded-lg font-bold uppercase text-xs tracking-widest border transition-all",
                            terminal === t
                              ? cn(PUNTOS[t].color, PUNTOS[t].text, "border-transparent ring-2 ring-amber-500 shadow")
                              : "bg-background text-muted-foreground border-border hover:border-amber-400",
                          )}
                        >
                          {t} · {PUNTOS[t].label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Motivo obligatorio de la excepción:
                    </label>
                    <select
                      value={manualReason}
                      onChange={(e) => {
                        setManualReason(e.target.value);
                        setManualOverride(true);
                      }}
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-medium"
                    >
                      <option value="">-- Selecciona el motivo --</option>
                      <option value="Tarjeta física rota, manchada o ilegible">Tarjeta física rota, manchada o ilegible</option>
                      <option value="Falla física de lente o cámara del dispositivo">Falla física de lente o cámara del dispositivo</option>
                      <option value="Llavero sin etiqueta de color distinguible">Llavero sin etiqueta de color distinguible</option>
                      <option value="Incidencia operativa autorizada por supervisor">Incidencia operativa autorizada por supervisor</option>
                    </select>
                  </div>

                  {manualOverride && terminal && (
                    <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300 bg-amber-500/20 p-2 rounded-lg text-center">
                      Excepción manual activa: Terminal {terminal} · {manualReason || "Falta motivo"}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {mode === "retorno" && (
            <div className="space-y-2">
              <div className="flex items-center justify-center gap-2">
                <span className="size-9 rounded-full flex items-center justify-center text-sm font-bold bg-black text-white">X</span>
                <span className="text-[11px] font-bold uppercase tracking-widest">Retorno a Base X</span>
              </div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground text-center">
                ¿De qué terminal regresa?
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(["A", "B", "C"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTerminal(t)}
                    className={cn(
                      "py-3 rounded-xl font-bold uppercase text-xs tracking-widest border",
                      terminal === t
                        ? cn(PUNTOS[t].color, PUNTOS[t].text, "border-transparent")
                        : "bg-background text-muted-foreground border-border",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
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
            disabled={busy || !plate || !terminal || (mode === "salida" ? !revisado : false)}

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
            {/* Cabecera con indicación de destino por color */}
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-border">
              <div className="min-w-0">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block">
                  {mode === "salida" ? "Ruta de salida hacia terminal" : "Ruta de retorno a Base X"}
                </span>
                <p className="text-sm font-bold truncate">
                  {plateState} {plate} {model ? `· ${model}` : ""}
                </p>
              </div>
              {meta && (
                <div className="flex items-center gap-2 shrink-0">
                  <span className={cn("size-8 rounded-full flex items-center justify-center text-xs font-bold shadow", PUNTOS[meta.code].color, PUNTOS[meta.code].text)}>
                    {meta.code}
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider">{meta.label}</span>
                </div>
              )}
            </div>

            {/* ALERTA DE TERMINAL INCORRECTO DETECTADO POR GPS */}
            {otroPuntoCercano && (
              <div className="bg-red-600 text-white rounded-xl p-3.5 space-y-1.5 shadow-lg border-2 border-white animate-pulse">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🛑</span>
                  <p className="text-xs font-black uppercase tracking-wider">¡TERMINAL INCORRECTO DETECTADO!</p>
                </div>
                <p className="text-xs leading-snug font-medium">
                  El GPS detecta que estás en <strong>{otroPuntoCercano.label}</strong>, pero este vehículo debe entregarse obligatoriamente en <strong>{meta?.label}</strong>.
                </p>
                <p className="text-[10px] font-bold uppercase tracking-widest text-yellow-200">
                  Trasládate al {meta?.label} ({Math.round(distancia ?? 0)} m restantes). La aplicación no te permitirá cerrar la ruta en una ubicación equivocada.
                </p>
              </div>
            )}

            {/* Estado GPS y Distancia en tiempo real */}
            {meta && distancia !== null && (
              <div
                className={cn(
                  "rounded-xl p-3 border text-center space-y-1",
                  otroPuntoCercano
                    ? "bg-red-500/10 border-red-500/30 text-red-600"
                    : enSitio
                      ? "bg-green-500/10 border-green-500/30 text-green-700"
                      : "bg-secondary/60 border-border text-muted-foreground",
                )}
              >
                <div className="flex items-center justify-center gap-2">
                  <span className="text-sm">{enSitio && !otroPuntoCercano ? "🟢" : otroPuntoCercano ? "🛑" : "📍"}</span>
                  <p className="text-xs font-bold uppercase tracking-wider">
                    {otroPuntoCercano
                      ? `En terminal equivocado: ${otroPuntoCercano.label}`
                      : enSitio
                        ? `GPS verificado en ${meta.label} ✓`
                        : `A ${Math.round(distancia)} m de ${meta.label}`}
                  </p>
                </div>
                <p className="text-[10px] font-mono leading-tight">
                  {enSitio && !otroPuntoCercano
                    ? `Dentro de la geocerca permitida (±${Math.round(accuracy ?? 0)} m) · Cierre autorizado`
                    : `Geocerca requerida: dentro de ${Math.round(radioPermitido)} m · Llegada bloqueada`}
                </p>
              </div>
            )}

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
                    : "Al llegar a la Base X podrás elegir el área y tomar las fotos"}
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
              <div className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Fotos obligatorias de entrega en terminal:
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => spotRef.current?.click()}
                      disabled={leyendo !== null}
                      className={cn(
                        "w-full py-3 rounded-xl font-bold uppercase text-[11px] tracking-widest disabled:opacity-60 border",
                        spot
                          ? "bg-secondary text-foreground border-border"
                          : "bg-accent text-accent-foreground border-transparent",
                      )}
                    >
                      {leyendo === "spot" ? "Leyendo…" : spot ? `Parqueo: ${spot} 📸` : "1. Foto parqueo"}
                    </button>
                    {spot && (
                      <input
                        value={spot}
                        onChange={(e) => setSpot(e.target.value.toUpperCase())}
                        placeholder="Editar parqueo"
                        className="w-full text-center text-xs font-bold uppercase rounded-lg border border-input bg-background py-1.5 px-1 font-mono"
                      />
                    )}
                  </div>

                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => verifRef.current?.click()}
                      disabled={leyendo !== null}
                      className={cn(
                        "w-full py-3 rounded-xl font-bold uppercase text-[11px] tracking-widest disabled:opacity-60 border",
                        verifSpot || verifTerminal
                          ? "bg-secondary text-foreground border-border"
                          : "bg-accent text-accent-foreground border-transparent",
                      )}
                    >
                      {leyendo === "verif"
                        ? "Leyendo…"
                        : verifSpot || verifTerminal
                          ? `Verif: ${verifSpot}${verifTerminal ? ` · ${verifTerminal}` : ""} 📸`
                          : "2. Foto verificación"}
                    </button>
                    {verifSpot && (
                      <input
                        value={verifSpot}
                        onChange={(e) => setVerifSpot(e.target.value.toUpperCase())}
                        placeholder="Editar verificación"
                        className="w-full text-center text-xs font-bold uppercase rounded-lg border border-input bg-background py-1.5 px-1 font-mono"
                      />
                    )}
                  </div>
                </div>

                {spot && verifSpot && (
                  <p
                    className={cn(
                      "text-center text-[11px] font-bold uppercase tracking-widest rounded-lg p-2 border",
                      coincide
                        ? "text-green-700 bg-green-600/10 border-green-600/30"
                        : "text-white bg-red-600 border-red-700",
                    )}
                  >
                    {coincide
                      ? `Verificado: Parqueo ${spot} en Terminal ${terminalEsperado}`
                      : `Discrepancia: foto (${spot}) vs teléfono (${verifSpot}${verifTerminal ? ` · Term ${verifTerminal}` : ""}). Corrige para cerrar.`}
                  </p>
                )}
              </div>
            )}

            {/* Botón de Confirmación de Llegada Inviolable */}
            <button
              type="button"
              onClick={() => void confirmarLlegada()}
              disabled={
                busy ||
                !enSitio ||
                !!otroPuntoCercano ||
                (mode === "retorno" ? !servicio || !fotoUbicacion || !fotoLlave : !coincide)
              }
              className={cn(
                "w-full py-4 rounded-xl font-bold uppercase text-xs tracking-widest transition-all",
                otroPuntoCercano
                  ? "bg-red-600 text-white cursor-not-allowed"
                  : enSitio && (mode === "retorno" ? !!servicio && !!fotoUbicacion && !!fotoLlave : coincide)
                    ? "bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-600/30 scale-[1.01]"
                    : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
            >
              {busy
                ? "Guardando llegada…"
                : otroPuntoCercano
                  ? `Bloqueado (Estás en ${otroPuntoCercano.code} · Ve al ${meta?.code})`
                  : !enSitio
                    ? `Bloqueado por GPS (A ${Math.round(distancia ?? 0)} m de ${meta?.label})`
                    : mode === "retorno"
                      ? !servicio || !fotoUbicacion || !fotoLlave
                        ? "Faltan fotos requeridas en Base X"
                        : "Confirmar llegada en Base X ✓"
                      : !coincide
                        ? !spot || !verifSpot
                          ? "Faltan fotos (Parqueo y Verificación)"
                          : "Parqueo no coincide · Corrige el código"
                        : `Confirmar llegada en ${meta?.label} ✓`}
            </button>

            {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2.5 shadow">{error}</p>}
            {message && !error && (
              <p className="text-center text-xs font-bold uppercase tracking-widest text-primary bg-primary/10 rounded-lg p-2.5">{message}</p>
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
