DROP POLICY IF EXISTS shift_assignments_select ON public.shift_assignments;
CREATE POLICY shift_assignments_select ON public.shift_assignments
FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_supervisor(auth.uid()));