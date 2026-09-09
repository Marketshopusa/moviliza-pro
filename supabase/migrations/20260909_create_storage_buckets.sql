-- Migración: Creación de buckets de almacenamiento para fotografías de vehículos y avatares
-- Garantiza que vehicle-photos y driver-avatars existan en storage.buckets con acceso RLS adecuado.

INSERT INTO storage.buckets (id, name, public)
VALUES 
  ('vehicle-photos', 'vehicle-photos', true),
  ('driver-avatars', 'driver-avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Políticas RLS para vehicle-photos
DO $$
BEGIN
  -- Política para permitir subir fotos a usuarios autenticados
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Permitir subida a usuarios autenticados vehicle-photos'
  ) THEN
    CREATE POLICY "Permitir subida a usuarios autenticados vehicle-photos"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'vehicle-photos');
  END IF;

  -- Política para permitir lectura de fotos
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Permitir lectura de vehicle-photos'
  ) THEN
    CREATE POLICY "Permitir lectura de vehicle-photos"
    ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'vehicle-photos');
  END IF;

  -- Política pública para lectura de avatares
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Permitir lectura publica de driver-avatars'
  ) THEN
    CREATE POLICY "Permitir lectura publica de driver-avatars"
    ON storage.objects FOR SELECT TO public
    USING (bucket_id = 'driver-avatars');
  END IF;

  -- Política para subir avatares
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Permitir subida de driver-avatars'
  ) THEN
    CREATE POLICY "Permitir subida de driver-avatars"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'driver-avatars');
  END IF;
END $$;
