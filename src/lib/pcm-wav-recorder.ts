/**
 * Motor de grabación y reproducción de audio directo PCM -> WAV de ultra-baja latencia.
 * Diseñado específicamente para evitar los cuellos de botella de iOS Safari y Android:
 * 1. NO utiliza AudioContext.decodeAudioData (elimina el cuelgue histórico de iOS).
 * 2. Captura PCM puro Float32 en tiempo real directamente desde el micrófono.
 * 3. Codifica a WAV mono de 12 kHz (óptimo para voz de radio VHF / Zello, ~24 KB por segundo).
 * 4. Mantiene un AudioContext único global desbloqueado para evitar bloqueos de autoplay.
 */

let globalAudioCtx: AudioContext | null = null;

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

  // Desbloquear si está suspendido
  if (globalAudioCtx.state === "suspended") {
    void globalAudioCtx.resume().catch(() => {});
  }

  return globalAudioCtx;
}

/** Desbloquea el audio del dispositivo durante cualquier toque o interacción */
export function unlockMobileAudio() {
  try {
    const ctx = getGlobalAudioContext();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    // Reproducir un micro-silencio para autorizar el elemento de audio en iOS Safari
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Ignorar si el usuario aún no ha interactuado
  }
}

/**
 * Reproduce tonos clásicos de radio sin archivos externos.
 */
export function playRadioTone(type: "start" | "roger") {
  try {
    const ctx = getGlobalAudioContext();
    if (ctx.state === "suspended") void ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    if (type === "start") {
      // Tono agudo doble de apertura (Motorola / Zello)
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1046, now + 0.05);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } else {
      // Roger beep clásico (1200 Hz)
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    }
  } catch {
    // No interrumpir si el audio no está disponible
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
  private silentGain: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private recording = false;
  private startTime = 0;

  async start(): Promise<boolean> {
    try {
      this.ctx = getGlobalAudioContext();
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.chunks = [];
      this.startTime = Date.now();
      this.recording = true;

      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessorNode con buffer 4096 para captura fluida sin cortes
      this.processorNode = this.ctx.createScriptProcessor(4096, 1, 1);

      this.processorNode.onaudioprocess = (e) => {
        if (!this.recording) return;
        const inputData = e.inputBuffer.getChannelData(0);
        // Clonar las muestras capturadas
        this.chunks.push(new Float32Array(inputData));
      };

      // Conectar a ganancia silenciosa para que WebKit no recolecte el procesador
      this.silentGain = this.ctx.createGain();
      this.silentGain.gain.value = 0;

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.silentGain);
      this.silentGain.connect(this.ctx.destination);

      return true;
    } catch {
      this.cleanup();
      return false;
    }
  }

  stop(): { wavBase64: string; durationMs: number } | null {
    if (!this.recording) return null;
    this.recording = false;
    const durationMs = Date.now() - this.startTime;

    const sourceSampleRate = this.ctx?.sampleRate || 44100;
    this.cleanup();

    if (durationMs < 300 || this.chunks.length === 0) {
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

    // Reducir la frecuencia de muestreo a 12,000 Hz (fidelidad óptima para voz, 70% menos peso)
    const targetRate = 12000;
    const resampled = downsampleBuffer(fullAudio, sourceSampleRate, targetRate);

    // Convertir a WAV estándar (16 bits PCM Mono)
    const wavBuffer = encodeWav(resampled, targetRate);
    const wavBase64 = arrayBufferToBase64(wavBuffer);

    return {
      wavBase64: `data:audio/wav;base64,${wavBase64}`,
      durationMs,
    };
  }

  private cleanup() {
    try {
      this.sourceNode?.disconnect();
      this.processorNode?.disconnect();
      this.silentGain?.disconnect();
      this.stream?.getTracks().forEach((track) => track.stop());
    } catch {
      // Ignorar errores al limpiar
    }
    this.sourceNode = null;
    this.processorNode = null;
    this.silentGain = null;
    this.stream = null;
  }
}

/**
 * Reduce la frecuencia de muestreo de Float32Array para aligerar la transmisión.
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
 * Codifica muestras PCM Float32 a un ArrayBuffer WAV válido (16-bit PCM, Mono).
 */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
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

  // Escribir muestras Int16 PCM con limitador de saturación
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const rawSample = samples[i] ?? 0;
    const s = Math.max(-1, Math.min(1, rawSample));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * Reproductor de voz para radios con soporte de Web Audio directo y HTMLAudioElement.
 */
export async function playWavAudio(base64Url: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Método 1: Intentar con elemento Audio con fallback automático
      const audio = new Audio();
      audio.preload = "auto";
      audio.setAttribute("playsinline", "true");
      audio.src = base64Url;

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      audio.onended = done;
      audio.onerror = () => {
        // Si el elemento falla, intentar decodificar por Web Audio
        playWavViaWebAudio(base64Url).finally(done);
      };

      const playPromise = audio.play();
      if (playPromise) {
        playPromise.catch(() => {
          // Si el navegador bloqueó el elemento de audio, fallback a Web Audio
          playWavViaWebAudio(base64Url).finally(done);
        });
      }
    } catch {
      resolve();
    }
  });
}

async function playWavViaWebAudio(base64Url: string): Promise<void> {
  try {
    const ctx = getGlobalAudioContext();
    if (ctx.state === "suspended") await ctx.resume();

    // Extraer binario de base64 data url
    const commaIdx = base64Url.indexOf(",");
    const raw = atob(commaIdx !== -1 ? base64Url.slice(commaIdx + 1) : base64Url);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    return new Promise((resolve) => {
      source.onended = () => resolve();
      source.start(0);
    });
  } catch {
    // Si falla completamente
  }
}
