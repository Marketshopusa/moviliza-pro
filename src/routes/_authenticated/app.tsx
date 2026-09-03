import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { queueMovement, readPending, syncPending, uploadPhoto, type PhotoEntry, type SiteCode } from "@/lib/offline";

export const Route = createFileRoute("/_authenticated/app")({
  head: () => ({
    meta: [
      { title: "Nuevo movimiento · MovilizaPro" },
      { name: "description", content: "Registra un movimiento con fotos, placa, origen, destino y ubicación de entrega." },
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
const BASE_SPOTS = ["CLEANERS", "SHOP", "TITE", "OIL", "PARKING"];
const MAX_PHOTOS = 4;

type Shift = { id: string; started_at: string; ended_at: string | null };
type MovementRow = {
  id: string;
  movement_number: number;
  plate_state: string;
  plate: string;
  vehicle_model: string | null;
  origin: SiteCode;
  destination: SiteCode;
  dropoff_location: string | null;
  occurred_at: string;
};

type LocalPhoto = { file: File; preview: string; note: string };

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit" });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
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
  const [dropoff, setDropoff] = useState("");
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [modelFromRegistry, setModelFromRegistry] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);


  async function refresh() {
    if (!user) return;
    const [{ data: s }, { data: m }] = await Promise.all([
      supabase.from("shifts").select("id, started_at, ended_at").eq("driver_id", user.id).is("ended_at", null).maybeSingle(),
      supabase
        .from("movements")
        .select("id, movement_number, plate_state, plate, vehicle_model, origin, destination, dropoff_location, occurred_at")
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
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setPhotos((prev) => {
      const room = MAX_PHOTOS - prev.length;
      const next = files.slice(0, room).map((file) => ({ file, preview: URL.createObjectURL(file), note: "" }));
      return [...prev, ...next];
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  function setPhotoNote(index: number, value: string) {
    setPhotos((prev) => prev.map((p, i) => (i === index ? { ...p, note: value } : p)));
  }

  // Registro interno de vehículos: al escribir/escanear la placa se autocompleta el modelo.
  useEffect(() => {
    const clean = plate.trim().toUpperCase().replace(/\s+/g, "");
    if (clean.length < 4) return;
    let active = true;
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from("vehicles")
        .select("vehicle_model")
        .eq("plate_state", plateState)
        .eq("plate", clean)
        .maybeSingle();
      if (!active) return;
      const known = data?.vehicle_model ?? "";
      if (known) {
        setModel((current) => (current.trim() ? current : known));
        setModelFromRegistry(true);
      } else {
        setModelFromRegistry(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [plate, plateState]);

  async function scanPlate(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (scanRef.current) scanRef.current.value = "";
    if (!file) return;
    setScanning(true);
    setScanMsg("Leyendo la placa…");
    try {
      const { scanPlateFromImage } = await import("@/lib/plate-ocr");
      const detected = await scanPlateFromImage(file);
      if (detected) {
        setPlate(detected);
        setScanMsg(`Placa detectada: ${detected}. Verifica antes de guardar.`);
      } else {
        setScanMsg("No se pudo leer la placa. Escríbela manualmente.");
      }
    } catch {
      setScanMsg("No se pudo leer la placa. Escríbela manualmente.");
    } finally {
      setScanning(false);
    }
  }

  function resetForm() {
    setPlate("");
    setModel("");
    setOrigin(null);
    setDestination(null);
    setDropoff("");
    setPhotos([]);
    setScanMsg(null);
    setModelFromRegistry(false);
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
    if (!user || !origin || !destination || !plate.trim() || photos.length === 0) return;
    if (origin === destination) {
      setMessage("El origen y el destino no pueden ser iguales");
      return;
    }
    setBusy(true);
    setMessage(null);
    const cleanPlate = plate.trim().toUpperCase().replace(/\s+/g, "");
    const cleanDropoff = dropoff.trim().toUpperCase() || null;
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
      const uploaded: PhotoEntry[] = [];
      for (const p of photos) {
        uploaded.push({ path: await uploadPhoto(user.id, p.file), note: p.note.trim() });
      }
      const { error } = await supabase.from("movements").insert({
        driver_id: user.id,
        shift_id: shift?.id ?? null,
        plate_state: plateState,
        plate: cleanPlate,
        vehicle_model: model.trim() || null,
        origin,
        destination,
        dropoff_location: cleanDropoff,
        occurred_at: occurredAt,
        latitude: geo.lat,
        longitude: geo.lng,
        photos: uploaded,
        photo_path: uploaded[0]?.path ?? null,
        status: "sincronizado",
      });
      if (error) throw error;
      setMessage(`Registrado: ${plateState}-${cleanPlate} · ${origin} → ${destination}${cleanDropoff ? ` · ${cleanDropoff}` : ""}`);
      resetForm();
      void refresh();
    } catch {
      const encoded = await Promise.all(
        photos.map(async (p) => ({ dataUrl: await fileToDataUrl(p.file), note: p.note.trim() })),
      );
      queueMovement({
        localId: crypto.randomUUID(),
        driver_id: user.id,
        shift_id: shift?.id ?? null,
        plate_state: plateState,
        plate: cleanPlate,
        vehicle_model: model.trim() || null,
        origin,
        destination,
        dropoff_location: cleanDropoff,
        occurred_at: occurredAt,
        latitude: geo.lat,
        longitude: geo.lng,
        notes: null,
        photos: encoded,
      });
      setPendingCount(readPending().length);
      setMessage("Sin conexión: guardado y se sincronizará automáticamente");
      resetForm();
    } finally {
      setBusy(false);
    }
  }

  async function sendNote(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !note.trim()) return;
    setNoteBusy(true);
    setNoteMsg(null);
    const { error } = await supabase.from("driver_notes").insert({
      driver_id: user.id,
      shift_id: shift?.id ?? null,
      body: note.trim(),
    });
    setNoteBusy(false);
    if (error) {
      setNoteMsg("No se pudo enviar la nota. Intenta de nuevo.");
      return;
    }
    setNote("");
    setNoteMsg("Nota enviada de forma privada a la administración.");
  }

  const canSubmit = Boolean(plate.trim() && origin && destination && photos.length > 0 && !busy);
  const dropoffHint = destination === "X" ? "Ej: CLEANERS, SHOP, TITE, OIL" : "Ej: D19, C04";

  return (
    <>
      <div className="bg-panel rounded-xl p-5 text-panel-foreground shadow-lg">
        <div className="flex justify-between items-start mb-4 gap-3">
          <PushToTalk />

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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold text-muted-foreground uppercase">
                Fotos ({photos.length}/{MAX_PHOTOS})
              </label>
              <span className="text-[10px] text-muted-foreground">Llave, entrega y ubicación</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: MAX_PHOTOS }).map((_, i) => {
                const p = photos[i];
                return (
                  <div key={i} className="space-y-1">
                    {p ? (
                      <>
                        <div className="relative aspect-[4/3] rounded-lg overflow-hidden border border-border">
                          <img src={p.preview} alt={`Foto ${i + 1} del movimiento`} className="size-full object-cover" />
                          <span className="absolute top-1 left-1 bg-panel text-panel-foreground text-[10px] font-bold px-1.5 py-0.5 rounded">
                            {i + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => removePhoto(i)}
                            className="absolute top-1 right-1 bg-destructive text-destructive-foreground text-[10px] font-bold px-1.5 py-0.5 rounded"
                          >
                            X
                          </button>
                        </div>
                        <input
                          value={p.note}
                          onChange={(e) => setPhotoNote(i, e.target.value)}
                          placeholder="Nota (ej: entregado)"
                          className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-[11px] outline-none focus:ring-2 focus:ring-ring"
                        />
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        disabled={i !== photos.length}
                        className="w-full aspect-[4/3] bg-secondary border-2 border-dashed border-border rounded-lg grid place-items-center disabled:opacity-40"
                      >
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">
                          {i === 0 ? "Foto 1 · obligatoria" : `Foto ${i + 1}`}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={pickPhoto}
            className="hidden"
          />

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

          <button
            type="button"
            onClick={() => scanRef.current?.click()}
            disabled={scanning}
            className="w-full bg-secondary border border-border rounded-lg py-2.5 text-[11px] font-bold uppercase tracking-widest text-foreground disabled:opacity-50"
          >
            {scanning ? "Leyendo placa…" : "Escanear placa con la cámara"}
          </button>
          <input
            ref={scanRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={scanPlate}
            className="hidden"
          />
          {scanMsg && <p className="text-[11px] text-muted-foreground">{scanMsg}</p>}


          <div className="space-y-1">
            <label className="text-[10px] font-bold text-muted-foreground uppercase">Marca / modelo</label>
            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setModelFromRegistry(false);
              }}
              placeholder="Toyota Corolla"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-medium outline-none focus:ring-2 focus:ring-ring"
            />
            {modelFromRegistry && (
              <p className="text-[10px] font-bold uppercase tracking-widest text-success">
                Modelo tomado del registro interno
              </p>
            )}
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

          <div className="space-y-1">
            <label className="text-[10px] font-bold text-muted-foreground uppercase">
              Ubicación donde se dejó el vehículo
            </label>
            <input
              value={dropoff}
              onChange={(e) => setDropoff(e.target.value.toUpperCase())}
              placeholder={dropoffHint}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono font-bold uppercase outline-none focus:ring-2 focus:ring-ring"
            />
            {destination === "X" && (
              <div className="flex gap-1 flex-wrap pt-1">
                {BASE_SPOTS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDropoff(s)}
                    className={`px-2 py-1 rounded text-[10px] font-bold ${dropoff === s ? "bg-primary text-primary-foreground" : "bg-secondary border border-border text-muted-foreground"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {origin && destination && plate && (
            <p className="font-mono text-sm font-bold">
              {plateState}-{plate} · {origin} → {destination}
              {dropoff ? ` · ${dropoff}` : ""} · {profile?.initials}
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
                    {m.dropoff_location ? ` • ${m.dropoff_location}` : ""}
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

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Nota privada</h2>
        <form onSubmit={sendNote} className="bg-card rounded-xl border border-border p-4 shadow-sm space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Solo la administración puede leer estas notas. No aparecen en el historial de movimientos ni para otros
            conductores.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="Retrasos, detalles del vehículo, incidencias, reportes…"
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {noteMsg && <p className="text-xs font-semibold text-primary">{noteMsg}</p>}
          <button
            type="submit"
            disabled={!note.trim() || noteBusy}
            className="w-full bg-panel disabled:opacity-50 text-panel-foreground font-bold py-3 rounded-xl uppercase tracking-widest text-xs"
          >
            {noteBusy ? "Enviando…" : "Enviar nota privada"}
          </button>
        </form>
      </section>
    </>
  );
}
