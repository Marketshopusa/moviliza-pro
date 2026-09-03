ALTER TABLE public.movements
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dropoff_location text;

CREATE TABLE IF NOT EXISTS public.driver_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  movement_id uuid REFERENCES public.movements(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.driver_notes TO authenticated;
GRANT ALL ON public.driver_notes TO service_role;

ALTER TABLE public.driver_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "driver_notes_insert_own" ON public.driver_notes
  FOR INSERT TO authenticated WITH CHECK (driver_id = auth.uid());

CREATE POLICY "driver_notes_select_supervisors" ON public.driver_notes
  FOR SELECT TO authenticated USING (public.is_supervisor(auth.uid()));

CREATE POLICY "driver_notes_update_supervisors" ON public.driver_notes
  FOR UPDATE TO authenticated USING (public.is_supervisor(auth.uid()))
  WITH CHECK (public.is_supervisor(auth.uid()));

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_driver_notes_updated_at
  BEFORE UPDATE ON public.driver_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS driver_notes_created_at_idx ON public.driver_notes (created_at DESC);