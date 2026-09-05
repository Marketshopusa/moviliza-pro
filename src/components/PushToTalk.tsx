import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useLiveVoice } from "@/lib/live-voice";

type Channel = { id: string; name: string; is_admin_only: boolean };

const LAST_CHANNEL_KEY = "movpro.voice.channel";
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";


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
  const [newName, setNewName] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [managePass, setManagePass] = useState("");

  const isHoldingRef = useRef(false);

  const channel = channels.find((c) => c.id === channelId) ?? null;
  const isMember = channelId ? memberIds.includes(channelId) : false;

  // Voz centralizada en tiempo real Half-Duplex (100% en memoria / WebSockets, 0 BD)
  const live = useLiveVoice({
    channelId: isMember ? channelId : null,
    enabled: isMember,
    userId: user?.id ?? null,
    displayName: profile?.initials || profile?.full_name || "Conductor",
  });

  const resumeLive = live.resumeAudio;
  useEffect(() => {
    const handler = () => resumeLive();
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [resumeLive]);

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
    isHoldingRef.current = true;
    live.resumeAudio();
    const ok = await live.startTransmit();
    // Si el usuario ya soltó el botón antes de que el micrófono estuviera listo
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
    setStatus("Transmitido");
    try {
      await live.stopTransmit();
      setTimeout(() => setStatus(null), 1200);
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
            live.resumeAudio();
            setPressed(true);
            void startTalk();
          }}
          onPointerUp={() => {
            setPressed(false);
            void stopTalk();
          }}
          onPointerLeave={() => {
            if (pressed) {
              setPressed(false);
              void stopTalk();
            }
          }}
          onPointerCancel={() => {
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
        <p className="text-sm font-bold truncate leading-tight">{channel ? channel.name : "Sin canal"}</p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[10px] font-bold uppercase tracking-widest underline decoration-dotted underline-offset-4"
        >
          Canales
        </button>
        <p className="text-[9px] text-panel-foreground/60 mt-0.5 leading-tight">
          {recording
            ? "Transmitiendo…"
            : live.speaker
              ? `Habla ${live.speaker}`
              : !isMember
                ? "Ingresa la clave del canal"
                : live.peerCount > 0
                  ? `En vivo · ${live.peerCount} en línea`
                  : "Mantén presionado para hablar"}
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
