/**
 * Motor de grabación y reproducción de audio directo PCM -> WAV de ultra-baja latencia.
 * Diseñado específicamente para garantizar compatibilidad total e inmediata en:
 * - iOS Safari (iPhone / iPad)
 * - Android Chrome / WebView
 * - Computadoras (Chrome, Safari, Firefox, Edge)
 *
 * Características clave:
 * 1. Warm Mic Stream: Mantiene el micrófono caliente en memoria tras la primera activación (0ms de retraso en PTT).
 * 2. Captura PCM ScriptProcessor con buffer silencioso en salida para evitar suspensión en WebKit/iOS.
 * 3. Formato WAV Mono a 11,025 Hz (óptimo para voz humana, ~22 KB/segundo, 100% compatible sin códecs propietarios).
 * 4. Desbloqueo persistente de Autoplay mediante AudioContext global y elemento <audio> reusable.
 */

let globalAudioCtx: AudioContext | null = null;
let globalAudioEl: HTMLAudioElement | null = null;
let warmStream: MediaStream | null = null;
let warmStreamPromise: Promise<MediaStream | null> | null = null;
let isAudioUnlockedState = false;

/** Obtiene o inicializa el AudioContext global único */
export function getGlobalAudioContext(): AudioContext {
  if (typeof window === "undefined") {
    throw new Error("AudioContext solo disponible en navegador");
  }
  const AudioCtxClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!globalAudioCtx || globalAudioCtx.state === "closed") {
    globalAudioCtx = new AudioCtxClass();
  }

  return globalAudioCtx;
}

/** Obtiene o inicializa el elemento <audio> HTML5 reutilizable */
export function getGlobalAudioElement(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!globalAudioEl) {
    globalAudioEl = new Audio();
    globalAudioEl.setAttribute("playsinline", "true");
    globalAudioEl.setAttribute("webkit-playsinline", "true");
    globalAudioEl.preload = "auto";
  }
  return globalAudioEl;
}

/** Indica si el sistema de audio ya fue desbloqueado por un toque del usuario */
export function isAudioUnlocked(): boolean {
  return isAudioUnlockedState;
}

/** Micro-silencio WAV en base64 para desbloquear el elemento de audio */
const SILENT_WAV_BASE64 =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

/**
 * Desbloquea permanentemente el audio del dispositivo en iOS Safari y Android.
 * Se debe ejecutar en cualquier evento de interacción táctil (touchstart, pointerdown, click).
 */
export function unlockMobileAudio() {
  try {
    const ctx = getGlobalAudioContext();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    // Micro-buffer en Web Audio
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);

    // Micro-play en el elemento de audio para autorizar reproducción en segundo plano
    const el = getGlobalAudioElement();
    if (el) {
      el.src = SILENT_WAV_BASE64;
      el.play()
        .then(() => {
          el.pause();
          isAudioUnlockedState = true;
        })
        .catch(() => {});
    }

    isAudioUnlockedState = true;
  } catch {
    // Continuar si la interacción aún no se ha completado
  }
}

/**
 * Pre-solicita o reutiliza el stream del micrófono para que el PTT responda en 0ms.
 */
export async function getWarmMicStream(): Promise<MediaStream | null> {
  if (
    warmStream &&
    warmStream.active &&
    warmStream.getAudioTracks().some((t) => t.readyState === "live")
  ) {
    return warmStream;
  }

  if (warmStreamPromise) return warmStreamPromise;

  warmStreamPromise = (async () => {
    try {
      if (!navigator?.mediaDevices?.getUserMedia) return null;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      warmStream = stream;
      return stream;
    } catch (err) {
      console.warn("[PTT Mic] Permiso de micrófono pendiente o denegado:", err);
      return null;
    } finally {
      warmStreamPromise = null;
    }
  })();

  return warmStreamPromise;
}

/**
 * Genera tonos de radio clásicos Motorola / Zello mediante síntesis Web Audio pura.
 */
export function playRadioTone(type: "start" | "roger") {
  try {
    const ctx = getGlobalAudioContext();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    if (type === "start") {
      // Doble chirrido agudo de inicio de transmisión (880Hz -> 1046Hz)
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1046, now + 0.04);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else {
      // Roger beep clásico (1200Hz)
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }
  } catch {
    // Si no está disponible, no interrumpir
  }
}

/**
 * Grabador de voz en memoria que convierte muestras PCM directas a WAV estándar.
 */
export class PcmWavRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private recording = false;
  private startTime = 0;

  async start(): Promise<boolean> {
    try {
      this.ctx = getGlobalAudioContext();
      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => {});
      }

      this.stream = await getWarmMicStream();
      if (!this.stream) return false;

      // Asegurar que las pistas de audio estén activas
      this.stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });

      this.chunks = [];
      this.startTime = Date.now();
      this.recording = true;

      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessorNode con 4096 muestras por fragmento
      this.processorNode = this.ctx.createScriptProcessor(4096, 1, 1);

      this.processorNode.onaudioprocess = (e) => {
        if (!this.recording) return;
        const inputData = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(inputData));

        // Llenar el buffer de salida con ceros para que no haya retorno de eco
        // y para que WebKit/iOS nunca suspenda el nodo de audio por inactividad.
        const outputData = e.outputBuffer.getChannelData(0);
        outputData.fill(0);
      };

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.ctx.destination);

      return true;
    } catch (err) {
      console.error("[PTT Recorder] Error al iniciar captura de audio:", err);
      this.cleanup();
      return false;
    }
  }

  async stop(): Promise<{ wavBase64: string; durationMs: number } | null> {
    if (!this.recording) return null;
    this.recording = false;
    const durationMs = Date.now() - this.startTime;

    const sourceSampleRate = this.ctx?.sampleRate || 44100;
    this.cleanup();

    // Descartar clics accidentales de menos de 250ms o si no hubo muestras
    if (durationMs < 250 || this.chunks.length === 0) {
      this.chunks = [];
      return null;
    }

    // Unir todos los fragmentos capturados
    let totalLength = 0;
    for (const chunk of this.chunks) totalLength += chunk.length;
    const fullAudio = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      fullAudio.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    // Reducir la frecuencia de muestreo a 11,025 Hz (ancho de banda óptimo para radiotelefonía)
    const targetRate = 11025;
    const resampled = downsampleBuffer(fullAudio, sourceSampleRate, targetRate);

    // Codificar a WAV estándar (16-bit PCM Mono)
    const wavBlob = encodeWavBlob(resampled, targetRate);
    const wavBase64 = await blobToDataUrl(wavBlob);

    return {
      wavBase64,
      durationMs,
    };
  }

  private cleanup() {
    try {
      this.sourceNode?.disconnect();
      this.processorNode?.disconnect();
    } catch {
      // Ignorar errores al desconectar nodos
    }
    this.sourceNode = null;
    this.processorNode = null;
    // IMPORTANTE: NO detenemos las pistas de this.stream para mantener el micrófono caliente (0ms en la siguiente pulsación)
    this.stream = null;
  }
}

/**
 * Reduce la frecuencia de muestreo de Float32Array mediante promediado simple.
 */
function downsampleBuffer(buffer: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (outputRate >= inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i] ?? 0;
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

/**
 * Codifica muestras PCM Float32 a un Blob WAV estándar (16-bit PCM Mono).
 */
function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, "RIFF");
  // file length
  view.setUint32(4, 36 + samples.length * 2, true);
  // RIFF type
  writeString(view, 8, "WAVE");
  // format chunk identifier
  writeString(view, 12, "fmt ");
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (1 = PCM)
  view.setUint16(20, 1, true);
  // channel count (1 = mono)
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sampleRate * 2 bytes * 1 channel)
  view.setUint32(28, sampleRate * 2, true);
  // block align (2 bytes)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, "data");
  // data chunk length
  view.setUint32(40, samples.length * 2, true);

  // Escribir muestras Int16 PCM con limitador contra saturación
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const rawSample = samples[i] ?? 0;
    const s = Math.max(-1, Math.min(1, rawSample));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Convierte un Blob a Data URL Base64 de forma ultra-rápida y nativa.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Error al convertir audio a Base64"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const commaIdx = dataUrl.indexOf(",");
  const base64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Reproductor de voz para radio con estrategia dual (Web Audio Buffer + Elemento Reusable).
 * Garantiza reproducción sin bloqueo de autoplay en iOS y Android.
 */
export async function playWavAudio(base64Url: string): Promise<void> {
  const ctx = getGlobalAudioContext();
  const audioEl = getGlobalAudioElement();

  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    // Método 1: Reproducción directa por Web Audio Buffer (instantánea, sin latencia de decodificador)
    const tryWebAudio = async (): Promise<boolean> => {
      try {
        if (ctx.state === "suspended") {
          await ctx.resume().catch(() => {});
        }
        if (ctx.state !== "running") return false;

        const arrayBuf = dataUrlToArrayBuffer(base64Url);
        const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = done;
        source.start(0);
        return true;
      } catch {
        return false;
      }
    };

    // Método 2: Elemento de audio HTML5 pre-desbloqueado
    const tryAudioElement = () => {
      if (!audioEl) {
        done();
        return;
      }
      audioEl.src = base64Url;
      audioEl.onended = done;
      audioEl.onerror = () => done();
      const p = audioEl.play();
      if (p) {
        p.catch(() => {
          done();
        });
      }
    };

    // Probar Web Audio primero; si no está activo, usar elemento de audio
    tryWebAudio()
      .then((ok) => {
        if (!ok) tryAudioElement();
      })
      .catch(() => {
        tryAudioElement();
      });

    // Tiempo límite de seguridad (10 segundos) por si el audio no notifica fin
    setTimeout(done, 10000);
  });
}
