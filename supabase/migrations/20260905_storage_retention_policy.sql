-- Migración: Política de Retención de Fotografías de 30 Días
-- MovilizaPro: Purga de imágenes antiguas del bucket vehicle-photos para evitar saturación de almacenamiento.

-- 1. Función para limpiar referencias de fotos en movimientos de más de 30 días
CREATE OR REPLACE FUNCTION public.cleanup_old_movement_photos(days_threshold integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  purged_count integer := 0;
BEGIN
  -- Identifica y actualiza movimientos de más de 30 días liberando las referencias de fotos
  WITH updated AS (
    UPDATE public.movements
    SET photos = '{}',
        photo_path = NULL
    WHERE occurred_at < (NOW() - (days_threshold || ' days')::interval)
      AND (photos IS NOT NULL AND array_length(photos, 1) > 0 OR photo_path IS NOT NULL)
    RETURNING id
  )
  SELECT count(*) INTO purged_count FROM updated;

  RETURN purged_count;
END;
$$;

-- 2. Si pg_cron está habilitado en tu proyecto de Supabase, puedes descomentar la siguiente línea
-- para ejecutar la limpieza automática todos los domingos a las 3:00 AM UTC:
-- SELECT cron.schedule('purge-30d-photos', '0 3 * * 0', $$SELECT public.cleanup_old_movement_photos(30);$$);
