CREATE POLICY "voice_clips_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'voice-clips' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "voice_clips_select_auth" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voice-clips');