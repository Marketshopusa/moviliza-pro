import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  PcmWavRecorder,
  getGlobalAudioContext,
  playRadioTone,
  playWavAudio,
  unlockMobileAudio,
} from "@/lib/pcm-wav-recorder";

export type LiveVoiceState = {
  connected: boolean;
  peerCount: number;
  speaker: string | null;
  micReady: boolean;
  error: string | null;
};

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

  // ID único por pestaña/dispositivo para permitir pruebas entre dos teléfonos incluso con la misma cuenta de usuario
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
  const uidRef = useRef<string | null>(userId);
  const nameRef = useRef(displayName);
  const audioQueueRef = useRef<{ url: string; who: string }[]>([]);
  const isPlayingAudioRef = useRef(false);

  uidRef.current = userId;
  nameRef.current = displayName;

  // Desbloqueo y reproducción en cola
  const playNextInQueue = useCallback(async () => {
    const next = audioQueueRef.current.shift();
    if (!next) {
      isPlayingAudioRef.current = false;
      setState((prev) => ({ ...prev, speaker: null }));
      return;
    }

    isPlayingAudioRef.current = true;
    setState((prev) => ({ ...prev, speaker: next.who }));

    // Tono de entrada de radio
    playRadioTone("start");

    try {
      await playWavAudio(next.url);
      // Roger beep al terminar de escuchar
      playRadioTone("roger");
    } catch {
      // Continuar con el siguiente
    }

    void playNextInQueue();
  }, []);

  const enqueueAudio = useCallback(
    (audioUrl: string, speakerName: string) => {
      audioQueueRef.current.push({ url: audioUrl, who: speakerName });
      if (!isPlayingAudioRef.current) {
        void playNextInQueue();
      }
    },
    [playNextInQueue]
  );

  // Conectar al canal de Supabase Realtime Broadcast + Presence
  useEffect(() => {
    if (!enabled || !channelId || !userId) return;

    let disposed = false;
    const channelName = `ptt-room-${channelId}`;

    const channel = supabase.channel(channelName, {
      config: {
        presence: { key: clientIdRef.current },
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

    // Escuchar aviso de que alguien empezó a hablar
    channel.on("broadcast", { event: "talk_start" }, ({ payload }) => {
      const data = payload as { fromClient: string; name: string };
      if (data.fromClient === clientIdRef.current) return;
      setState((prev) => ({ ...prev, speaker: data.name }));
      playRadioTone("start");
    });

    // Escuchar aviso de que terminó de hablar
    channel.on("broadcast", { event: "talk_end" }, ({ payload }) => {
      const data = payload as { fromClient: string };
      if (data.fromClient === clientIdRef.current) return;
      if (!isPlayingAudioRef.current) {
        setState((prev) => ({ ...prev, speaker: null }));
      }
    });

    // Escuchar transmisión de voz inmediata por WebSocket
    channel.on("broadcast", { event: "voice_packet" }, ({ payload }) => {
      const data = payload as {
        id?: string;
        fromClient: string;
        name: string;
        audioData: string;
      };
      if (data.fromClient === clientIdRef.current || !data.audioData) return;
      if (data.id && onVoicePacketReceived) {
        onVoicePacketReceived(data.id);
      }
      enqueueAudio(data.audioData, data.name);
    });

    channel.subscribe((status) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        setState((prev) => ({ ...prev, connected: true }));
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
      recorderRef.current?.stop();
      recorderRef.current = null;
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
  }, [channelId, enabled, userId, enqueueAudio, onVoicePacketReceived]);

  // Transmitir (Pulsar para hablar)
  const startTransmit = useCallback(async (): Promise<boolean> => {
    isPressingRef.current = true;
    unlockMobileAudio();

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
        error: "Permite el acceso al micrófono en los ajustes de tu navegador",
      }));
      return false;
    }

    setState((prev) => ({ ...prev, micReady: true, error: null }));

    // Avisar al canal que este usuario está hablando
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
    return true;
  }, []);

  // Soltar botón para enviar el audio
  const stopTransmit = useCallback(async () => {
    isPressingRef.current = false;

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
    if (!recorder) return;

    const result = recorder.stop();
    if (!result) {
      return;
    }

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
  }, []);

  return {
    ...state,
    startTransmit,
    stopTransmit,
    resumeAudio: unlockMobileAudio,
  };
}