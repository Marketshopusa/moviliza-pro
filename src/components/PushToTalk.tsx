import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

type Channel = { id: string; name: string; is_admin_only: boolean };

const LAST_CHANNEL_KEY = "movpro.voice.channel";

export function PushToTalk() {
  const { user, isSupervisor, isAdmin, profile } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [pendingJoin, setPendingJoin] = useState<Channel | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [managePass, setManagePass] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef<number>(0);
  const queueRef = useRef<{ url: string; who: string }[]>([]);
  const playingRef = useRef(false);
  const namesRef = useRef<Record<string, string>>({});
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);

  // Un único elemento de audio reutilizado: los navegadores móviles solo permiten
  // reproducir en un elemento que ya fue "desbloqueado" por un gesto del usuario.
  const getAudioEl = useCallback(() => {
    if (!audioElRef.current && typeof window !== "undefined") {
      const el = new Audio();
      el.preload = "auto";
      el.setAttribute("playsinline", "true");
      audioElRef.current = el;
    }
    return audioElRef.current;
  }, []);

  const unlockAudio = useCallback(async () => {
    const el = getAudioEl();
    if (!el || unlockedRef.current) return;
    try {
      el.muted = true;
      el.src =
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
      await el.play();
      el.pause();
      el.currentTime = 0;
      el.muted = false;
      unlockedRef.current = true;
      setNeedsUnlock(false);
    } catch {
      setNeedsUnlock(true);
    }
  }, [getAudioEl]);

  // Cualquier toque en la pantalla habilita la reproducción de audio entrante.
  useEffect(() => {
    const handler = () => void unlockAudio();
    window.addEventListener("pointerdown", handler, { once: false });
    return () => window.removeEventListener("pointerdown", handler);
  }, [unlockAudio]);

  const channel = channels.find((c) => c.id === channelId) ?? null;
  const isMember = channelId ? memberIds.includes(channelId) : false;

  const load = useCallback(async () => {
    if (!user) return;
    const [{ data: ch }, { data: mem }] = await Promise.all([
      supabase.from("voice_channels").select("id, name, is_admin_only").order("created_at"),
      supabase.from("voice_channel_members").select("channel_id").eq("user_id", user.id),
    ]);
    const list = (ch as Channel[]) ?? [];
    setChannels(list);
    setMemberIds((mem ?? []).map((m) => m.channel_id as string));
    setChannelId((prev) => {
      if (prev) return prev;
      const stored = typeof window !== "undefined" ? window.localStorage.getItem(LAST_CHANNEL_KEY) : null;
      if (stored && list.some((c) => c.id === stored)) return stored;
      return list.find((c) => !c.is_admin_only)?.id ?? list[0]?.id ?? null;
    });
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresca la lista cada vez que se abre el selector de canales,
  // para ver canales creados desde otros dispositivos.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (channelId && typeof window !== "undefined") window.localStorage.setItem(LAST_CHANNEL_KEY, channelId);
  }, [channelId]);

  const playNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      playingRef.current = false;
      setSpeaking(null);
      return;
    }
    playingRef.current = true;
    setSpeaking(next.who);
    const audio = getAudioEl();
    if (!audio) return;
    audio.onended = () => playNext();
    audio.onerror = () => playNext();
    audio.muted = false;
    audio.src = next.url;
    void audio.play().catch(() => {
      setNeedsUnlock(true);
      playNext();
    });
  }, [getAudioEl]);

  const enqueue = useCallback(
    async (path: string, senderId: string) => {
      const { data } = await supabase.storage.from("voice-clips").createSignedUrl(path, 3600);
      if (!data?.signedUrl) return;
      let who = namesRef.current[senderId];
      if (!who) {
        const { data: p } = await supabase.rpc("public_profiles", { _ids: [senderId] });
        const row = (p as { full_name: string; initials: string }[] | null)?.[0];
        who = (row?.initials || row?.full_name || "Conductor") as string;
        namesRef.current[senderId] = who;
      }
      queueRef.current.push({ url: data.signedUrl, who });
      if (!playingRef.current) playNext();
    },
    [playNext],
  );

  useEffect(() => {
    if (!channelId || !isMember || !user) return;
    const sub = supabase
      .channel(`voice-${channelId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "voice_messages", filter: `channel_id=eq.${channelId}` },
        (payload) => {
          const row = payload.new as { audio_path: string; sender_id: string };
          if (row.sender_id === user.id) return;
          void enqueue(row.audio_path, row.sender_id);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(sub);
    };
  }, [channelId, isMember, user, enqueue]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingJoin) return;
    setStatus(null);
    const { data, error } = await supabase.rpc("join_voice_channel", {
      _channel_id: pendingJoin.id,
      _passcode: passcode,
    });
    if (error) {
      setStatus(error.message.includes("administración") ? "Canal exclusivo de administración." : "No se pudo entrar al canal.");
      return;
    }
    if (!data) {
      setStatus("Clave incorrecta.");
      return;
    }
    setPasscode("");
    setPendingJoin(null);
    setChannelId(pendingJoin.id);
    setStatus(`Conectado a ${pendingJoin.name}`);
    void load();
  }

  async function createChannel(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const { data, error } = await supabase.rpc("create_voice_channel", {
      _name: newName.trim(),
      _passcode: newPass.trim(),
      _is_admin_only: newAdmin,
    });
    if (error) {
      setStatus(error.message);
      return;
    }
    setNewName("");
    setNewPass("");
    setNewAdmin(false);
    setChannelId(data as string);
    setStatus("Canal creado");
    void load();
  }

  async function changePasscode(e: React.FormEvent) {
    e.preventDefault();
    if (!manageId) return;
    setStatus(null);
    const { error } = await supabase.rpc("update_voice_channel_passcode", {
      _channel_id: manageId,
      _passcode: managePass.trim(),
    });
    if (error) {
      setStatus(error.message);
      return;
    }
    setManagePass("");
    setManageId(null);
    setStatus("Clave actualizada. Los demás deberán ingresarla de nuevo.");
    void load();
  }

  async function removeChannel(id: string, name: string) {
    if (!window.confirm(`¿Eliminar el canal "${name}"? Se borrarán sus audios.`)) return;
    const { error } = await supabase.rpc("delete_voice_channel", { _channel_id: id });
    if (error) {
      setStatus(error.message);
      return;
    }
    if (channelId === id) setChannelId(null);
    setStatus("Canal eliminado");
    void load();
  }



  async function startTalk() {
    if (!user || !channelId || !isMember || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      startedRef.current = Date.now();
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const duration = Date.now() - startedRef.current;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (duration < 400 || blob.size === 0) {
          setStatus("Transmisión muy corta");
          return;
        }
        const path = `${user.id}/${crypto.randomUUID()}.webm`;
        const { error: upErr } = await supabase.storage.from("voice-clips").upload(path, blob, {
          contentType: blob.type,
          upsert: false,
        });
        if (upErr) {
          setStatus("No se pudo enviar el audio");
          return;
        }
        const { error } = await supabase.from("voice_messages").insert({
          channel_id: channelId,
          sender_id: user.id,
          audio_path: path,
          duration_ms: duration,
        });
        setStatus(error ? "No se pudo enviar el audio" : `Enviado · ${(duration / 1000).toFixed(1)}s`);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setStatus(null);
    } catch {
      setStatus("Permite el acceso al micrófono para hablar");
    }
  }

  function stopTalk() {
    if (!recording) return;
    setRecording(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  const visibleChannels = channels.filter((c) => !c.is_admin_only || isSupervisor);

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col items-center gap-1 shrink-0">
        <button
          type="button"
          aria-label="Mantén presionado para hablar"
          disabled={!isMember}
          onPointerDown={(e) => {
            e.preventDefault();
            setPressed(true);
            void startTalk();
          }}
          onPointerUp={() => {
            setPressed(false);
            stopTalk();
          }}
          onPointerLeave={() => {
            setPressed(false);
            stopTalk();
          }}
          onPointerCancel={() => {
            setPressed(false);
            stopTalk();
          }}
          onContextMenu={(e) => e.preventDefault()}
          className={`size-20 rounded-full grid place-items-center select-none touch-none transition-all border-4 ${
            pressed || recording
              ? "bg-ptt-live border-ptt-live/50 scale-110 shadow-[0_0_0_8px] shadow-ptt-live/25"
              : `bg-ptt border-ptt/50 hover:brightness-105 active:scale-95 ${isMember ? "" : "opacity-60"}`
          }`}
        >
          <MicIcon className="size-9 text-white" />
        </button>
        <p className="text-panel-foreground/60 text-[9px] font-bold uppercase tracking-widest">Walkie-talkie</p>
      </div>

      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-bold truncate text-left underline decoration-dotted underline-offset-4"
        >
          {channel ? channel.name : "Elegir canal"}
        </button>
        <p className="text-[9px] text-panel-foreground/60 mt-0.5 leading-tight">
          {recording
            ? "Transmitiendo…"
            : speaking
              ? `Habla ${speaking}`
              : isMember
                ? "Mantén presionado para hablar"
                : "Ingresa la clave del canal"}
        </p>
        {needsUnlock && (
          <button
            type="button"
            onClick={() => void unlockAudio()}
            className="mt-1 text-[9px] font-bold uppercase tracking-wider bg-ptt text-white rounded px-2 py-1"
          >
            Activar audio
          </button>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-40 bg-black/60 grid place-items-end sm:place-items-center" onClick={() => setOpen(false)}>
          <div
            className="bg-card text-foreground w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest">Canales de voz</h2>
              <button onClick={() => setOpen(false)} className="text-xs font-bold uppercase text-muted-foreground">
                Cerrar
              </button>
            </div>

            <ul className="space-y-2">
              {visibleChannels.map((c) => {
                const joined = memberIds.includes(c.id);
                return (
                  <li key={c.id} className="border border-border rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">{c.name}</p>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {c.is_admin_only ? "Solo administración" : "Turno"} · {joined ? "Con acceso" : "Requiere clave"}
                        </p>
                      </div>
                      {joined ? (
                        <button
                          onClick={() => {
                            setChannelId(c.id);
                            setOpen(false);
                          }}
                          className={`text-[10px] font-bold uppercase px-3 py-2 rounded ${
                            channelId === c.id ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                          }`}
                        >
                          {channelId === c.id ? "Activo" : "Usar"}
                        </button>
                      ) : (
                        <button
                          onClick={() => setPendingJoin(c)}
                          className="text-[10px] font-bold uppercase px-3 py-2 rounded bg-accent text-panel"
                        >
                          Entrar
                        </button>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="flex gap-3">
                        <button
                          onClick={() => {
                            setManageId(manageId === c.id ? null : c.id);
                            setManagePass("");
                          }}
                          className="text-[10px] font-bold uppercase text-primary"
                        >
                          Cambiar clave
                        </button>
                        <button
                          onClick={() => void removeChannel(c.id, c.name)}
                          className="text-[10px] font-bold uppercase text-destructive"
                        >
                          Eliminar
                        </button>
                      </div>
                    )}
                    {isAdmin && manageId === c.id && (
                      <form onSubmit={changePasscode} className="flex gap-2">
                        <input
                          type="text"
                          value={managePass}
                          onChange={(e) => setManagePass(e.target.value)}
                          placeholder="Nueva clave (mín. 4)"
                          className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-background"
                        />
                        <button
                          type="submit"
                          disabled={managePass.trim().length < 4}
                          className="bg-primary text-primary-foreground rounded-lg px-3 text-[10px] font-bold uppercase disabled:opacity-40"
                        >
                          Guardar
                        </button>
                      </form>
                    )}
                  </li>

                );
              })}
            </ul>

            {pendingJoin && (
              <form onSubmit={join} className="border border-accent/40 bg-accent/10 rounded-xl p-3 space-y-2">
                <p className="text-xs font-semibold">Clave de {pendingJoin.name}</p>
                <input
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Clave del canal"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                />
                <div className="flex gap-2">
                  <button type="submit" className="flex-1 bg-primary text-primary-foreground rounded-lg py-2 text-xs font-bold uppercase">
                    Entrar
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingJoin(null)}
                    className="px-3 text-xs font-bold uppercase text-muted-foreground"
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}

            {isAdmin && (
              <form onSubmit={createChannel} className="border-t border-border pt-3 space-y-2">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Crear canal de turno</p>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nombre (ej: Turno Noche)"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                />
                <input
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder="Clave (mínimo 4 caracteres)"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={newAdmin} onChange={(e) => setNewAdmin(e.target.checked)} />
                  Solo administración
                </label>
                <button
                  type="submit"
                  disabled={!newName.trim() || newPass.trim().length < 4}
                  className="w-full bg-primary text-primary-foreground rounded-lg py-2 text-xs font-bold uppercase disabled:opacity-40"
                >
                  Crear canal
                </button>
              </form>
            )}

            {status && <p className="text-xs text-muted-foreground">{status}</p>}
            <p className="text-[10px] text-muted-foreground">
              Conectado como {profile?.initials || profile?.full_name || "conductor"}.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" stroke="none" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
