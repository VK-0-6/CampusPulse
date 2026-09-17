-- ==============================================================================
-- MIGRATION: Allow Anon Role to Read Departments Catalog
-- Description: Grants SELECT on public.departments to anon so unauthenticated
--              users on the registration page (register.html) can view and select
--              their department from the canonical 8 departments.
-- Security:    Read-only (SELECT) permission only. No write/insert/update/delete.
-- ==============================================================================

-- 1. Grant USAGE on schema public to anon
GRANT USAGE ON SCHEMA public TO anon;

-- 2. Grant SELECT on public.departments to anon
GRANT SELECT ON TABLE public.departments TO anon;

-- 3. Update RLS policy so both authenticated and anon roles can SELECT departments
DROP POLICY IF EXISTS "departments_select_policy" ON public.departments;
CREATE POLICY "departments_select_policy" ON public.departments 
    FOR SELECT TO authenticated, anon 
    USING (true);
