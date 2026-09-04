import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Voz en vivo tipo Zello: malla WebRTC entre los miembros del canal.
 * La señalización viaja por Supabase Realtime (broadcast + presence).
 * El micrófono se mantiene abierto pero silenciado; al presionar PTT se
 * habilita la pista y todos los conectados escuchan en tiempo real.
 *
 * La malla se auto-repara: un ciclo de reconciliación revisa cada pocos
 * segundos la presencia y el estado de cada conexión, reintenta ICE y
 * recrea los peers caídos (por ejemplo tras bloquear la pantalla).
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
];

const RECONCILE_MS = 3000;

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
  sender: RTCRtpSender | null;
  restartedAt: number;
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
  const talkingRef = useRef(false);
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
    let reconcileTimer: ReturnType<typeof setInterval> | null = null;

    const send = (payload: SignalPayload) => {
      void rtRef.current?.send({ type: "broadcast", event: "signal", payload });
    };

    const ensureMic = async () => {
      if (streamRef.current && streamRef.current.getAudioTracks().some((t) => t.readyState === "live")) {
        return streamRef.current;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        stream.getAudioTracks().forEach((t) => {
          t.enabled = talkingRef.current;
        });
        streamRef.current = stream;
        setState((s) => ({ ...s, micReady: true, error: null }));
        // Si ya había peers creados sin micrófono, se les adjunta ahora.
        for (const peer of peers.values()) attachLocalTrack(peer);
        return stream;
      } catch {
        setState((s) => ({ ...s, micReady: false, error: "Permite el micrófono para hablar" }));
        return null;
      }
    };

    const attachLocalTrack = (peer: Peer) => {
      const track = streamRef.current?.getAudioTracks()[0];
      if (!track || !peer.sender) return;
      if (peer.sender.track !== track) void peer.sender.replaceTrack(track);
    };

    const createPeer = (peerId: string) => {
      const existing = peers.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");

      const peer: Peer = {
        pc,
        audio,
        polite: userId > peerId,
        makingOffer: false,
        sender: null,
        restartedAt: 0,
      };
      peers.set(peerId, peer);
      setPeerCount();

      // Un único canal de audio bidireccional en ambos lados: así el audio
      // viaja siempre en las dos direcciones sin renegociaciones extra.
      const track = streamRef.current?.getAudioTracks()[0];
      const tx = pc.addTransceiver(track ?? "audio", { direction: "sendrecv" });
      peer.sender = tx.sender;
      attachLocalTrack(peer);


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

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "disconnected") tryIceRestart(peerId, peer);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          // Se recrea desde cero en el próximo ciclo de reconciliación.
          removePeer(peerId);
        } else if (pc.connectionState === "closed") {
          removePeer(peerId);
        }
      };

      return peer;
    };

    const tryIceRestart = (peerId: string, peer: Peer) => {
      if (peer.polite) return; // solo el lado impolite reinicia para evitar choques
      const now = Date.now();
      if (now - peer.restartedAt < 4000) return;
      peer.restartedAt = now;
      try {
        peer.pc.restartIce();
      } catch {
        removePeer(peerId);
      }
    };

    const removePeer = (peerId: string) => {
      const peer = peers.get(peerId);
      if (!peer) return;
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.oniceconnectionstatechange = null;
      try {
        peer.pc.close();
      } catch {
        /* ya cerrado */
      }
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
          attachLocalTrack(peer);
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

    const reconcile = () => {
      const rt = rtRef.current;
      if (!rt || disposed) return;
      const ids = Object.keys(rt.presenceState());

      // Cierra peers que ya no están presentes.
      for (const id of Array.from(peers.keys())) {
        if (!ids.includes(id)) removePeer(id);
      }

      for (const id of ids) {
        if (id === userId) continue;
        const peer = peers.get(id);
        if (!peer) {
          // El id menor inicia la oferta para evitar colisiones.
          if (userId < id) createPeer(id);
          continue;
        }
        attachLocalTrack(peer);
        if (peer.pc.connectionState === "failed" || peer.pc.connectionState === "closed") {
          removePeer(id);
          if (userId < id) createPeer(id);
        }
      }

      // Reafirma la presencia propia por si el socket se reconectó.
      void rt.track({ name: nameRef.current, at: Date.now() });
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

      rt.on("presence", { event: "sync" }, () => reconcile());
      rt.on("presence", { event: "join" }, () => reconcile());
      rt.on("presence", { event: "leave" }, () => reconcile());

      rt.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setState((s) => ({ ...s, connected: true }));
          void rt.track({ name: nameRef.current, at: Date.now() });
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setState((s) => ({ ...s, connected: false }));
        }
      });

      reconcileTimer = setInterval(() => {
        void ensureMic();
        reconcile();
      }, RECONCILE_MS);
    };

    void boot();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void ensureMic();
        reconcile();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (reconcileTimer) clearInterval(reconcileTimer);
      for (const id of Array.from(peers.keys())) removePeer(id);
      if (rtRef.current) void supabase.removeChannel(rtRef.current);
      rtRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      talkingRef.current = false;
      setState({ connected: false, peerCount: 0, speaker: null, micReady: false, error: null });
    };
  }, [channelId, enabled, userId, setPeerCount]);

  const resumeAudio = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      const el = peer.audio;
      if (el.paused || el.readyState === 0) {
        void el.play().catch(() => {
          /* aún bloqueado */
        });
      }
    }
  }, []);

  const startTransmit = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
      setState((s) => ({ ...s, error: "Micrófono no disponible" }));
      return false;
    }
    talkingRef.current = true;
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
    talkingRef.current = false;
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
