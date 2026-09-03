import { useEffect, useRef, useState } from "react";
import { createPlateWorker, readPlateFrom, type PlateRead } from "@/lib/plate-ocr";

type Props = {
  open: boolean;
  onClose: () => void;
  onDetected: (read: PlateRead) => void;
};

/** Sonido corto de confirmación cuando la placa queda leída. */
function playBeep() {
  try {
    const Ctx = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => void ctx.close();
  } catch {
    /* sin audio disponible */
  }
}

/**
 * Escáner en vivo: abre la cámara y lee la placa continuamente,
 * sin necesidad de tomar una fotografía.
 */
export function PlateScanner({ open, onClose, onDetected }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("Abriendo la cámara…");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let worker: Awaited<ReturnType<typeof createPlateWorker>> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function start() {
      try {
        // Carga el motor OCR en paralelo con la cámara para que esté listo antes.
        const workerPromise = createPlateWorker();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setReady(true);
        setStatus("Enfoca la placa dentro del recuadro…");
        worker = await workerPromise;
        if (cancelled) return;
        void loop();
      } catch {
        if (!cancelled) setStatus("No se pudo abrir la cámara. Revisa los permisos del navegador.");
      }
    }

    async function loop() {
      if (cancelled || !worker) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.videoWidth > 0) {
        // Recorta la franja central y la reduce: menos píxeles = lectura más rápida.
        const cw = Math.round(video.videoWidth * 0.8 * 0.6);
        const ch = Math.round(video.videoHeight * 0.32 * 0.6);
        const sx = Math.round((video.videoWidth * 0.1) * 0.6);
        const sy = Math.round((video.videoHeight * 0.34) * 0.6);
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, video.videoWidth * 0.1, video.videoHeight * 0.34, video.videoWidth * 0.8, video.videoHeight * 0.32, 0, 0, cw, ch);
          // Aumenta contraste en escala de grises para mejorar la lectura.
          const img = ctx.getImageData(0, 0, cw, ch);
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
            const v = g > 140 ? 255 : g < 90 ? 0 : g;
            d[i] = v;
            d[i + 1] = v;
            d[i + 2] = v;
          }
          ctx.putImageData(img, 0, 0);
          try {
            const read = await readPlateFrom(worker, canvas);
            if (cancelled) return;
            if (read.plate) {
              setStatus(`Placa detectada: ${read.plate}`);
              playBeep();
              onDetected(read);
              onClose();
              return;
            }
          } catch {
            /* reintenta */
          }
        }
      }
      // Relanza de inmediato: el OCR ya toma su propio tiempo, sin espera extra.
      if (!cancelled) timer = setTimeout(() => void loop(), 80);
    }

    void start();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void worker?.terminate();
    };
  }, [open, onClose, onDetected]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4">
      <div className="relative w-full max-w-md aspect-[3/4] rounded-xl overflow-hidden bg-black">
        <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
        <div className="pointer-events-none absolute inset-x-[10%] top-1/2 -translate-y-1/2 h-[32%] border-2 border-accent rounded-lg" />
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <p className="mt-4 text-xs font-bold uppercase tracking-widest text-white text-center">
        {ready ? status : "Abriendo la cámara…"}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-4 bg-secondary text-foreground font-bold uppercase text-[11px] tracking-widest px-6 py-3 rounded-lg"
      >
        Cancelar
      </button>
    </div>
  );
}
