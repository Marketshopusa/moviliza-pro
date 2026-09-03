import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Voz en vivo tipo Zello: malla WebRTC entre los miembros del canal.
 * La señalización viaja por Supabase Realtime (broadcast + presence).
 * El micrófono se mantiene abierto pero silenciado; al presionar PTT se
 * habilita la pista y todos los conectados escuchan en tiempo real.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
];

type SignalPayload = {
  from: string;
  to: string;
  kind: "offer" | "answer" | "ice";
  data: unknown;
};

type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  polite: boolean;
  makingOffer: boolean;
};

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
}) {
  const { channelId, enabled, userId, displayName } = options;

  const [state, setState] = useState<LiveVoiceState>({
    connected: false,
    peerCount: 0,
    speaker: null,
    micReady: false,
    error: null,
  });

  const peersRef = useRef<Map<string, Peer>>(new Map());
  const streamRef = useRef<MediaStream | null>(null);
  const rtRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const nameRef = useRef(displayName);
  nameRef.current = displayName;
  const uidRef = useRef<string | null>(userId);
  uidRef.current = userId;

  const setPeerCount = useCallback(() => {
    setState((s) => ({ ...s, peerCount: peersRef.current.size }));
  }, []);

  useEffect(() => {
    if (!enabled || !channelId || !userId) return;

    let disposed = false;
    const peers = peersRef.current;

    const send = (payload: SignalPayload) => {
      void rtRef.current?.send({ type: "broadcast", event: "signal", payload });
    };

    const ensureMic = async () => {
      if (streamRef.current) return streamRef.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        stream.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        streamRef.current = stream;
        setState((s) => ({ ...s, micReady: true, error: null }));
        return stream;
      } catch {
        setState((s) => ({ ...s, micReady: false, error: "Permite el micrófono para hablar" }));
        return null;
      }
    };

    const createPeer = (peerId: string) => {
      const existing = peers.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");

      const peer: Peer = { pc, audio, polite: userId > peerId, makingOffer: false };
      peers.set(peerId, peer);
      setPeerCount();

      const stream = streamRef.current;
      if (stream) {
        stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      } else {
        pc.addTransceiver("audio", { direction: "recvonly" });
      }

      pc.ontrack = (ev) => {
        const [remote] = ev.streams;
        audio.srcObject = remote ?? new MediaStream([ev.track]);
        void audio.play().catch(() => {
          /* se reintenta con el próximo gesto del usuario */
        });
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) send({ from: userId, to: peerId, kind: "ice", data: ev.candidate.toJSON() });
      };

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          send({ from: userId, to: peerId, kind: "offer", data: pc.localDescription });
        } catch {
          /* ignorar */
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          removePeer(peerId);
        }
      };

      return peer;
    };

    const removePeer = (peerId: string) => {
      const peer = peers.get(peerId);
      if (!peer) return;
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.close();
      peer.audio.srcObject = null;
      peers.delete(peerId);
      setPeerCount();
    };

    const handleSignal = async (payload: SignalPayload) => {
      if (payload.to !== userId || payload.from === userId) return;
      const peer = createPeer(payload.from);
      const { pc } = peer;

      try {
        if (payload.kind === "offer") {
          const offerCollision = pc.signalingState !== "stable" || peer.makingOffer;
          if (offerCollision && !peer.polite) return;
          if (offerCollision) await pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
          await pc.setRemoteDescription(new RTCSessionDescription(payload.data as RTCSessionDescriptionInit));
          await pc.setLocalDescription();
          send({ from: userId, to: payload.from, kind: "answer", data: pc.localDescription });
        } else if (payload.kind === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.data as RTCSessionDescriptionInit));
          }
        } else if (payload.kind === "ice") {
          await pc.addIceCandidate(new RTCIceCandidate(payload.data as RTCIceCandidateInit));
        }
      } catch {
        /* señal fuera de orden: se recupera en la próxima negociación */
      }
    };

    const boot = async () => {
      await ensureMic();
      if (disposed) return;

      const rt = supabase.channel(`rtc-${channelId}`, {
        config: { presence: { key: userId }, broadcast: { self: false } },
      });
      rtRef.current = rt;

      rt.on("broadcast", { event: "signal" }, ({ payload }) => {
        void handleSignal(payload as SignalPayload);
      });

      rt.on("broadcast", { event: "talk" }, ({ payload }) => {
        const p = payload as { from: string; name: string; on: boolean };
        if (p.from === userId) return;
        setState((s) => ({ ...s, speaker: p.on ? p.name : s.speaker === p.name ? null : s.speaker }));
      });

      rt.on("presence", { event: "sync" }, () => {
        const ids = Object.keys(rt.presenceState());
        for (const id of ids) {
          if (id === userId || peers.has(id)) continue;
          // El id menor inicia la oferta para evitar colisiones.
          if (userId < id) createPeer(id);
        }
        for (const id of Array.from(peers.keys())) {
          if (!ids.includes(id)) removePeer(id);
        }
      });

      rt.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setState((s) => ({ ...s, connected: true }));
          void rt.track({ name: nameRef.current, at: Date.now() });
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          setState((s) => ({ ...s, connected: false }));
        }
      });
    };

    void boot();

    return () => {
      disposed = true;
      for (const id of Array.from(peers.keys())) removePeer(id);
      if (rtRef.current) void supabase.removeChannel(rtRef.current);
      rtRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setState({ connected: false, peerCount: 0, speaker: null, micReady: false, error: null });
    };
  }, [channelId, enabled, userId, setPeerCount]);

  const resumeAudio = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      void peer.audio.play().catch(() => {
        /* aún bloqueado */
      });
    }
  }, []);

  const startTransmit = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream) {
      setState((s) => ({ ...s, error: "Micrófono no disponible" }));
      return false;
    }
    stream.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk",
      payload: { from: uidRef.current, name: nameRef.current, on: true },
    });
    return true;
  }, []);

  const stopTransmit = useCallback(() => {
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk",
      payload: { from: uidRef.current, name: nameRef.current, on: false },
    });
  }, []);

  return { ...state, startTransmit, stopTransmit, resumeAudio };
}
