CREATE TABLE public.work_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_shifts TO authenticated;
GRANT ALL ON public.work_shifts TO service_role;
ALTER TABLE public.work_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_shifts_select ON public.work_shifts FOR SELECT TO authenticated USING (true);
CREATE POLICY work_shifts_insert_admin ON public.work_shifts FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'administrador'));
CREATE POLICY work_shifts_update_admin ON public.work_shifts FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'administrador')) WITH CHECK (public.has_role(auth.uid(),'administrador'));
CREATE POLICY work_shifts_delete_admin ON public.work_shifts FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'administrador'));
CREATE TRIGGER work_shifts_updated_at BEFORE UPDATE ON public.work_shifts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.work_shifts(id) ON DELETE CASCADE,
  email text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_assignments TO authenticated;
GRANT ALL ON public.shift_assignments TO service_role;
ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY shift_assignments_select ON public.shift_assignments FOR SELECT TO authenticated USING (true);
CREATE POLICY shift_assignments_insert_admin ON public.shift_assignments FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'administrador'));
CREATE POLICY shift_assignments_update_admin ON public.shift_assignments FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'administrador')) WITH CHECK (public.has_role(auth.uid(),'administrador'));
CREATE POLICY shift_assignments_delete_admin ON public.shift_assignments FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'administrador'));
CREATE TRIGGER shift_assignments_updated_at BEFORE UPDATE ON public.shift_assignments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.work_shifts (name, start_time, end_time) VALUES ('Turno 6:00 PM - 2:30 AM', '18:00', '02:30');

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name, initials)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name',''),
    COALESCE(NEW.raw_user_meta_data->>'initials','')
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, COALESCE((NEW.raw_user_meta_data->>'role')::public.app_role,'conductor'))
  ON CONFLICT DO NOTHING;
  UPDATE public.shift_assignments
    SET user_id = NEW.id, updated_at = now()
    WHERE lower(email) = lower(COALESCE(NEW.email,''));
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM public, anon, authenticated;

UPDATE public.shift_assignments a
  SET user_id = u.id
  FROM auth.users u
  WHERE a.user_id IS NULL AND lower(u.email) = lower(a.email);