import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:global.stun.twilio.com:3478",
    ],
  },
];

const RECONCILE_MS = 2500;
const RESTART_AFTER_MS = 6000;

type SignalPayload = {
  from: string;
  to: string;
  callId: string;
  kind: "offer" | "answer" | "ice";
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  sender: RTCRtpSender;
  callId: string;
  initiator: boolean;
  pendingIce: RTCIceCandidateInit[];
  disconnectedAt: number | null;
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
  const uidRef = useRef<string | null>(userId);
  nameRef.current = displayName;
  uidRef.current = userId;

  const updateConnectedPeers = useCallback(() => {
    let connectedPeers = 0;
    for (const peer of peersRef.current.values()) {
      if (peer.pc.connectionState === "connected") connectedPeers += 1;
    }
    setState((current) => ({ ...current, peerCount: connectedPeers }));
  }, []);

  useEffect(() => {
    if (!enabled || !channelId || !userId) return;

    let disposed = false;
    let subscribed = false;
    let reconcileTimer: ReturnType<typeof setInterval> | null = null;
    const peers = peersRef.current;

    const send = (payload: SignalPayload) => {
      if (!subscribed || disposed) return;
      void rtRef.current?.send({ type: "broadcast", event: "signal", payload });
    };

    const attachCurrentMic = (peer: Peer) => {
      const track = streamRef.current?.getAudioTracks().find((item) => item.readyState === "live");
      if (track && peer.sender.track !== track) void peer.sender.replaceTrack(track);
    };

    const ensureMic = async () => {
      const currentTrack = streamRef.current?.getAudioTracks().find((track) => track.readyState === "live");
      if (currentTrack) return streamRef.current;

      try {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        stream.getAudioTracks().forEach((track) => {
          track.enabled = talkingRef.current;
        });
        streamRef.current = stream;
        for (const peer of peers.values()) attachCurrentMic(peer);
        setState((current) => ({ ...current, micReady: true, error: null }));
        return stream;
      } catch {
        setState((current) => ({ ...current, micReady: false, error: "Permite el micrófono para hablar" }));
        return null;
      }
    };

    const removePeer = (peerId: string) => {
      const peer = peers.get(peerId);
      if (!peer) return;
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      try {
        peer.pc.close();
      } catch {
        // La conexión ya estaba cerrada.
      }
      peer.audio.pause();
      peer.audio.srcObject = null;
      peer.audio.remove();
      peers.delete(peerId);
      updateConnectedPeers();
    };

    const flushIce = async (peer: Peer) => {
      if (!peer.pc.remoteDescription) return;
      const pending = peer.pendingIce.splice(0);
      for (const candidate of pending) {
        try {
          await peer.pc.addIceCandidate(candidate);
        } catch {
          // Candidato de una conexión anterior; la reconciliación la reemplaza.
        }
      }
    };

    const createPeer = (peerId: string, initiator: boolean, requestedCallId?: string) => {
      const existing = peers.get(peerId);
      if (existing) return existing;

      const callId = requestedCallId ?? crypto.randomUUID();
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.controls = false;
      audio.setAttribute("playsinline", "true");
      audio.style.display = "none";
      document.body.appendChild(audio);

      // Ambos teléfonos crean exactamente una vía bidireccional. Solamente el
      // identificador menor genera la oferta, evitando ofertas cruzadas en iOS.
      const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
      const peer: Peer = {
        pc,
        audio,
        sender: transceiver.sender,
        callId,
        initiator,
        pendingIce: [],
        disconnectedAt: null,
      };
      peers.set(peerId, peer);
      attachCurrentMic(peer);

      pc.ontrack = ({ streams, track }) => {
        audio.srcObject = streams[0] ?? new MediaStream([track]);
        audio.muted = false;
        void audio.play().catch(() => {
          // Safari reintentará durante el próximo gesto del usuario.
        });
      };

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        send({ from: userId, to: peerId, callId: peer.callId, kind: "ice", data: candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          peer.disconnectedAt = null;
          void audio.play().catch(() => {});
        } else if (pc.connectionState === "disconnected" && peer.disconnectedAt === null) {
          peer.disconnectedAt = Date.now();
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          removePeer(peerId);
        }
        updateConnectedPeers();
      };

      return peer;
    };

    const makeOffer = async (peerId: string) => {
      const peer = peers.get(peerId);
      if (!peer || !peer.initiator || peer.pc.signalingState !== "stable") return;
      try {
        attachCurrentMic(peer);
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        if (peer.pc.localDescription) {
          send({ from: userId, to: peerId, callId: peer.callId, kind: "offer", data: peer.pc.localDescription });
        }
      } catch {
        removePeer(peerId);
      }
    };

    const handleSignal = async (payload: SignalPayload) => {
      if (payload.to !== userId || payload.from === userId || disposed) return;

      if (payload.kind === "offer") {
        let peer = peers.get(payload.from);
        if (peer && peer.callId !== payload.callId) {
          removePeer(payload.from);
          peer = undefined;
        }
        if (!peer) peer = createPeer(payload.from, false, payload.callId);
        try {
          await peer.pc.setRemoteDescription(payload.data as RTCSessionDescriptionInit);
          await flushIce(peer);
          attachCurrentMic(peer);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          if (peer.pc.localDescription) {
            send({ from: userId, to: payload.from, callId: peer.callId, kind: "answer", data: peer.pc.localDescription });
          }
        } catch {
          removePeer(payload.from);
        }
        return;
      }

      const peer = peers.get(payload.from);
      if (!peer || peer.callId !== payload.callId) return;
      try {
        if (payload.kind === "answer") {
          if (peer.pc.signalingState === "have-local-offer") {
            await peer.pc.setRemoteDescription(payload.data as RTCSessionDescriptionInit);
            await flushIce(peer);
          }
        } else {
          const candidate = payload.data as RTCIceCandidateInit;
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
          else peer.pendingIce.push(candidate);
        }
      } catch {
        // Una señal tardía no debe destruir una conexión que sí está activa.
      }
    };

    const reconcile = () => {
      const realtime = rtRef.current;
      if (!realtime || !subscribed || disposed) return;
      const presentIds = Object.keys(realtime.presenceState());

      for (const peerId of Array.from(peers.keys())) {
        if (!presentIds.includes(peerId)) removePeer(peerId);
      }

      for (const peerId of presentIds) {
        if (peerId === userId) continue;
        const peer = peers.get(peerId);
        if (!peer) {
          if (userId < peerId) {
            createPeer(peerId, true);
            void makeOffer(peerId);
          }
          continue;
        }
        attachCurrentMic(peer);
        if (peer.disconnectedAt && Date.now() - peer.disconnectedAt > RESTART_AFTER_MS) {
          removePeer(peerId);
          if (userId < peerId) {
            createPeer(peerId, true);
            void makeOffer(peerId);
          }
        }
      }

      void realtime.track({ name: nameRef.current, at: Date.now() });
      updateConnectedPeers();
    };

    const boot = async () => {
      await ensureMic();
      if (disposed) return;

      const realtime = supabase.channel(`rtc-${channelId}`, {
        config: { presence: { key: userId }, broadcast: { self: false, ack: true } },
      });
      rtRef.current = realtime;
      realtime.on("broadcast", { event: "signal" }, ({ payload }) => void handleSignal(payload as SignalPayload));
      realtime.on("broadcast", { event: "talk" }, ({ payload }) => {
        const talk = payload as { from: string; name: string; on: boolean };
        if (talk.from === userId) return;
        setState((current) => ({
          ...current,
          speaker: talk.on ? talk.name : current.speaker === talk.name ? null : current.speaker,
        }));
      });
      realtime.on("presence", { event: "sync" }, reconcile);
      realtime.on("presence", { event: "join" }, reconcile);
      realtime.on("presence", { event: "leave" }, reconcile);
      realtime.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          setState((current) => ({ ...current, connected: true }));
          void realtime.track({ name: nameRef.current, at: Date.now() });
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          subscribed = false;
          setState((current) => ({ ...current, connected: false, peerCount: 0 }));
        }
      });

      reconcileTimer = setInterval(() => {
        void ensureMic();
        reconcile();
      }, RECONCILE_MS);
    };

    void boot();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void ensureMic();
      for (const peer of peers.values()) void peer.audio.play().catch(() => {});
      reconcile();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      subscribed = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (reconcileTimer) clearInterval(reconcileTimer);
      for (const peerId of Array.from(peers.keys())) removePeer(peerId);
      if (rtRef.current) void supabase.removeChannel(rtRef.current);
      rtRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      talkingRef.current = false;
      setState({ connected: false, peerCount: 0, speaker: null, micReady: false, error: null });
    };
  }, [channelId, enabled, userId, updateConnectedPeers]);

  const resumeAudio = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      peer.audio.muted = false;
      void peer.audio.play().catch(() => {});
    }
  }, []);

  const startTransmit = useCallback(async () => {
    const stream = streamRef.current;
    const track = stream?.getAudioTracks().find((item) => item.readyState === "live");
    const hasConnectedPeer = Array.from(peersRef.current.values()).some(
      (peer) => peer.pc.connectionState === "connected",
    );
    if (!track || !hasConnectedPeer) return false;
    talkingRef.current = true;
    track.enabled = true;
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk",
      payload: { from: uidRef.current, name: nameRef.current, on: true },
    });
    return true;
  }, []);

  const stopTransmit = useCallback(() => {
    talkingRef.current = false;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    void rtRef.current?.send({
      type: "broadcast",
      event: "talk",
      payload: { from: uidRef.current, name: nameRef.current, on: false },
    });
  }, []);

  return { ...state, startTransmit, stopTransmit, resumeAudio };
}