GRANT SELECT ON public.profiles TO authenticated;

DROP POLICY IF EXISTS profiles_select_all ON public.profiles;
CREATE POLICY profiles_select_own_or_supervisor ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_supervisor(auth.uid()));

CREATE OR REPLACE FUNCTION public.public_profiles(_ids uuid[])
RETURNS TABLE (id uuid, full_name text, initials text, avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id, p.full_name, p.initials, p.avatar_url
  FROM public.profiles p
  WHERE p.id = ANY(_ids) AND auth.uid() IS NOT NULL
$$;

REVOKE EXECUTE ON FUNCTION public.public_profiles(uuid[]) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_profiles(uuid[]) TO authenticated;