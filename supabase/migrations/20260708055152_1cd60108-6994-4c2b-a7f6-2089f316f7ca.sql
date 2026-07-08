CREATE POLICY "Admins can view action attachments"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'action-attachments' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can upload action attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'action-attachments' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete action attachments"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'action-attachments' AND public.has_role(auth.uid(), 'admin'));