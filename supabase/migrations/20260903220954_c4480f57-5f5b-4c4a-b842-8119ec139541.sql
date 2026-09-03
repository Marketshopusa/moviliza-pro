-- 1. vehicles: only supervisors/admins can update
DROP POLICY IF EXISTS vehicles_update ON public.vehicles;
CREATE POLICY vehicles_update ON public.vehicles FOR UPDATE TO authenticated
  USING (public.is_supervisor(auth.uid())) WITH CHECK (public.is_supervisor(auth.uid()));

-- 2. profiles: hide phone from broad read
REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (id, full_name, initials, avatar_url, created_at, updated_at) ON public.profiles TO authenticated;
GRANT INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

-- 3. internal trigger functions not callable by users
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_vehicle_from_movement() FROM PUBLIC, anon, authenticated;

-- 4. only administrators can create channels
CREATE OR REPLACE FUNCTION public.create_voice_channel(_name text, _passcode text, _is_admin_only boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT public.has_role(auth.uid(), 'administrador') THEN RAISE EXCEPTION 'Solo administradores pueden crear canales'; END IF;
  IF length(coalesce(_passcode,'')) < 4 THEN RAISE EXCEPTION 'La clave debe tener al menos 4 caracteres'; END IF;
  INSERT INTO public.voice_channels (name, is_admin_only, passcode_hash, created_by)
  VALUES (_name, coalesce(_is_admin_only,false), extensions.crypt(_passcode, extensions.gen_salt('bf')), auth.uid())
  RETURNING id INTO new_id;
  INSERT INTO public.voice_channel_members (channel_id, user_id) VALUES (new_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN new_id;
END; $$;

-- 5. admins can rotate a channel passcode (kicks existing members)
CREATE OR REPLACE FUNCTION public.update_voice_channel_passcode(_channel_id uuid, _passcode text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'administrador') THEN RAISE EXCEPTION 'Solo administradores'; END IF;
  IF length(coalesce(_passcode,'')) < 4 THEN RAISE EXCEPTION 'La clave debe tener al menos 4 caracteres'; END IF;
  UPDATE public.voice_channels SET passcode_hash = extensions.crypt(_passcode, extensions.gen_salt('bf')), updated_at = now()
  WHERE id = _channel_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canal no encontrado'; END IF;
  DELETE FROM public.voice_channel_members WHERE channel_id = _channel_id AND user_id <> auth.uid();
  INSERT INTO public.voice_channel_members (channel_id, user_id) VALUES (_channel_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN true;
END; $$;

-- 6. admins can delete a channel
CREATE OR REPLACE FUNCTION public.delete_voice_channel(_channel_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'administrador') THEN RAISE EXCEPTION 'Solo administradores'; END IF;
  DELETE FROM public.voice_messages WHERE channel_id = _channel_id;
  DELETE FROM public.voice_channel_members WHERE channel_id = _channel_id;
  DELETE FROM public.voice_channels WHERE id = _channel_id;
  RETURN true;
END; $$;

GRANT EXECUTE ON FUNCTION public.update_voice_channel_passcode(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_voice_channel(uuid) TO authenticated;