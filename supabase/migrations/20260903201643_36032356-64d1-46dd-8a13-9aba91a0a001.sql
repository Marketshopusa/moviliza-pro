CREATE POLICY "avatars_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'driver-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'driver-avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'driver-avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "avatars_select_own_or_supervisor" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'driver-avatars' AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_supervisor(auth.uid())));