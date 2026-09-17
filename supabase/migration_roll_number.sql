-- ==============================================================================
-- Migration: Student Roll Numbers (Phase 3 Prerequisite)
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Add roll_number column to profiles if not present
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS roll_number TEXT;

-- 2. Case-insensitive unique index on roll_number
-- (Ignores NULLs so faculty/hod and unmigrated test accounts do not conflict)
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_profiles_roll_number 
ON public.profiles (UPPER(TRIM(roll_number))) 
WHERE roll_number IS NOT NULL AND roll_number <> '';

-- 3. Update handle_new_user trigger to save roll_number from user metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, email, role, roll_number)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Anonymous User'),
        COALESCE(NEW.email, ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'student'),
        NULLIF(UPPER(TRIM(NEW.raw_user_meta_data->>'roll_number')), '')
    )
    ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        roll_number = COALESCE(EXCLUDED.roll_number, public.profiles.roll_number);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Safe RPC function to check roll number existence for unauthenticated sign-up
CREATE OR REPLACE FUNCTION public.check_roll_number_exists(p_roll_number TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE UPPER(TRIM(roll_number)) = UPPER(TRIM(p_roll_number))
    );
$$;

GRANT EXECUTE ON FUNCTION public.check_roll_number_exists(TEXT) TO anon, authenticated;

