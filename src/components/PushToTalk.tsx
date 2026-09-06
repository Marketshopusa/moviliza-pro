import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useLiveVoice } from "@/lib/live-voice";

type Channel = { id: string; name: string; is_admin_only: boolean };

const LAST_CHANNEL_KEY = "movpro.voice.channel";

// Canal por defecto garantizado para que nunca falle la comunicación entre conductores y base
const DEFAULT_CHANNEL: Channel = {
  id: "general",
  name: "Canal 1 · Operaciones",
  is_admin_only: false,
};

export function PushToTalk() {
  const { user, isSupervisor, isAdmin, profile } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([DEFAULT_CHANNEL]);
  const [memberIds, setMemberIds] = useState<string[]>(["general"]);
  const [channelId, setChannelId] = useState<string | null>("general");
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [pendingJoin, setPendingJoin] = useState<Channel | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [managePass, setManagePass] = useState("");

  const isHoldingRef = useRef(false);

  const channel = channels.find((c) => c.id === channelId) ?? DEFAULT_CHANNEL;
  const isMember = channelId ? memberIds.includes(channelId) : true;

  // Voz centralizada en tiempo real Half-Duplex (100% en memoria / WebSockets, 0 BD)
  const live = useLiveVoice({
    channelId: channelId || "general",
    enabled: true,
    userId: user?.id ?? "driver",
    displayName: profile?.initials || profile?.full_name || (isSupervisor ? "Supervisor" : "Conductor"),
  });

  const resumeLive = live.resumeAudio;
  useEffect(() => {
    const handler = () => resumeLive();
    window.addEventListener("pointerdown", handler);
    window.addEventListener("touchstart", handler, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("touchstart", handler);
    };
  }, [resumeLive]);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [{ data: ch }, { data: mem }] = await Promise.all([
        supabase.from("voice_channels").select("id, name, is_admin_only").order("created_at"),
        supabase.from("voice_channel_members").select("channel_id").eq("user_id", user.id),
      ]);
      const list = (ch as Channel[]) ?? [];
      const fullList = list.length > 0 ? list : [DEFAULT_CHANNEL];
      setChannels(fullList);

      // Todos los usuarios autenticados tienen acceso libre a los canales operativos y al canal general
      const openChannelIds = fullList.filter((c) => !c.is_admin_only).map((c) => c.id);
      const combined = Array.from(new Set(["general", ...openChannelIds, ...(mem ?? []).map((m) => m.channel_id as string)]));
      setMemberIds(combined);

      setChannelId((prev) => {
        if (prev && fullList.some((c) => c.id === prev)) return prev;
        const stored = typeof window !== "undefined" ? window.localStorage.getItem(LAST_CHANNEL_KEY) : null;
        if (stored && fullList.some((c) => c.id === stored)) return stored;
        return fullList[0]?.id ?? "general";
      });
    } catch {
      setChannels([DEFAULT_CHANNEL]);
      setMemberIds(["general"]);
      setChannelId("general");
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (channelId && typeof window !== "undefined") window.localStorage.setItem(LAST_CHANNEL_KEY, channelId);
  }, [channelId]);

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
    if (channelId === id) setChannelId("general");
    setStatus("Canal eliminado");
    void load();
  }

  async function startTalk() {
    if (recording) return;
    isHoldingRef.current = true;
    live.resumeAudio();

    const ok = await live.startTransmit();
    if (!isHoldingRef.current) {
      void live.stopTransmit();
      setRecording(false);
      return;
    }
    if (ok) {
      setRecording(true);
      setStatus(null);
    } else {
      setRecording(false);
    }
  }

  async function stopTalk() {
    isHoldingRef.current = false;
    if (!recording) {
      void live.stopTransmit();
      return;
    }
    setRecording(false);
    setStatus("Enviado");
    try {
      await live.stopTransmit();
      setTimeout(() => setStatus(null), 1000);
    } catch {
      setStatus(null);
    }
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
            try {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            } catch {
              // Ignorar
            }
            live.resumeAudio();
            setPressed(true);
            void startTalk();
          }}
          onPointerUp={(e) => {
            try {
              (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
              // Ignorar
            }
            setPressed(false);
            void stopTalk();
          }}
          onPointerCancel={(e) => {
            try {
              (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
              // Ignorar
            }
            setPressed(false);
            void stopTalk();
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

      <div className="min-w-0 self-center">
        <p className="text-sm font-bold truncate leading-tight">{channel ? channel.name : "Canal 1 · Operaciones"}</p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[10px] font-bold uppercase tracking-widest underline decoration-dotted underline-offset-4"
        >
          Canales
        </button>
        <p className="text-[9px] text-panel-foreground/60 mt-0.5 leading-tight">
          {live.error ? (
            <span className="text-red-400 font-semibold">{live.error}</span>
          ) : status ? (
            <span className="text-emerald-400 font-semibold">{status}</span>
          ) : recording ? (
            <span className="text-emerald-400 font-bold animate-pulse">● Transmitiendo en vivo…</span>
          ) : live.speaker ? (
            <span className="text-amber-300 font-bold animate-pulse">🔊 Habla {live.speaker}</span>
          ) : !isMember ? (
            "Ingresa la clave del canal"
          ) : live.connected ? (
            `Radio en línea · ${live.peerCount > 0 ? `${live.peerCount + 1} conectados` : "Listo para hablar"}`
          ) : (
            "Conectando radio…"
          )}
        </p>
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
                      <div className="flex items-center gap-2 pt-1 border-t border-border/60 text-[10px]">
                        <button
                          type="button"
                          onClick={() => {
                            setManageId(manageId === c.id ? null : c.id);
                            setManagePass("");
                          }}
                          className="text-muted-foreground hover:underline"
                        >
                          {manageId === c.id ? "Cancelar" : "Cambiar clave"}
                        </button>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => void removeChannel(c.id, c.name)}
                          className="text-destructive hover:underline"
                        >
                          Eliminar canal
                        </button>
                      </div>
                    )}

                    {manageId === c.id && (
                      <form onSubmit={changePasscode} className="flex gap-2 pt-2">
                        <input
                          type="password"
                          inputMode="numeric"
                          placeholder="Nueva clave (4+)"
                          value={managePass}
                          onChange={(e) => setManagePass(e.target.value)}
                          className="flex-1 bg-secondary border border-border rounded px-2 py-1 text-xs"
                        />
                        <button type="submit" className="bg-primary text-primary-foreground text-[10px] font-bold uppercase px-2.5 py-1 rounded">
                          Guardar
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>

            {isAdmin && (
              <form onSubmit={createChannel} className="border-t border-border pt-3 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Crear nuevo canal</p>
                <input
                  type="text"
                  placeholder="Nombre (ej. Noche A)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-xs"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  placeholder="Clave numérica (mínimo 4 dígitos)"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-xs"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={newAdmin} onChange={(e) => setNewAdmin(e.target.checked)} />
                  <span>Exclusivo para administradores y supervisores</span>
                </label>
                <button type="submit" className="w-full bg-primary text-primary-foreground font-bold py-2 rounded-lg uppercase text-xs">
                  Crear canal
                </button>
              </form>
            )}

            {status && <p className="text-xs text-center text-muted-foreground">{status}</p>}
          </div>
        </div>
      )}

      {pendingJoin && (
        <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4" onClick={() => setPendingJoin(null)}>
          <form
            onSubmit={join}
            onClick={(e) => e.stopPropagation()}
            className="bg-card text-foreground rounded-2xl p-4 w-full max-w-xs space-y-3"
          >
            <h3 className="text-sm font-bold uppercase tracking-widest">Clave de {pendingJoin.name}</h3>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              placeholder="Ingresa la clave"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-center text-sm font-mono tracking-widest"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPendingJoin(null)}
                className="flex-1 bg-secondary text-foreground py-2 rounded-lg text-xs font-bold uppercase"
              >
                Cancelar
              </button>
              <button type="submit" className="flex-1 bg-primary text-primary-foreground py-2 rounded-lg text-xs font-bold uppercase">
                Entrar
              </button>
            </div>
            {status && <p className="text-[10px] text-center text-destructive">{status}</p>}
          </form>
        </div>
      )}
    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}
