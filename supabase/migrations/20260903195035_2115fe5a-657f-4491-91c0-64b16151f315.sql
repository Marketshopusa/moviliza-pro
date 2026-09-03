CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_state text NOT NULL DEFAULT 'FL',
  plate text NOT NULL,
  vehicle_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plate_state, plate)
);

GRANT SELECT, INSERT, UPDATE ON public.vehicles TO authenticated;
GRANT ALL ON public.vehicles TO service_role;

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY vehicles_select ON public.vehicles FOR SELECT TO authenticated USING (true);
CREATE POLICY vehicles_insert ON public.vehicles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY vehicles_update ON public.vehicles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER update_vehicles_updated_at BEFORE UPDATE ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.upsert_vehicle_from_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.plate IS NULL OR btrim(NEW.plate) = '' THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.vehicles (plate_state, plate, vehicle_model)
  VALUES (upper(NEW.plate_state), upper(NEW.plate), NULLIF(btrim(coalesce(NEW.vehicle_model, '')), ''))
  ON CONFLICT (plate_state, plate) DO UPDATE
    SET vehicle_model = COALESCE(NULLIF(btrim(coalesce(EXCLUDED.vehicle_model, '')), ''), public.vehicles.vehicle_model),
        updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER movements_upsert_vehicle
AFTER INSERT ON public.movements
FOR EACH ROW EXECUTE FUNCTION public.upsert_vehicle_from_movement();

INSERT INTO public.vehicles (plate_state, plate, vehicle_model)
SELECT upper(plate_state), upper(plate), NULLIF(btrim(coalesce(max(vehicle_model), '')), '')
FROM public.movements
GROUP BY upper(plate_state), upper(plate)
ON CONFLICT DO NOTHING;