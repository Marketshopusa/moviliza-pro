import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/perfil")({
  head: () => ({
    meta: [
      { title: "Mi perfil · MovilizaPro" },
      { name: "description", content: "Foto de perfil, nombre e iniciales del conductor." },
      { property: "og:title", content: "Mi perfil · MovilizaPro" },
      { property: "og:description", content: "Identificación del conductor: foto, nombre e iniciales." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PerfilPage,
});

function PerfilPage() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState("");
  const [initials, setInitials] = useState("");
  const [phone, setPhone] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name);
    setInitials(profile.initials);
    setPhone(profile.phone ?? "");
    if (profile.avatar_url) {
      void supabase.storage
        .from("driver-avatars")
        .createSignedUrl(profile.avatar_url, 3600)
        .then(({ data }) => setPreview((p) => p ?? data?.signedUrl ?? null));
    }
  }, [profile]);

  function pick(f: File | null) {
    if (!f) return;
    setFile(f);
    const reader = new FileReader();
    reader.onload = () => setPreview(String(reader.result));
    reader.readAsDataURL(f);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      let avatarPath = profile?.avatar_url ?? null;
      if (file) {
        const path = `${user.id}/avatar.jpg`;
        const { error: upErr } = await supabase.storage
          .from("driver-avatars")
          .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
        if (upErr) throw upErr;
        avatarPath = path;
      }
      const { error } = await supabase
        .from("profiles")
        .update({
          full_name: fullName.trim(),
          initials: initials.trim().toUpperCase(),
          phone: phone.trim() || null,
          avatar_url: avatarPath,
        })
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      setFile(null);
      setMsg("Perfil guardado.");
      if (!profile?.avatar_url) navigate({ to: "/app" });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "No se pudo guardar el perfil");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-bold uppercase tracking-widest">Mi perfil</h1>
      <form onSubmit={save} className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-4">
          <div className="size-20 rounded-xl overflow-hidden bg-panel text-panel-foreground grid place-items-center font-mono font-bold text-xl">
            {preview ? (
              <img src={preview} alt="Foto de perfil del conductor" className="size-full object-cover" />
            ) : (
              (initials || "?").slice(0, 3)
            )}
          </div>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="bg-secondary border border-border rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-widest"
            >
              {preview ? "Cambiar foto" : "Tomar foto de perfil"}
            </button>
            <p className="text-[10px] text-muted-foreground">Se usará para identificarte ante supervisores.</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="user"
            hidden
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase text-muted-foreground">Nombre completo</label>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase text-muted-foreground">Iniciales</label>
          <input
            value={initials}
            onChange={(e) => setInitials(e.target.value.toUpperCase())}
            maxLength={4}
            required
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono uppercase"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold uppercase text-muted-foreground">Teléfono (opcional)</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>

        {err && <p className="text-xs font-semibold text-destructive">{err}</p>}
        {msg && <p className="text-xs font-semibold text-primary">{msg}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-primary disabled:opacity-50 text-primary-foreground font-bold py-3 rounded-xl uppercase tracking-widest text-sm"
        >
          {busy ? "Guardando…" : "Guardar perfil"}
        </button>
      </form>
    </>
  );
}
