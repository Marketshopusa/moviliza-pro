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
      { name: "description", content: "Escaneo por IA, ruta guiada en tiempo real y confirmación de llegada por GPS." },
      { property: "og:title", content: "Drivers · MovilizaPro" },
      { property: "og:description", content: "Escaneo por IA, ruta guiada en tiempo real y confirmación de llegada por GPS." },
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

/** Radio de geocerca en metros. Base X es un lote extenso y los terminales son multinivel. */
const RADIO_POR_PUNTO: Record<Code, number> = { X: 300, A: 160, B: 160, C: 160 };
const TOLERANCIA_MAX_M = 140;

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
  const { user } = useAuth();
  const [open, setOpen] = useState<Mode | null>(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("movilizapro_active_driver_trip");
        if (raw) {
          const trip = JSON.parse(raw);
          if (trip.movementId && (trip.mode === "salida" || trip.mode === "retorno")) {
            return trip.mode;
          }
        }
      } catch {}
    }
    return "salida";
  });

  // Restaurar automáticamente la pestaña si hay un viaje activo guardado
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("movilizapro_active_driver_trip");
      if (raw) {
        const trip = JSON.parse(raw);
        if (trip.movementId && (trip.mode === "salida" || trip.mode === "retorno")) {
          setOpen(trip.mode);
        }
      }
    } catch {}
  }, []);

  return (
    <div className="space-y-4">
      <ShiftPanel />

      <h1 className="text-lg font-bold uppercase tracking-widest">Control de Rutas</h1>

      <div className="grid grid-cols-2 gap-2">
        {(["salida", "retorno"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setOpen(open === m ? null : m)}
            className={cn(
              "py-3 rounded-lg text-sm font-bold uppercase tracking-widest border transition-all cursor-pointer",
              open === m ? "bg-primary text-primary-foreground border-primary shadow" : "bg-card border-border text-muted-foreground",
            )}
          >
            {m === "salida" ? "1. Salida (Hacia Terminal)" : "2. Retorno (Hacia Base X)"}
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

  // Estados del Flujo Estilo Amazon:
  // 1. Inicio: movementId === null
  // 2. En Ruta: movementId !== null && !llegadaConfirmada
  // 3. Llegada confirmada (fotos y cierre): movementId !== null && llegadaConfirmada
  const [movementId, setMovementId] = useState<string | null>(null);
  const [llegadaConfirmada, setLlegadaConfirmada] = useState(false);

  // Selector manual de emergencia
  const [showManualOverride, setShowManualOverride] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);
  const [manualReason, setManualReason] = useState("");

  // Última ubicación del vehículo en Base X
  const [vehPos, setVehPos] = useState<VehiclePosition | null>(null);

  // Retorno: fotos y servicio
  const [servicio, setServicio] = useState<Servicio | null>(null);
  const [pendiente, setPendiente] = useState<Servicio | null>(null);
  const [fotoUbicacion, setFotoUbicacion] = useState<string | null>(null);
  const [fotoLlave, setFotoLlave] = useState<string | null>(null);
  const [fotos, setFotos] = useState<string[]>([]);
  const [subiendo, setSubiendo] = useState<"ubicacion" | "llave" | null>(null);
  const [cardPhotoUrl, setCardPhotoUrl] = useState<string | null>(null);

  // Llegada a terminal: número de parqueo y pantalla de verificación
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

  // Origen y Destino Estrictos:
  // En Salida: Salida desde Base X → Llegada a Terminal asignado (A, B o C).
  // En Retorno: Salida desde Terminal actual → Llegada siempre a Base X.
  const origen = mode === "salida" ? PUNTOS.X : terminal ? PUNTOS[terminal] : null;
  const destino = mode === "salida" ? (terminal ? PUNTOS[terminal] : null) : PUNTOS.X;
  const meta = destino;
  const terminalEsperado: Code | null = mode === "salida" ? terminal : "X";

  // GPS continuo en tiempo real
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
          ids.push(
            navigator.geolocation.watchPosition(ok, () => {}, {
              enableHighAccuracy: false,
              maximumAge: 60_000,
            }),
          );
        },
        { enableHighAccuracy: true, maximumAge: 15_000 },
      ),
    );
    return () => ids.forEach((id) => navigator.geolocation.clearWatch(id));
  }, []);

  // En modo Retorno, autodetectar si el conductor ya se encuentra en un terminal específico (A, B o C)
  useEffect(() => {
    if (mode === "retorno" && position && !terminal && !movementId) {
      const terminales = [PUNTOS.A, PUNTOS.B, PUNTOS.C];
      for (const t of terminales) {
        if (distanciaM(position, t) <= RADIO_POR_PUNTO[t.code] + 120) {
          setTerminal(t.code);
          break;
        }
      }
    }
  }, [mode, position, terminal, movementId]);

  // 1. Restaurar viaje activo desde localStorage y desde Supabase al montar o recargar
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    // A. Leer desde localStorage de inmediato (instantáneo sin esperar a la red)
    try {
      const raw = localStorage.getItem("movilizapro_active_driver_trip");
      if (raw) {
        const trip = JSON.parse(raw);
        if (trip.movementId && trip.mode === mode && !cancelled) {
          setMovementId(trip.movementId);
          if (trip.plate) setPlate(trip.plate);
          if (trip.plateState) setPlateState(trip.plateState);
          if (trip.model) setModel(trip.model);
          if (trip.terminal) setTerminal(trip.terminal);
          if (trip.revisado !== undefined) setRevisado(trip.revisado);
          if (trip.llegadaConfirmada !== undefined) setLlegadaConfirmada(trip.llegadaConfirmada);
          if (trip.spot) setSpot(trip.spot);
          if (trip.verifSpot) setVerifSpot(trip.verifSpot);
          if (trip.verifTerminal) setVerifTerminal(trip.verifTerminal);
          if (trip.servicio) setServicio(trip.servicio);
          if (trip.fotoUbicacion) setFotoUbicacion(trip.fotoUbicacion);
          if (trip.fotoLlave) setFotoLlave(trip.fotoLlave);
          if (trip.fotos) setFotos(trip.fotos);
        }
      }
    } catch {}

    // B. Consultar Supabase para verificar si hay un viaje 'en_ruta' activo
    void (async () => {
      try {
        const { data: activeMove } = await supabase
          .from("movements")
          .select("*")
          .eq("driver_id", user.id)
          .eq("status", "en_ruta")
          .order("occurred_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (activeMove && !cancelled) {
          const moveMode: Mode = activeMove.origin === "X" ? "salida" : "retorno";
          if (moveMode === mode) {
            setMovementId(activeMove.id);
            if (activeMove.plate) setPlate(activeMove.plate);
            if (activeMove.plate_state) setPlateState(activeMove.plate_state);
            if (activeMove.vehicle_model) setModel(activeMove.vehicle_model);
            if (moveMode === "salida" && activeMove.destination && activeMove.destination !== "X") {
              setTerminal(activeMove.destination as Code);
            } else if (moveMode === "retorno" && activeMove.origin && activeMove.origin !== "X") {
              setTerminal(activeMove.origin as Code);
            }
            if (Array.isArray(activeMove.photos) && activeMove.photos.length > 0) {
              setFotos(activeMove.photos.filter((p): p is string => typeof p === 'string'));
            }
          }
        }
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [user, mode]);

  // 2. Persistir continuamente el viaje activo en localStorage ante cualquier cambio
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (movementId) {
        const payload = {
          movementId,
          mode,
          plate,
          plateState,
          model,
          terminal,
          revisado,
          llegadaConfirmada,
          spot,
          verifSpot,
          verifTerminal,
          servicio,
          fotoUbicacion,
          fotoLlave,
          fotos,
        };
        localStorage.setItem("movilizapro_active_driver_trip", JSON.stringify(payload));
      } else {
        localStorage.removeItem("movilizapro_active_driver_trip");
      }
    } catch {}
  }, [
    movementId,
    mode,
    plate,
    plateState,
    model,
    terminal,
    revisado,
    llegadaConfirmada,
    spot,
    verifSpot,
    verifTerminal,
    servicio,
    fotoUbicacion,
    fotoLlave,
    fotos,
  ]);

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

  // Escaneo de la tarjeta o placa con Google Gemini Vision oficial
  async function handleCard(rawFile: File) {
    setScanning(true);
    setScanMsg("Analizando foto con IA de visión de alta precisión…");
    setError(null);
    try {
      // Previsualización inmediata en el teléfono
      const localUrl = URL.createObjectURL(rawFile);
      setCardPhotoUrl(localUrl);

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

      if (res.terminal && res.terminal !== "X") {
        setTerminal(res.terminal);
      }

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
      if (res.plate) partes.push(`Placa: ${res.plate_state ?? ""} ${res.plate}`.trim());
      if (res.vehicle_model) partes.push(res.vehicle_model);
      if (res.card_color) partes.push(`Color: ${res.card_color} → Terminal ${res.terminal}`);

      setScanMsg(
        partes.length
          ? `✓ Leído por IA: ${partes.join(" · ")}`
          : "No se pudo leer la tarjeta. Puedes ingresar los datos manualmente o intentar de nuevo."
      );
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "Error al procesar la foto");
    } finally {
      setScanning(false);
    }
  }

  // Escaneo del número de parqueo (en el piso) o verificación (pantalla)
  async function handleSpotPhoto(rawFile: File, kind: "spot" | "verif") {
    setLeyendo(kind);
    setError(null);
    try {
      const file = await compressImage(rawFile);
      void archivarFoto(file, kind === "spot" ? "parqueo" : "verificacion");
      const dataUrl = await fileToDataUrl(file);
      const res = await readSpot({ data: { image: dataUrl } });

      if (kind === "spot") {
        if (res.spot) {
          setSpot(res.spot);
          setMessage(`✓ Parqueo leído por IA: ${res.spot}`);
        } else {
          setError("No se leyó con claridad el número en el asfalto. Escríbelo en el campo de texto.");
        }
      } else {
        if (res.spot) setVerifSpot(res.spot);
        if (res.terminal) setVerifTerminal(res.terminal);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al leer la foto");
    } finally {
      setLeyendo(null);
    }
  }

  // Subida de fotos en retorno (parqueo y llave) con respuesta táctil directa
  async function subirFotoRetorno(rawFile: File, kind: "ubicacion" | "llave") {
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
        setMessage("✓ Foto de parqueo en Base X guardada en la nube");
      } else {
        setFotoLlave(path);
        setMessage("✓ Foto de la llave guardada en la nube");
      }
      if (movementId) {
        const nuevas = [...fotos, path];
        void supabase
          .from("movements")
          .update({ photos: nuevas, photo_path: nuevas[0] ?? null })
          .eq("id", movementId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al subir la foto");
    } finally {
      setSubiendo(null);
    }
  }

  // FASE 1 -> FASE 2: Iniciar la Ruta
  async function iniciarRuta() {
    if (!user || !plate) {
      setError("Escanea o ingresa la placa del vehículo.");
      return;
    }
    if (mode === "salida" && !terminal) {
      setError("Falta el terminal de destino asignado (A, B o C).");
      return;
    }
    if (mode === "retorno" && !terminal) {
      setError("Indica de qué terminal estás saliendo (A, B o C).");
      return;
    }
    if (mode === "salida" && !revisado) {
      setError("Confirma con el botón OK la revisión física del vehículo.");
      return;
    }
    if (manualOverride && !manualReason.trim()) {
      setError("Indica el motivo de la excepción manual de emergencia.");
      return;
    }

    setBusy(true);
    setError(null);

    const auditTag = manualOverride ? ` · [EXCEPCIÓN MANUAL: ${manualReason}]` : "";
    const notesText =
      mode === "salida"
        ? `Salida desde Base X hacia Terminal ${terminal}${auditTag}`
        : `Retorno desde Terminal ${terminal} hacia Base X${auditTag}`;

    const origenCode: Code = mode === "salida" ? "X" : (terminal ?? "B");
    const destinoCode: Code = mode === "salida" ? terminal! : "X";

    const { data, error: err } = await supabase
      .from("movements")
      .insert({
        driver_id: user.id,
        plate_state: plateState,
        plate,
        vehicle_model: model || null,
        origin: origenCode,
        destination: destinoCode,
        dropoff_location: null,
        latitude: position?.lat ?? null,
        longitude: position?.lng ?? null,
        occurred_at: new Date().toISOString(),
        status: "en_ruta",
        notes: notesText,
        photos: fotos,
        photo_path: fotos[0] ?? null,
      })
      .select("id")
      .single();

    setBusy(false);
    if (err) {
      setError(err.message);
    } else {
      setMovementId(data.id);
      setLlegadaConfirmada(false);
      setMessage(
        mode === "salida"
          ? `Ruta iniciada: Base X → ${PUNTOS[destinoCode].label}`
          : `Retorno iniciado: ${PUNTOS[origenCode].label} → Base X`
      );
    }
  }

  // Cálculos de Geocerca de DESTINO
  const distancia = position && meta ? distanciaM(position, meta) : null;
  const radioPermitido = meta
    ? RADIO_POR_PUNTO[meta.code] + Math.min(accuracy ?? 0, TOLERANCIA_MAX_M)
    : 0;
  const enSitio = distancia !== null && distancia <= radioPermitido;

  // Detección de Terminal Incorrecto SOLO en la llegada a terminal (modo salida):
  // Si el conductor llega a un terminal diferente al que tenía asignado
  const otroPuntoCercano = position && mode === "salida"
    ? (Object.values(PUNTOS) as Punto[]).find((p) => {
        if (!meta || p.code === meta.code) return false;
        if (p.code === "X") return false; // Base X es el origen en salida
        return distanciaM(position, p) <= RADIO_POR_PUNTO[p.code];
      }) ?? null
    : null;

  const coincide =
    !!spot &&
    !!verifSpot &&
    spot.trim().toUpperCase() === verifSpot.trim().toUpperCase() &&
    (!verifTerminal || verifTerminal === terminalEsperado);

  // FASE 3: Finalizar y Cerrar la Ruta (Acción definitiva de cierre)
  async function finalizarViaje() {
    if (!meta || !movementId) return;

    // Validación de entrega
    if (mode === "retorno") {
      if (!servicio) {
        setError("Por favor selecciona el área en Base X donde dejas el vehículo (ej. Limpieza general).");
        return;
      }
      if (!fotoUbicacion && !fotoLlave) {
        setError("Por favor toma la foto de parqueo o de llave en Base X para finalizar.");
        return;
      }
    } else {
      if (!spot || !spot.trim()) {
        setError("Por favor ingresa o toma la foto del número de parqueo (ej. D16).");
        return;
      }
      if (verifSpot && spot.trim().toUpperCase() !== verifSpot.trim().toUpperCase()) {
        setError(`Discrepancia: El parqueo ingresado (${spot}) no coincide con la verificación (${verifSpot}). Verifica el código.`);
        return;
      }
      if (verifTerminal && verifTerminal !== terminalEsperado) {
        setError(`Error de terminal: La verificación indica Terminal ${verifTerminal}, pero tu destino asignado es Terminal ${terminalEsperado}.`);
        return;
      }
    }

    setBusy(true);
    const fotosRetorno = [fotoUbicacion, fotoLlave].filter(Boolean) as string[];
    const todas = [...new Set([...fotos, ...(mode === "retorno" ? fotosRetorno : [])])];
    const gpsAudit = ` · GPS: ±${Math.round(accuracy ?? 0)}m (distancia al punto: ${Math.round(distancia ?? 0)}m)`;
    const cleanSpot = spot.trim().toUpperCase();

    const { error: err } = await supabase
      .from("movements")
      .update({
        dropoff_location: mode === "retorno" ? servicio : cleanSpot,
        status: "sincronizado",
        notes:
          mode === "retorno"
            ? `Retorno completado en Base X · Área: ${servicio}${gpsAudit}`
            : `Entrega completada en ${meta.label} · Parqueo: ${cleanSpot}${gpsAudit}`,
        photos: todas,
        photo_path: todas[0] ?? null,
        latitude: position?.lat ?? null,
        longitude: position?.lng ?? null,
      })
      .eq("id", movementId);

    setBusy(false);
    if (err) {
      setError(err.message);
    } else {
      setError(null);
      setMessage(
        mode === "retorno"
          ? `✓ Retorno cerrado en Base X (${servicio})`
          : `✓ Entrega cerrada en ${meta.label}, parqueo ${cleanSpot}`
      );

      // Resetear para el siguiente movimiento
      setPlate("");
      setModel("");
      setTerminal(null);
      setRevisado(false);
      setMovementId(null);
      setLlegadaConfirmada(false);
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
      setFotos([]);
      setCardPhotoUrl(null);
      try {
        localStorage.removeItem("movilizapro_active_driver_trip");
      } catch {}
    }
  }

  return (
    <section className="space-y-4">
      {/* ========================================================================= */}
      {/* FASE 1: INICIO DE VIAJE (Escaneo de tarjeta, vehículo y confirmación)      */}
      {/* ========================================================================= */}
      {!movementId && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              {mode === "salida" ? "Salida: Base X → Terminal" : "Retorno: Terminal → Base X"}
            </h2>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-primary/10 text-primary">
              Fase 1 · Inicio
            </span>
          </div>

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
            className="w-full py-4 rounded-xl bg-accent text-accent-foreground font-bold uppercase text-xs tracking-widest disabled:opacity-60 shadow flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>📷</span>
            <span>{scanning ? "Analizando con IA de visión…" : "Tomar foto a la tarjeta / placa"}</span>
          </button>
          {cardPhotoUrl && (
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-secondary/80 border border-border">
              <img
                src={cardPhotoUrl}
                alt="Foto tarjeta"
                className="w-16 h-12 object-cover rounded-lg border border-border shadow-sm"
              />
              <div className="flex-1">
                <span className="text-[10px] font-bold uppercase text-green-600 block">✓ Foto guardada y analizada</span>
                <span className="text-xs font-mono font-bold text-foreground">
                  {plate ? `${plateState} ${plate} ${model ? `· ${model}` : ""}` : "Extrayendo datos de la tarjeta…"}
                </span>
              </div>
            </div>
          )}
          {scanMsg && <p className="text-xs text-center text-muted-foreground font-medium">{scanMsg}</p>}

          {/* Selección o detección de Terminal */}
          {mode === "salida" ? (
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Terminal de destino asignado:
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(["A", "B", "C"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTerminal(t)}
                    className={cn(
                      "py-3 rounded-xl font-bold uppercase text-xs tracking-widest border transition-all",
                      terminal === t
                        ? cn(PUNTOS[t].color, PUNTOS[t].text, "border-transparent ring-2 ring-primary shadow")
                        : "bg-background text-muted-foreground border-border",
                    )}
                  >
                    {t} · {PUNTOS[t].label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                ¿En qué terminal te encuentras para el retorno?
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(["A", "B", "C"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTerminal(t)}
                    className={cn(
                      "py-3 rounded-xl font-bold uppercase text-xs tracking-widest border transition-all",
                      terminal === t
                        ? cn(PUNTOS[t].color, PUNTOS[t].text, "border-transparent ring-2 ring-primary shadow")
                        : "bg-background text-muted-foreground border-border",
                    )}
                  >
                    {t} · {PUNTOS[t].label}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-center gap-2 pt-1 text-muted-foreground">
                <span className="size-6 rounded-full flex items-center justify-center text-xs font-bold bg-black text-white">X</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Destino obligatorio: Base X</span>
              </div>
            </div>
          )}

          {/* Datos del vehículo */}
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

          {mode === "salida" && (
            <button
              type="button"
              onClick={() => setRevisado((v) => !v)}
              className={cn(
                "w-full py-3 rounded-xl font-bold uppercase text-xs tracking-widest border transition-all",
                revisado ? "bg-green-600 text-white border-green-600 shadow" : "bg-background text-muted-foreground border-border",
              )}
            >
              {revisado ? "✓ Vehículo revisado en condiciones" : "Confirmar revisión (gasolina, limpieza y daños)"}
            </button>
          )}

          <button
            type="button"
            onClick={() => void iniciarRuta()}
            disabled={busy}
            className={cn(
              "w-full py-4 rounded-xl font-bold uppercase text-xs sm:text-sm tracking-widest shadow-md transition-all cursor-pointer flex items-center justify-center gap-2",
              plate && terminal && (mode === "salida" ? revisado : true)
                ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/25"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            <span>🚀</span>
            <span>{busy ? "Iniciando viaje…" : `Iniciar viaje hacia ${meta ? meta.label : "destino"}`}</span>
          </button>

          {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2.5">{error}</p>}
        </div>
      )}

      {/* ========================================================================= */}
      {/* FASE 2: EN RUTA (En camino en la carretera · Botón de llegada bloqueado)  */}
      {/* ========================================================================= */}
      {movementId && !llegadaConfirmada && (
        <>
          <RutaMapaLeaflet puntos={Object.values(PUNTOS)} origen={origen} destino={destino} yo={position} />

          <div className="bg-card border border-border rounded-xl p-4 space-y-4 shadow-sm">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <div className="min-w-0">
                <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500 block animate-pulse">
                  ● En Ruta (En tránsito)
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
                  <div className="text-right">
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground block">Destino</span>
                    <span className="text-xs font-bold uppercase">{meta.label}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Cuadro de navegación en carretera */}
            <div className={cn(
              "rounded-xl p-3.5 border text-center space-y-1 transition-all",
              enSitio && !otroPuntoCercano
                ? "bg-green-500/15 border-green-500/40 text-green-700 dark:text-green-300"
                : otroPuntoCercano
                  ? "bg-red-500/10 border-red-500/30 text-red-600"
                  : "bg-secondary/70 border-border text-muted-foreground",
            )}>
              <p className="text-xs font-bold uppercase tracking-wider">
                {otroPuntoCercano
                  ? `⚠️ Terminal Incorrecto: Estás en ${otroPuntoCercano.label}`
                  : enSitio
                    ? `🟢 ¡Has llegado a la geocerca de ${meta?.label}!`
                    : `🚗 En camino hacia ${meta?.label}`}
              </p>
              <p className="text-xl font-mono font-bold text-foreground">
                {distancia !== null ? `${Math.round(distancia)} m` : "Calculando distancia GPS…"}
              </p>
              <p className="text-[10px] uppercase font-medium">
                {otroPuntoCercano
                  ? `Debes trasladar el vehículo al ${meta?.label} para poder confirmar la llegada.`
                  : enSitio
                    ? "Presiona el botón inferior para confirmar tu llegada e iniciar las fotos de entrega."
                    : `El botón de llegada se activará automáticamente al entrar en el radio de ${meta?.label}.`}
              </p>
            </div>

            {/* BOTÓN DE CONFIRMACIÓN DE LLEGADA (Exacto modelo Amazon Logistics) */}
            <button
              type="button"
              onClick={() => {
                setLlegadaConfirmada(true);
                setError(null);
              }}
              disabled={!enSitio || !!otroPuntoCercano}
              className={cn(
                "w-full py-4 rounded-xl font-bold uppercase text-xs tracking-widest transition-all",
                enSitio && !otroPuntoCercano
                  ? "bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-600/30 scale-[1.02] animate-pulse cursor-pointer"
                  : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
            >
              {otroPuntoCercano
                ? `Bloqueado: Estás en ${otroPuntoCercano.label} · Ve al ${meta?.label}`
                : enSitio
                  ? `📍 Confirmar Llegada en ${meta?.label} ✓`
                  : `En camino hacia ${meta?.label} (A ${Math.round(distancia ?? 0)} m)`}
            </button>

            {!enSitio && !otroPuntoCercano && (
              <button
                type="button"
                onClick={() => {
                  setLlegadaConfirmada(true);
                  setError(null);
                }}
                className="text-[10px] text-muted-foreground underline uppercase tracking-wider text-center block w-full py-1.5 hover:text-foreground cursor-pointer transition-colors"
              >
                ¿Problemas de señal GPS en el sótano/parqueo? Confirmar llegada aquí
              </button>
            )}

            {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2.5">{error}</p>}
          </div>
        </>
      )}

      {/* ========================================================================= */}
      {/* FASE 3: LLEGADA CONFIRMADA (Fotos de entrega y cierre final de la ruta)   */}
      {/* ========================================================================= */}
      {movementId && llegadaConfirmada && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4 shadow-md">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-green-600 block">
                ✓ Llegada confirmada por GPS
              </span>
              <p className="text-sm font-bold">
                Entrega en {meta?.label} · {plateState} {plate}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLlegadaConfirmada(false)}
              className="text-[10px] text-muted-foreground underline uppercase"
            >
              Volver a ruta
            </button>
          </div>

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
              if (f) void subirFotoRetorno(f, "ubicacion");
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
              if (f) void subirFotoRetorno(f, "llave");
              e.currentTarget.value = "";
            }}
          />

          {mode === "retorno" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  1. Área en Base X donde dejas el auto:
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {SERVICIOS.map((s) => {
                    const activo = servicio === s;
                    const principal = s === "Limpieza general";
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setServicio(s)}
                        className={cn(
                          "py-3 rounded-xl font-bold uppercase text-[11px] tracking-widest border transition-all cursor-pointer",
                          principal && "col-span-2",
                          activo
                            ? "bg-green-600 text-white border-green-600 shadow-md shadow-green-600/20"
                            : "bg-background text-muted-foreground border-border hover:border-primary/50",
                        )}
                      >
                        {activo ? `${s} ✓` : s}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-border">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  2. Fotos de entrega en Base X:
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {/* Botón Foto Parqueo */}
                  <button
                    type="button"
                    onClick={() => ubicacionRef.current?.click()}
                    disabled={subiendo !== null}
                    className={cn(
                      "py-3.5 px-2 rounded-xl font-bold uppercase text-[11px] tracking-wider border transition-all flex flex-col items-center justify-center gap-1 cursor-pointer",
                      fotoUbicacion
                        ? "bg-green-600/10 border-green-600 text-green-700"
                        : "bg-accent text-accent-foreground border-transparent hover:border-border",
                    )}
                  >
                    <span className="text-base">📷</span>
                    <span>{subiendo === "ubicacion" ? "Subiendo…" : fotoUbicacion ? "Parqueo Listo ✓" : "1. Foto Parqueo"}</span>
                  </button>

                  {/* Botón Foto Llave */}
                  <button
                    type="button"
                    onClick={() => llaveRef.current?.click()}
                    disabled={subiendo !== null}
                    className={cn(
                      "py-3.5 px-2 rounded-xl font-bold uppercase text-[11px] tracking-wider border transition-all flex flex-col items-center justify-center gap-1 cursor-pointer",
                      fotoLlave
                        ? "bg-green-600/10 border-green-600 text-green-700"
                        : "bg-accent text-accent-foreground border-transparent hover:border-border",
                    )}
                  >
                    <span className="text-base">🔑</span>
                    <span>{subiendo === "llave" ? "Subiendo…" : fotoLlave ? "Llave Lista ✓" : "2. Foto Llave"}</span>
                  </button>
                </div>

                {servicio && (fotoUbicacion || fotoLlave) && (
                  <p className="text-center text-[11px] font-bold uppercase tracking-widest text-green-700 bg-green-600/10 rounded-lg p-2">
                    {servicio} · {fotoUbicacion ? "Parqueo ✓" : ""} {fotoLlave ? "· Llave ✓" : ""}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Datos de Entrega en {meta?.label}:
              </p>

              {/* 1. Número de Parqueo (Piso o Asfalto) */}
              <div className="space-y-1.5 bg-background/50 border border-border/80 rounded-xl p-3">
                <label className="text-[11px] font-bold uppercase tracking-wider flex items-center justify-between text-foreground">
                  <span>1. Número de Parqueo (Piso / Asfalto):</span>
                  {spot && <span className="text-green-600 text-[10px]">✓ Registrado</span>}
                </label>
                <div className="flex gap-2">
                  <input
                    value={spot}
                    onChange={(e) => setSpot(e.target.value.toUpperCase())}
                    placeholder="Ej. D16 o 204"
                    className="flex-1 text-center text-sm font-bold uppercase rounded-lg border border-input bg-background py-2.5 px-3 font-mono shadow-sm"
                  />
                  <button
                    type="button"
                    onClick={() => spotRef.current?.click()}
                    disabled={leyendo !== null}
                    className={cn(
                      "px-3.5 py-2 rounded-lg font-bold uppercase text-xs tracking-wider border transition-all flex items-center gap-1.5 shrink-0",
                      spot ? "bg-secondary text-foreground border-border" : "bg-primary text-primary-foreground border-transparent shadow",
                    )}
                  >
                    <span>📷</span>
                    <span>{leyendo === "spot" ? "Leyendo asfalto…" : "Foto Piso"}</span>
                  </button>
                </div>
              </div>

              {/* 2. Foto de Verificación de Pantalla (Opcional o complementaria) */}
              <div className="space-y-1.5 bg-background/50 border border-border/80 rounded-xl p-3">
                <label className="text-[11px] font-bold uppercase tracking-wider flex items-center justify-between text-muted-foreground">
                  <span>2. Foto Verificación Pantalla del Teléfono:</span>
                  <span className="text-[9px] lowercase font-normal">(opcional)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    value={verifSpot}
                    onChange={(e) => setVerifSpot(e.target.value.toUpperCase())}
                    placeholder={spot ? `Verif: ${spot}` : "Ej. D16"}
                    className="flex-1 text-center text-xs font-bold uppercase rounded-lg border border-input bg-background py-2 px-3 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => verifRef.current?.click()}
                    disabled={leyendo !== null}
                    className="px-3.5 py-2 rounded-lg font-bold uppercase text-xs tracking-wider border bg-accent text-accent-foreground border-transparent shrink-0 flex items-center gap-1.5"
                  >
                    <span>📱</span>
                    <span>{leyendo === "verif" ? "Leyendo…" : "Foto Pantalla"}</span>
                  </button>
                </div>
              </div>

              {spot && verifSpot && (
                <p className={cn(
                  "text-center text-[11px] font-bold uppercase tracking-widest rounded-lg p-2 border",
                  coincide ? "text-green-700 bg-green-600/10 border-green-600/30" : "text-amber-700 bg-amber-500/10 border-amber-500/30",
                )}>
                  {coincide
                    ? `✓ Verificado: Parqueo ${spot} coincide con la pantalla.`
                    : `Nota: Foto (${spot}) vs Pantalla (${verifSpot}). Asegúrate de que el número sea correcto.`}
                </p>
              )}
            </div>
          )}

          {/* BOTÓN PROMINENTE DE CIERRE: FINALIZAR RIDE */}
          <button
            type="button"
            onClick={() => void finalizarViaje()}
            disabled={busy}
            className="w-full py-4 rounded-xl font-bold uppercase text-xs sm:text-sm tracking-widest bg-green-600 hover:bg-green-700 active:scale-[0.98] text-white shadow-xl shadow-green-600/30 cursor-pointer transition-all flex items-center justify-center gap-2"
          >
            <span>🏁</span>
            <span>
              {busy
                ? "Cerrando movimiento…"
                : mode === "salida"
                  ? "FINALIZAR RIDE / CERRAR ENTREGA"
                  : "FINALIZAR RIDE / CERRAR RETORNO"}
            </span>
          </button>

          {error && <p className="text-center text-xs font-bold uppercase tracking-widest text-white bg-red-600 rounded-lg p-2.5">{error}</p>}
          {message && !error && (
            <p className="text-center text-xs font-bold uppercase tracking-widest text-primary bg-primary/10 rounded-lg p-2.5">{message}</p>
          )}
        </div>
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
