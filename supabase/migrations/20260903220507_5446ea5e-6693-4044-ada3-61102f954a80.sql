-- Remove the default general channel and its dependencies
DELETE FROM public.voice_messages WHERE channel_id IN (SELECT id FROM public.voice_channels WHERE name = 'Turno General');
DELETE FROM public.voice_channel_members WHERE channel_id IN (SELECT id FROM public.voice_channels WHERE name = 'Turno General');
DELETE FROM public.voice_channels WHERE name = 'Turno General';

-- Hide passcode_hash from clients via column-level privileges
REVOKE SELECT ON public.voice_channels FROM authenticated;
REVOKE SELECT ON public.voice_channels FROM anon;
GRANT SELECT (id, name, is_admin_only, created_by, created_at, updated_at) ON public.voice_channels TO authenticated;
GRANT ALL ON public.voice_channels TO service_role;

-- Non-admin channels visible to everyone signed in; admin-only channels to supervisors/admins
DROP POLICY IF EXISTS voice_channels_select ON public.voice_channels;
CREATE POLICY voice_channels_select ON public.voice_channels
FOR SELECT TO authenticated
USING ((NOT is_admin_only) OR public.is_supervisor(auth.uid()));