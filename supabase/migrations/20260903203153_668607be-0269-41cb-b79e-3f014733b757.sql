CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.voice_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_admin_only boolean NOT NULL DEFAULT false,
  passcode_hash text NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.voice_channels TO authenticated;
GRANT ALL ON public.voice_channels TO service_role;
ALTER TABLE public.voice_channels ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.voice_channel_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.voice_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, user_id)
);
GRANT SELECT, DELETE ON public.voice_channel_members TO authenticated;
GRANT ALL ON public.voice_channel_members TO service_role;
ALTER TABLE public.voice_channel_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.voice_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.voice_channels(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  audio_path text NOT NULL,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.voice_messages TO authenticated;
GRANT ALL ON public.voice_messages TO service_role;
ALTER TABLE public.voice_messages ENABLE ROW LEVEL SECURITY;

CREATE INDEX voice_messages_channel_created_idx ON public.voice_messages (channel_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.is_channel_member(_channel_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.voice_channel_members m WHERE m.channel_id = _channel_id AND m.user_id = _user_id)
$$;
REVOKE EXECUTE ON FUNCTION public.is_channel_member(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE POLICY voice_channels_select ON public.voice_channels FOR SELECT TO authenticated USING (true);

CREATE POLICY voice_members_select ON public.voice_channel_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_supervisor(auth.uid()));
CREATE POLICY voice_members_delete_own ON public.voice_channel_members FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY voice_messages_select ON public.voice_messages FOR SELECT TO authenticated
  USING (public.is_channel_member(channel_id, auth.uid()));
CREATE POLICY voice_messages_insert ON public.voice_messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND public.is_channel_member(channel_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.join_voice_channel(_channel_id uuid, _passcode text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE ch public.voice_channels;
BEGIN
  SELECT * INTO ch FROM public.voice_channels WHERE id = _channel_id;
  IF ch.id IS NULL THEN RAISE EXCEPTION 'Canal no encontrado'; END IF;
  IF ch.is_admin_only AND NOT public.is_supervisor(auth.uid()) THEN
    RAISE EXCEPTION 'Canal exclusivo de administración';
  END IF;
  IF ch.passcode_hash <> extensions.crypt(_passcode, ch.passcode_hash) THEN
    RETURN false;
  END IF;
  INSERT INTO public.voice_channel_members (channel_id, user_id)
  VALUES (_channel_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN true;
END; $$;
REVOKE EXECUTE ON FUNCTION public.join_voice_channel(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_voice_channel(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_voice_channel(_name text, _passcode text, _is_admin_only boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT public.is_supervisor(auth.uid()) THEN RAISE EXCEPTION 'Solo supervisores o administradores'; END IF;
  IF length(coalesce(_passcode, '')) < 4 THEN RAISE EXCEPTION 'La clave debe tener al menos 4 caracteres'; END IF;
  INSERT INTO public.voice_channels (name, is_admin_only, passcode_hash, created_by)
  VALUES (_name, coalesce(_is_admin_only, false), extensions.crypt(_passcode, extensions.gen_salt('bf')), auth.uid())
  RETURNING id INTO new_id;
  INSERT INTO public.voice_channel_members (channel_id, user_id) VALUES (new_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN new_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.create_voice_channel(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_voice_channel(text, text, boolean) TO authenticated;

CREATE TRIGGER voice_channels_updated_at BEFORE UPDATE ON public.voice_channels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.voice_channels (name, is_admin_only, passcode_hash)
VALUES
  ('Administración', true, extensions.crypt('admin2024', extensions.gen_salt('bf'))),
  ('Turno General', false, extensions.crypt('turno2024', extensions.gen_salt('bf')));

ALTER TABLE public.voice_messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_messages;