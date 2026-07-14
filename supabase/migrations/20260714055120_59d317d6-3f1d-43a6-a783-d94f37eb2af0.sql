
-- Scope action-attachments to per-user folder. First path segment must equal auth.uid().
DROP POLICY IF EXISTS "Admins can view action attachments" ON storage.objects;
DROP POLICY IF EXISTS "Admins can upload action attachments" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete action attachments" ON storage.objects;

CREATE POLICY "Users read own action attachments"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'action-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users upload own action attachments"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'action-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users update own action attachments"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'action-attachments' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'action-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users delete own action attachments"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'action-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
