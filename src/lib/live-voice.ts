import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  PcmWavRecorder,
  isAudioUnlocked,
  playRadioTone,
  playWavAudio,
  unlockMobileAudio,
} from "@/lib/pcm-wav-recorder";

export type LiveVoiceState = {
  connected: boolean;
  peerCount: number;
  speaker: string | null;
  micReady: boolean;
  isTransmitting: boolean;
  audioUnlocked: boolean;
  error: string | null;
  lastPacket: { id: string; from: string; bytes: number; at: number } | null;
};

// Duración máxima de ráfaga de radio (8 segundos) para garantizar que el paquete WAV
// nunca sobrepase el límite de 256 KB del WebSocket de Supabase
const MAX_BURST_MS = 8000;

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
    isTransmitting: false,
    audioUnlocked: isAudioUnlocked(),
    error: null,
    lastPacket: null,
  });

  // ID único por pestaña/dispositivo para permitir pruebas entre dos teléfonos incluso con la misma cuenta
  const clientIdRef = useRef<string>(
    typeof window !== "undefined"
      ? (window.sessionStorage?.getItem("movpro.client_id") ??
          (() => {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            try {
              window.sessionStorage?.setItem("movpro.client_id", id);
            } catch {
              // Ignorar en navegación privada
            }
            return id;
          })())
      : "client"
  );

  const rtRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const recorderRef = useRef<PcmWavRecorder | null>(null);
  const isPressingRef = useRef(false);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uidRef = useRef<string | null>(userId);
  const nameRef = useRef(displayName);
  const audioQueueRef = useRef<{ id: string; url: string; who: string; bytes: number }[]>([]);
  const isPlayingAudioRef = useRef(false);

  uidRef.current = userId;
  nameRef.current = displayName;

  // Cola secuencial de reproducción de audio entrante
  const playNextInQueue = useCallback(async () => {
    const next = audioQueueRef.current.shift();
    if (!next) {
      isPlayingAudioRef.current = false;
      setState((prev) => ({ ...prev, speaker: null }));
      return;
    }

    isPlayingAudioRef.current = true;
    setState((prev) => ({
      ...prev,
      speaker: next.who,
      lastPacket: { id: next.id, from: next.who, bytes: next.bytes, at: Date.now() },
    }));

    // Tono de apertura de radio al comenzar a escuchar
    playRadioTone("start");

    try {
      await playWavAudio(next.url);
      // Roger beep al terminar la recepción
      playRadioTone("roger");
    } catch (err) {
      console.warn("[LiveVoice Playback] Error reproduciendo audio:", err);
    }

    void playNextInQueue();
  }, []);

  const enqueueAudio = useCallback(
    (id: string, audioUrl: string, speakerName: string, bytesCount: number) => {
      audioQueueRef.current.push({ id, url: audioUrl, who: speakerName, bytes: bytesCount });
      if (!isPlayingAudioRef.current) {
        void playNextInQueue();
      }
    },
    [playNextInQueue]
  );

  // Conectar al canal de Supabase Realtime Broadcast + Presence
  useEffect(() => {
    if (!enabled || !userId) return;

    let disposed = false;
    const safeChannelId = channelId || "general";
    const channelName = `ptt-room-${safeChannelId}`;

    const channel = supabase.channel(channelName, {
      config: {
        presence: { key: clientIdRef.current },
        broadcast: { self: false, ack: false },
      },
    });
    rtRef.current = channel;

    // Conteo de usuarios presentes en el canal
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

    // Aviso de que otro usuario empezó a hablar
    channel.on("broadcast", { event: "talk_start" }, ({ payload }) => {
      const data = payload as { fromClient: string; name: string };
      if (data.fromClient === clientIdRef.current) return;
      setState((prev) => ({ ...prev, speaker: data.name }));
      playRadioTone("start");
    });

    // Aviso de que otro usuario terminó de hablar
    channel.on("broadcast", { event: "talk_end" }, ({ payload }) => {
      const data = payload as { fromClient: string };
      if (data.fromClient === clientIdRef.current) return;
      if (!isPlayingAudioRef.current) {
        setState((prev) => ({ ...prev, speaker: null }));
      }
    });

    // Recepción inmediata del paquete de voz por WebSocket
    channel.on("broadcast", { event: "voice_packet" }, ({ payload }) => {
      const data = payload as {
        id?: string;
        fromClient: string;
        name: string;
        audioData: string;
        durationMs?: number;
      };
      if (data.fromClient === clientIdRef.current || !data.audioData) return;

      const packetId = data.id || crypto.randomUUID();
      if (onVoicePacketReceived) {
        onVoicePacketReceived(packetId);
      }
      const approxBytes = Math.round((data.audioData.length * 3) / 4);
      enqueueAudio(packetId, data.audioData, data.name, approxBytes);
    });

    channel.subscribe((status) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        setState((prev) => ({ ...prev, connected: true, error: null }));
        void channel.track({
          name: nameRef.current,
          clientId: clientIdRef.current,
          joinedAt: Date.now(),
        });
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
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      recorderRef.current?.stop();
      recorderRef.current = null;
      audioQueueRef.current = [];
      isPlayingAudioRef.current = false;
      setState({
        connected: false,
        peerCount: 0,
        speaker: null,
        micReady: false,
        isTransmitting: false,
        audioUnlocked: isAudioUnlocked(),
        error: null,
        lastPacket: null,
      });
    };
  }, [channelId, enabled, userId, enqueueAudio, onVoicePacketReceived]);

  // Transmitir (Pulsar para hablar)
  const startTransmit = useCallback(async (): Promise<boolean> => {
    isPressingRef.current = true;
    unlockMobileAudio();
    setState((prev) => ({ ...prev, audioUnlocked: true }));

    if (!recorderRef.current) {
      recorderRef.current = new PcmWavRecorder();
    }

    const ok = await recorderRef.current.start();
    if (!ok || !isPressingRef.current) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setState((prev) => ({
        ...prev,
        micReady: false,
        isTransmitting: false,
        error: ok ? null : "Permite el acceso al micrófono en los ajustes de tu navegador",
      }));
      return false;
    }

    setState((prev) => ({ ...prev, micReady: true, isTransmitting: true, error: null }));

    // Avisar en tiempo real que este usuario está hablando
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk_start",
      payload: {
        from: uidRef.current,
        fromClient: clientIdRef.current,
        name: nameRef.current,
        at: Date.now(),
      },
    });

    playRadioTone("start");

    // Temporizador de seguridad máximo (8 segundos de transmisión continua)
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    maxTimerRef.current = setTimeout(() => {
      if (isPressingRef.current) {
        void stopTransmit();
      }
    }, MAX_BURST_MS);

    return true;
  }, []);

  // Soltar botón para enviar el audio
  const stopTransmit = useCallback(async () => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }

    const wasPressing = isPressingRef.current;
    isPressingRef.current = false;
    setState((prev) => ({ ...prev, isTransmitting: false }));

    // Avisar que terminó de hablar
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk_end",
      payload: {
        from: uidRef.current,
        fromClient: clientIdRef.current,
        name: nameRef.current,
      },
    });

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder || !wasPressing) return;

    try {
      const result = await recorder.stop();
      if (!result) {
        return;
      }

      // Tono roger beep local para confirmación de envío
      playRadioTone("roger");

      // Transmisión inmediata vía WebSocket
      const msgId = crypto.randomUUID();
      void rtRef.current?.send({
        type: "broadcast",
        event: "voice_packet",
        payload: {
          id: msgId,
          from: uidRef.current,
          fromClient: clientIdRef.current,
          name: nameRef.current,
          audioData: result.wavBase64,
          durationMs: result.durationMs,
        },
      });

      setState((prev) => ({
        ...prev,
        lastPacket: {
          id: msgId,
          from: "Tú",
          bytes: Math.round((result.wavBase64.length * 3) / 4),
          at: Date.now(),
        },
      }));
    } catch (err) {
      console.error("[LiveVoice Stop] Error al detener y transmitir audio:", err);
    }
  }, []);

  return {
    ...state,
    startTransmit,
    stopTransmit,
    resumeAudio: unlockMobileAudio,
  };
}
