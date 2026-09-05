CREATE TABLE public.voice_channel_secrets (
  channel_id uuid PRIMARY KEY REFERENCES public.voice_channels(id) ON DELETE CASCADE,
  passcode_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.voice_channel_secrets TO service_role;
ALTER TABLE public.voice_channel_secrets ENABLE ROW LEVEL SECURITY;

INSERT INTO public.voice_channel_secrets (channel_id, passcode_hash)
SELECT id, passcode_hash FROM public.voice_channels;

CREATE OR REPLACE FUNCTION public.join_voice_channel(_channel_id uuid, _passcode text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE
  channel_admin_only boolean;
  stored_hash text;
BEGIN
  SELECT c.is_admin_only, s.passcode_hash
  INTO channel_admin_only, stored_hash
  FROM public.voice_channels c
  JOIN public.voice_channel_secrets s ON s.channel_id = c.id
  WHERE c.id = _channel_id;
  IF stored_hash IS NULL THEN RAISE EXCEPTION 'Canal no encontrado'; END IF;
  IF channel_admin_only AND NOT public.is_supervisor(auth.uid()) THEN
    RAISE EXCEPTION 'Canal exclusivo de administración';
  END IF;
  IF stored_hash <> extensions.crypt(_passcode, stored_hash) THEN RETURN false; END IF;
  INSERT INTO public.voice_channel_members (channel_id, user_id)
  VALUES (_channel_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.create_voice_channel(_name text, _passcode text, _is_admin_only boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'administrador') THEN RAISE EXCEPTION 'Solo administradores pueden crear canales'; END IF;
  IF length(coalesce(_passcode,'')) < 4 THEN RAISE EXCEPTION 'La clave debe tener al menos 4 caracteres'; END IF;
  INSERT INTO public.voice_channels (name, is_admin_only, created_by)
  VALUES (_name, coalesce(_is_admin_only,false), auth.uid()) RETURNING id INTO new_id;
  INSERT INTO public.voice_channel_secrets (channel_id, passcode_hash)
  VALUES (new_id, extensions.crypt(_passcode, extensions.gen_salt('bf')));
  INSERT INTO public.voice_channel_members (channel_id, user_id)
  VALUES (new_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN new_id;
END; $$;

CREATE OR REPLACE FUNCTION public.update_voice_channel_passcode(_channel_id uuid, _passcode text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'administrador') THEN RAISE EXCEPTION 'Solo administradores'; END IF;
  IF length(coalesce(_passcode,'')) < 4 THEN RAISE EXCEPTION 'La clave debe tener al menos 4 caracteres'; END IF;
  UPDATE public.voice_channel_secrets
  SET passcode_hash = extensions.crypt(_passcode, extensions.gen_salt('bf')), updated_at = now()
  WHERE channel_id = _channel_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canal no encontrado'; END IF;
  UPDATE public.voice_channels SET updated_at = now() WHERE id = _channel_id;
  DELETE FROM public.voice_channel_members WHERE channel_id = _channel_id AND user_id <> auth.uid();
  INSERT INTO public.voice_channel_members (channel_id, user_id)
  VALUES (_channel_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN true;
END; $$;

ALTER TABLE public.voice_channels DROP COLUMN passcode_hash;
REVOKE ALL ON public.voice_channel_secrets FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.join_voice_channel(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_voice_channel(text, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_voice_channel_passcode(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_voice_channel(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_voice_channel(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_voice_channel_passcode(uuid, text) TO authenticated;