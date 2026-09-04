CREATE TABLE public.vehicle_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate text NOT NULL,
  plate_state text,
  vehicle_model text,
  photo_path text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_positions_plate_idx ON public.vehicle_positions (plate, created_at DESC);
GRANT SELECT, INSERT ON public.vehicle_positions TO authenticated;
GRANT ALL ON public.vehicle_positions TO service_role;
ALTER TABLE public.vehicle_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Usuarios autenticados leen posiciones" ON public.vehicle_positions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Usuarios autenticados registran posiciones" ON public.vehicle_positions FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);