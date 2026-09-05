import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type LiveVoiceState = {
  connected: boolean;
  peerCount: number;
  speaker: string | null;
  micReady: boolean;
  error: string | null;
};

// Generador de tonos de radio Motorola / Zello mediante síntesis Web Audio pura (0 archivos externos)
function playTone(type: "start" | "end" | "squelch") {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (type === "start") {
      // Doble chirrido agudo de inicio de transmisión (880Hz -> 1046Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1046, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => void ctx.close();
    } else if (type === "end" || type === "squelch") {
      // Roger beep corto clásico (1200Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.005, ctx.currentTime + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.06);
      osc.onended = () => void ctx.close();
    }
  } catch {
    // Ignorar si el audio no está disponible
  }
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/**
 * Convierte un Blob de audio grabado a formato estándar WAV mono de 16kHz
 * Universalmente compatible con iOS Safari, Android Chrome y Desktop sin códecs propietarios.
 */
export async function convertBlobToWav(source: Blob): Promise<Blob> {
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextClass();
  try {
    const arrayBuf = await source.arrayBuffer();
    const decoded = await context.decodeAudioData(arrayBuf);
    // 12 kHz mono: óptimo para walkie-talkie/radio (voz nítida y tamaño de paquete ligero)
    const targetRate = 12000;
    const frameCount = Math.max(1, Math.floor(decoded.duration * targetRate));
    const mono = new Float32Array(frameCount);
    const ratio = decoded.sampleRate / targetRate;

    for (let frame = 0; frame < frameCount; frame += 1) {
      const sourceFrame = Math.min(decoded.length - 1, Math.floor(frame * ratio));
      let sample = 0;
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        sample += decoded.getChannelData(channel)[sourceFrame] ?? 0;
      }
      mono[frame] = sample / decoded.numberOfChannels;
    }

    const buffer = new ArrayBuffer(44 + mono.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + mono.length * 2, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); // 16-bit
    writeAscii(view, 36, "data");
    view.setUint32(40, mono.length * 2, true);
    for (let index = 0; index < mono.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, mono[index] ?? 0));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    void context.close();
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Error al convertir audio a base64"));
    reader.readAsDataURL(blob);
  });
}

export function useLiveVoice(options: {
  channelId: string | null;
  enabled: boolean;
  userId: string | null;
  displayName: string;
  onVoicePacketReceived?: (id: string) => void;
}) {
  const { channelId, enabled, userId, displayName, onVoicePacketReceived } = options;
  const [state, setState] = useState<LiveVoiceState>({
    connected: false,
    peerCount: 0,
    speaker: null,
    micReady: false,
    error: null,
  });

  const rtRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isPressingRef = useRef(false);
  const recordStartTimeRef = useRef<number>(0);
  const uidRef = useRef<string | null>(userId);
  const nameRef = useRef(displayName);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioQueueRef = useRef<{ url: string; who: string }[]>([]);
  const isPlayingAudioRef = useRef(false);

  uidRef.current = userId;
  nameRef.current = displayName;

  // Desbloqueo y reproducción de audio persistente para móviles
  const getAudioPlayer = useCallback(() => {
    if (!audioPlayerRef.current && typeof window !== "undefined") {
      const audio = new Audio();
      audio.preload = "auto";
      audio.setAttribute("playsinline", "true");
      audioPlayerRef.current = audio;
    }
    return audioPlayerRef.current;
  }, []);

  const playNextInQueue = useCallback(() => {
    const next = audioQueueRef.current.shift();
    if (!next) {
      isPlayingAudioRef.current = false;
      setState((prev) => ({ ...prev, speaker: null }));
      return;
    }

    isPlayingAudioRef.current = true;
    setState((prev) => ({ ...prev, speaker: next.who }));

    const player = getAudioPlayer();
    if (!player) return;

    player.onended = () => {
      playTone("end");
      playNextInQueue();
    };
    player.onerror = () => {
      playNextInQueue();
    };

    player.src = next.url;
    player.muted = false;
    player.play().catch(() => {
      // Si el navegador bloqueó la reproducción automática, avanzar
      playNextInQueue();
    });
  }, [getAudioPlayer]);

  const enqueueAudio = useCallback(
    (audioUrl: string, speakerName: string) => {
      audioQueueRef.current.push({ url: audioUrl, who: speakerName });
      if (!isPlayingAudioRef.current) {
        playTone("start");
        playNextInQueue();
      }
    },
    [playNextInQueue]
  );

  // Inicializar o reutilizar el micrófono de forma segura
  const obtainMicStream = useCallback(async () => {
    const existing = streamRef.current?.getAudioTracks().find((t) => t.readyState === "live");
    if (existing) return streamRef.current;

    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      setState((prev) => ({ ...prev, micReady: true, error: null }));
      return stream;
    } catch {
      setState((prev) => ({ ...prev, micReady: false, error: "Permite el acceso al micrófono para hablar" }));
      return null;
    }
  }, []);

  // Conectar al canal de Supabase Realtime Broadcast + Presence
  useEffect(() => {
    if (!enabled || !channelId || !userId) return;

    let disposed = false;
    const channelName = `ptt-room-${channelId}`;

    const channel = supabase.channel(channelName, {
      config: {
        presence: { key: userId },
        broadcast: { self: false, ack: true },
      },
    });
    rtRef.current = channel;

    // Escuchar presencia para saber cuántos conductores están en el canal
    const updatePresence = () => {
      if (disposed) return;
      const stateObj = channel.presenceState();
      const count = Object.keys(stateObj).length;
      setState((prev) => ({ ...prev, peerCount: Math.max(0, count - 1) }));
    };

    channel
      .on("presence", { event: "sync" }, updatePresence)
      .on("presence", { event: "join" }, updatePresence)
      .on("presence", { event: "leave" }, updatePresence);

    // Escuchar avisos de "alguien empezó a hablar"
    channel.on("broadcast", { event: "talk_start" }, ({ payload }) => {
      const data = payload as { from: string; name: string };
      if (data.from === userId) return;
      setState((prev) => ({ ...prev, speaker: data.name }));
      playTone("start");
    });

    // Escuchar avisos de "terminó de hablar"
    channel.on("broadcast", { event: "talk_end" }, ({ payload }) => {
      const data = payload as { from: string };
      if (data.from === userId) return;
      if (!isPlayingAudioRef.current) {
        setState((prev) => ({ ...prev, speaker: null }));
      }
    });

    // Mapa en memoria para ensamblar audios transmitidos en fragmentos
    const chunkAssembly = new Map<string, { chunks: string[]; received: number; total: number; name: string }>();

    // Escuchar transmisión de audio directa vía WebSocket (Sub-second latency)
    channel.on("broadcast", { event: "voice_packet" }, ({ payload }) => {
      const data = payload as { id?: string; from: string; name: string; audioData: string };
      if (data.from === userId || !data.audioData) return;
      if (data.id && onVoicePacketReceived) {
        onVoicePacketReceived(data.id);
      }
      enqueueAudio(data.audioData, data.name);
    });

    // Escuchar fragmentos para mensajes más largos (sin límite de tamaño por WebSocket)
    channel.on("broadcast", { event: "voice_chunk" }, ({ payload }) => {
      const data = payload as { id: string; from: string; name: string; index: number; total: number; chunk: string };
      if (data.from === userId || !data.chunk) return;
      let entry = chunkAssembly.get(data.id);
      if (!entry) {
        entry = { chunks: new Array(data.total), received: 0, total: data.total, name: data.name };
        chunkAssembly.set(data.id, entry);
      }
      if (!entry.chunks[data.index]) {
        entry.chunks[data.index] = data.chunk;
        entry.received++;
      }
      if (entry.received === entry.total) {
        chunkAssembly.delete(data.id);
        const completeAudio = entry.chunks.join("");
        if (data.id && onVoicePacketReceived) {
          onVoicePacketReceived(data.id);
        }
        enqueueAudio(completeAudio, entry.name);
      }
    });

    channel.subscribe((status) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        setState((prev) => ({ ...prev, connected: true }));
        void channel.track({ name: nameRef.current, joinedAt: Date.now() });
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setState((prev) => ({ ...prev, connected: false, peerCount: 0 }));
      }
    });

    return () => {
      disposed = true;
      if (rtRef.current) {
        void supabase.removeChannel(rtRef.current);
        rtRef.current = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audioQueueRef.current = [];
      isPlayingAudioRef.current = false;
      setState({
        connected: false,
        peerCount: 0,
        speaker: null,
        micReady: false,
        error: null,
      });
    };
  }, [channelId, enabled, userId, enqueueAudio]);

  // Desbloqueo pasivo en cualquier toque
  const resumeAudio = useCallback(() => {
    const player = getAudioPlayer();
    if (player && player.paused && isPlayingAudioRef.current) {
      void player.play().catch(() => {});
    }
  }, [getAudioPlayer]);

  // Transmitir (Pulsar para hablar)
  const startTransmit = useCallback(async (): Promise<boolean> => {
    isPressingRef.current = true;
    const stream = await obtainMicStream();
    if (!stream || !isPressingRef.current) return false;

    // Avisar por Realtime que este usuario empezó a hablar (enciende el indicador rojo en todos los radios)
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk_start",
      payload: { from: uidRef.current, name: nameRef.current, at: Date.now() },
    });

    playTone("start");

    try {
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "audio/webm";

      const rec = new MediaRecorder(stream, { mimeType: mime });
      audioChunksRef.current = [];
      recordStartTimeRef.current = Date.now();

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorderRef.current = rec;
      rec.start(100);

      // Si el usuario ya soltó el botón antes de que el recorder iniciara (pulsación ultra rápida)
      if (!isPressingRef.current) {
        rec.stop();
        return false;
      }

      return true;
    } catch {
      setState((prev) => ({ ...prev, error: "No se pudo iniciar el grabador de audio" }));
      return false;
    }
  }, [obtainMicStream]);

  // Detener transmisión y enviar (Soltar botón) — Comunicación 100% efímera (0 base de datos)
  const stopTransmit = useCallback(
    async () => {
      isPressingRef.current = false;
      const rec = recorderRef.current;
      recorderRef.current = null;

      void rtRef.current?.send({
        type: "broadcast",
        event: "talk_end",
        payload: { from: uidRef.current, name: nameRef.current },
      });

      if (!rec || rec.state === "inactive") return;

      const finishPromise = new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          const rawBlob = new Blob(audioChunksRef.current, { type: rec.mimeType || "audio/webm" });
          resolve(rawBlob);
        };
      });

      rec.stop();
      const rawBlob = await finishPromise;
      const duration = Date.now() - recordStartTimeRef.current;

      if (duration < 350 || rawBlob.size === 0) {
        return;
      }

      // Convertir a WAV estándar universal (12kHz mono para máxima ligereza y fidelidad de voz)
      let wavBlob: Blob;
      try {
        wavBlob = await convertBlobToWav(rawBlob);
      } catch {
        wavBlob = rawBlob;
      }

      const msgId = crypto.randomUUID();

      // Transmisión inmediata en tiempo real vía WebSocket a todos los miembros activos del canal
      try {
        const base64Data = await blobToBase64(wavBlob);
        const CHUNK_SIZE = 100000; // 100KB seguro por paquete para Supabase Realtime

        if (base64Data.length <= CHUNK_SIZE) {
          void rtRef.current?.send({
            type: "broadcast",
            event: "voice_packet",
            payload: {
              id: msgId,
              from: uidRef.current,
              name: nameRef.current,
              audioData: base64Data,
              durationMs: duration,
            },
          });
        } else {
          const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
          for (let i = 0; i < totalChunks; i++) {
            const chunk = base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            void rtRef.current?.send({
              type: "broadcast",
              event: "voice_chunk",
              payload: {
                id: msgId,
                from: uidRef.current,
                name: nameRef.current,
                index: i,
                total: totalChunks,
                chunk,
              },
            });
          }
        }
      } catch {
        // En caso de fallo de red en el dispositivo
      }
    },
    []
  );

  return {
    ...state,
    startTransmit,
    stopTransmit,
    resumeAudio,
  };
}