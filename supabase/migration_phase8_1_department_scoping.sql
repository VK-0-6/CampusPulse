-- ==============================================================================
-- Phase 8.1 Migration: Department Scoping & Institutional Ownership
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- ==============================================================================
-- PRE-MIGRATION VERIFICATION QUERIES (RUN IN SUPABASE SQL EDITOR BEFORE RUNNING)
-- Inspect all existing rows across tables to check their current department values:
-- ==============================================================================
-- 1. Profiles:
--    SELECT id, email, full_name, role, roll_number, department_id FROM public.profiles ORDER BY role, email;
-- 2. Subjects:
--    SELECT id, code, name, department_id FROM public.subjects ORDER BY code;
-- 3. Classes:
--    SELECT c.id, c.class_code, c.is_active, c.department_id, s.code AS subject_code, p.email AS faculty_email
--    FROM public.classes c
--    LEFT JOIN public.subjects s ON s.id = c.subject_id
--    LEFT JOIN public.profiles p ON p.id = c.faculty_id
--    ORDER BY c.class_code;
-- 4. Department Issues:
--    SELECT id, category, location, severity, status, department_id, substring(description from 1 for 60) AS snippet
--    FROM public.department_issues ORDER BY created_at DESC;
-- 5. Issue Groups:
--    SELECT id, title, category, location, status, issue_count, department_id FROM public.issue_groups ORDER BY created_at DESC;
-- ==============================================================================

BEGIN;

-- Temporarily suspend ONLY the Phase 8 immutable trigger on issue_groups
-- so the migration transaction can remap legacy references and backfill department_id.
-- This trigger will be recreated with identical Phase 8 logic in Section 5.5 before COMMIT.
DROP TRIGGER IF EXISTS trg_protect_issue_group_fields ON public.issue_groups;

-- ------------------------------------------------------------------------------
-- 1. Canonical Department Catalog (Exactly 8 Departments)
-- ------------------------------------------------------------------------------
INSERT INTO public.departments (name) VALUES 
    ('Civil'),
    ('Chemical'),
    ('CSE'),
    ('CSIT'),
    ('ECE'),
    ('EEE'),
    ('Mechanical'),
    ('Data Engineering')
ON CONFLICT (name) DO NOTHING;

-- Map any legacy department names to canonical equivalents safely
DO $$
DECLARE
    v_cs_id UUID;
    v_cse_id UUID;
    v_it_id UUID;
    v_csit_id UUID;
    v_ec_id UUID;
    v_ece_id UUID;
BEGIN
    SELECT id INTO v_cs_id FROM public.departments WHERE name = 'Computer Science';
    SELECT id INTO v_cse_id FROM public.departments WHERE name = 'CSE';
    IF v_cs_id IS NOT NULL AND v_cse_id IS NOT NULL THEN
        UPDATE public.subjects SET department_id = v_cse_id WHERE department_id = v_cs_id;
        UPDATE public.department_issues SET department_id = v_cse_id WHERE department_id = v_cs_id;
        UPDATE public.issue_groups SET department_id = v_cse_id WHERE department_id = v_cs_id;
        DELETE FROM public.departments WHERE id = v_cs_id;
    ELSIF v_cs_id IS NOT NULL AND v_cse_id IS NULL THEN
        UPDATE public.departments SET name = 'CSE' WHERE id = v_cs_id;
    END IF;

    SELECT id INTO v_it_id FROM public.departments WHERE name = 'Information Technology';
    SELECT id INTO v_csit_id FROM public.departments WHERE name = 'CSIT';
    IF v_it_id IS NOT NULL AND v_csit_id IS NOT NULL THEN
        UPDATE public.subjects SET department_id = v_csit_id WHERE department_id = v_it_id;
        UPDATE public.department_issues SET department_id = v_csit_id WHERE department_id = v_it_id;
        UPDATE public.issue_groups SET department_id = v_csit_id WHERE department_id = v_it_id;
        DELETE FROM public.departments WHERE id = v_it_id;
    ELSIF v_it_id IS NOT NULL AND v_csit_id IS NULL THEN
        UPDATE public.departments SET name = 'CSIT' WHERE id = v_it_id;
    END IF;

    SELECT id INTO v_ec_id FROM public.departments WHERE name = 'Electronics & Communication';
    SELECT id INTO v_ece_id FROM public.departments WHERE name = 'ECE';
    IF v_ec_id IS NOT NULL AND v_ece_id IS NOT NULL THEN
        UPDATE public.subjects SET department_id = v_ece_id WHERE department_id = v_ec_id;
        UPDATE public.department_issues SET department_id = v_ece_id WHERE department_id = v_ec_id;
        UPDATE public.issue_groups SET department_id = v_ece_id WHERE department_id = v_ec_id;
        DELETE FROM public.departments WHERE id = v_ec_id;
    ELSIF v_ec_id IS NOT NULL AND v_ece_id IS NULL THEN
        UPDATE public.departments SET name = 'ECE' WHERE id = v_ec_id;
    END IF;
END $$;

-- 1.2 Department Catalog Safeguard: Verify exactly 8 canonical departments exist
DO $$
DECLARE
    v_invalid_depts TEXT;
    v_missing_depts TEXT;
    v_dept_count INT;
BEGIN
    -- Check for unexpected / non-canonical departments
    SELECT string_agg(name, ', ') INTO v_invalid_depts
    FROM public.departments
    WHERE name NOT IN (
        'Civil', 'Chemical', 'CSE', 'CSIT', 'ECE', 'EEE', 'Mechanical', 'Data Engineering'
    );

    IF v_invalid_depts IS NOT NULL THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Unexpected departments detected in public.departments catalog: [%]. Only the 8 canonical departments are permitted.', v_invalid_depts;
    END IF;

    -- Check for missing canonical departments
    SELECT string_agg(canonical_name, ', ') INTO v_missing_depts
    FROM (
        SELECT unnest(ARRAY['Civil', 'Chemical', 'CSE', 'CSIT', 'ECE', 'EEE', 'Mechanical', 'Data Engineering']) AS canonical_name
    ) c
    WHERE NOT EXISTS (
        SELECT 1 FROM public.departments d WHERE d.name = c.canonical_name
    );

    IF v_missing_depts IS NOT NULL THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Missing canonical departments in public.departments catalog: [%].', v_missing_depts;
    END IF;

    SELECT COUNT(*) INTO v_dept_count FROM public.departments;
    IF v_dept_count <> 8 THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Expected exactly 8 departments, found %.', v_dept_count;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Schema Extensions & Indexes
-- ------------------------------------------------------------------------------

-- 2.1 Profiles: Add department_id
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_profiles_department ON public.profiles(department_id);

-- 2.2 Enforce Database Rule: Maximum 1 HOD per department
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_hod_per_department 
ON public.profiles (department_id) 
WHERE role = 'hod';

-- 2.3 Classes: Add department_id (Institutional boundary: strictly ON DELETE RESTRICT)
ALTER TABLE public.classes 
ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT;

-- Ensure foreign key constraint is strictly ON DELETE RESTRICT
DO $$
DECLARE
    v_fk_name TEXT;
BEGIN
    SELECT tc.constraint_name INTO v_fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
     AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
      AND tc.table_name = 'classes' 
      AND kcu.column_name = 'department_id'
    LIMIT 1;

    IF v_fk_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public.classes DROP CONSTRAINT IF EXISTS ' || quote_ident(v_fk_name);
    END IF;

    ALTER TABLE public.classes 
    ADD CONSTRAINT fk_classes_department FOREIGN KEY (department_id) 
    REFERENCES public.departments(id) ON DELETE RESTRICT;
END $$;

CREATE INDEX IF NOT EXISTS idx_classes_department ON public.classes(department_id);

-- ------------------------------------------------------------------------------
-- 3. Targeted Data Migration for Existing Known Test Records
-- Strictly targets verified test/demo entities (subjects, classes, Wi-Fi
-- issue groups & reports, and test profiles). Any unknown NULL record causes
-- an immediate abort with detailed error output.
-- ------------------------------------------------------------------------------
DO $$
DECLARE
    v_csit_id UUID;
    v_unmapped_profiles INT;
    v_unmapped_issues INT;
    v_unmapped_groups INT;
    v_unmapped_classes INT;
    v_unmapped_subjects INT;
    v_unmapped_profile_ids TEXT;
    v_unmapped_issue_ids TEXT;
    v_unmapped_group_ids TEXT;
    v_unmapped_class_ids TEXT;
    v_unmapped_subject_ids TEXT;
BEGIN
    SELECT id INTO v_csit_id FROM public.departments WHERE name = 'CSIT';
    IF v_csit_id IS NULL THEN
        RAISE EXCEPTION 'CSIT department not found in public.departments catalog.';
    END IF;

    -- 3.1 Explicitly map verified test subjects to CSIT
    UPDATE public.subjects
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND id IN (
          'cd335bed-e859-4c6c-af88-db1c85b69354'::UUID,
          'efca16ed-ffb2-4a11-afe0-0d1e033fd27b'::UUID,
          'd77f60b6-d113-411c-957d-7ec2bdd389a2'::UUID,
          '892c5ce8-6b03-4bd5-9cb4-e6b149b1381f'::UUID,
          '0d29404a-23a3-4e6a-8cda-9c38917b52bd'::UUID,
          '09d40a71-8b8b-4507-bbf2-afc79859573d'::UUID,
          '21c56cc3-4e5e-4dcb-a657-a8f962020f69'::UUID,
          'c6de876a-f70f-48bd-94b5-7d19c5189318'::UUID,
          '408d1b5e-ba54-4789-aaf1-4f69c41e20e8'::UUID,
          '2318b944-8246-4bcf-b179-335a6ded9eb9'::UUID,
          'cc15352d-2743-4b79-a881-d850a20d33e0'::UUID
      );

    -- 3.2 Explicitly map verified test classes (823VCW, B2X53C, L786WF) and classes of mapped CS subjects to CSIT
    UPDATE public.classes
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND (
          UPPER(class_code) IN ('823VCW', 'B2X53C', 'L786WF')
          OR subject_id IN (
              SELECT id FROM public.subjects WHERE department_id = v_csit_id
          )
      );

    -- 3.3 Explicitly map verified test Wi-Fi issue group ('3a20f250-ab06-437f-9574-bfe3ec6e9b81' / 'Lab Wi-Fi Connectivity Issue') to CSIT
    UPDATE public.issue_groups
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND (
          id = '3a20f250-ab06-437f-9574-bfe3ec6e9b81'::UUID
          OR title = 'Lab Wi-Fi Connectivity Issue'
      );

    -- 3.4 Explicitly map verified test Wi-Fi department issue reports to CSIT
    UPDATE public.department_issues
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND id IN (
          'b3040253-0cc3-49ec-85e3-1b06bbab9494'::UUID,
          '2eeba2fc-770f-412b-9ca4-f25db3829658'::UUID,
          '6f5f2c63-6b82-49e7-9575-f15aa820438c'::UUID,
          '79b76cb1-0e9d-42b0-b99b-e1ae6651965b'::UUID
      );

    -- 3.5 Explicitly map verified test profiles to CSIT
    UPDATE public.profiles
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND id IN (
          'e0c9b25d-42ee-4110-87b3-d1d76c93a619'::UUID,
          'ee1316ea-d02e-4c4c-896e-eb8ac465ef38'::UUID,
          '522583e6-156b-4ec4-b1d9-ff02a573bc14'::UUID,
          '32de79fa-1d6e-4192-8328-5e4d0688fe48'::UUID
      );

    -- 3.6 Safeguard Verification: If ANY unexpected/unmapped record remains with NULL department_id, FAIL and STOP
    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_profiles, v_unmapped_profile_ids 
    FROM public.profiles WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_issues, v_unmapped_issue_ids 
    FROM public.department_issues WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_groups, v_unmapped_group_ids 
    FROM public.issue_groups WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_classes, v_unmapped_class_ids 
    FROM public.classes WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_subjects, v_unmapped_subject_ids 
    FROM public.subjects WHERE department_id IS NULL;

    IF v_unmapped_profiles > 0 OR v_unmapped_issues > 0 OR v_unmapped_groups > 0 OR v_unmapped_classes > 0 OR v_unmapped_subjects > 0 THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Unmapped records with NULL department_id detected. CSIT is not a generic fallback. Unmapped Profiles: % (IDs: %); Issues: % (IDs: %); Groups: % (IDs: %); Classes: % (IDs: %); Subjects: % (IDs: %). Please inspect pre-migration queries and explicitly assign departments to these records before re-running the migration.',
            v_unmapped_profiles, COALESCE(v_unmapped_profile_ids, 'none'),
            v_unmapped_issues, COALESCE(v_unmapped_issue_ids, 'none'),
            v_unmapped_groups, COALESCE(v_unmapped_group_ids, 'none'),
            v_unmapped_classes, COALESCE(v_unmapped_class_ids, 'none'),
            v_unmapped_subjects, COALESCE(v_unmapped_subject_ids, 'none');
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 4. Enforce NOT NULL Constraints on Department Columns
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE public.department_issues ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE public.issue_groups ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE public.classes ALTER COLUMN department_id SET NOT NULL;

-- ------------------------------------------------------------------------------
-- 5. Authentication & Integrity Triggers
-- ------------------------------------------------------------------------------

-- 5.1 Auth trigger: Record department_id from registration metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_dept_id UUID;
    v_dept_raw TEXT;
BEGIN
    v_dept_raw := NEW.raw_user_meta_data->>'department_id';
    IF v_dept_raw IS NOT NULL AND v_dept_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_dept_id := v_dept_raw::UUID;
    END IF;

    IF v_dept_id IS NULL THEN
        RAISE EXCEPTION 'Registration rejected: department_id is required for all accounts.';
    END IF;

    INSERT INTO public.profiles (id, full_name, email, role, roll_number, department_id)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Academic User'),
        COALESCE(NEW.email, ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'student'),
        NULLIF(UPPER(TRIM(NEW.raw_user_meta_data->>'roll_number')), ''),
        v_dept_id
    )
    ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        roll_number = COALESCE(EXCLUDED.roll_number, public.profiles.roll_number),
        department_id = EXCLUDED.department_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5.2 Server-side issue department assignment trigger:
-- Overwrites department_id with the student's true profile department
CREATE OR REPLACE FUNCTION public.set_department_issue_dept()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    SELECT department_id INTO NEW.department_id 
    FROM public.profiles 
    WHERE id = NEW.student_id;

    IF NEW.department_id IS NULL THEN
        RAISE EXCEPTION 'Student must belong to a valid department to report an issue.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_dept_issue ON public.department_issues;
CREATE TRIGGER trg_set_dept_issue
    BEFORE INSERT ON public.department_issues
    FOR EACH ROW
    EXECUTE FUNCTION public.set_department_issue_dept();

-- 5.3 Class department consistency trigger:
-- Faculty can only create classes in their own department, matching subject if set
CREATE OR REPLACE FUNCTION public.check_class_department_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_faculty_dept UUID;
    v_subject_dept UUID;
BEGIN
    SELECT department_id INTO v_faculty_dept FROM public.profiles WHERE id = NEW.faculty_id;
    IF v_faculty_dept IS NULL OR NEW.department_id <> v_faculty_dept THEN
        RAISE EXCEPTION 'Faculty can only create classes within their own department.';
    END IF;

    SELECT department_id INTO v_subject_dept FROM public.subjects WHERE id = NEW.subject_id;
    IF v_subject_dept IS NOT NULL AND NEW.department_id <> v_subject_dept THEN
        RAISE EXCEPTION 'Class department must match the subject department.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_class_department ON public.classes;
CREATE TRIGGER trg_check_class_department
    BEFORE INSERT OR UPDATE ON public.classes
    FOR EACH ROW
    EXECUTE FUNCTION public.check_class_department_consistency();

-- 5.4 Group membership department integrity trigger:
-- Enforces that an issue can only be linked to an issue group belonging to the same department
CREATE OR REPLACE FUNCTION public.check_group_member_department_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group_dept UUID;
    v_issue_dept UUID;
BEGIN
    SELECT department_id INTO v_group_dept FROM public.issue_groups WHERE id = NEW.issue_group_id;
    SELECT department_id INTO v_issue_dept FROM public.department_issues WHERE id = NEW.issue_id;

    IF v_group_dept IS NULL OR v_issue_dept IS NULL THEN
        RAISE EXCEPTION 'Cannot link issue to group: both issue and group must have valid departments.';
    END IF;

    IF v_group_dept <> v_issue_dept THEN
        RAISE EXCEPTION 'Department mismatch: cannot link issue from department % to group in department %.',
            v_issue_dept, v_group_dept;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_group_member_dept ON public.issue_group_members;
CREATE TRIGGER trg_check_group_member_dept
    BEFORE INSERT OR UPDATE ON public.issue_group_members
    FOR EACH ROW
    EXECUTE FUNCTION public.check_group_member_department_match();

-- 5.5 Trigger Protection: Immutable issue group fields (Restored Phase 8 security)
CREATE OR REPLACE FUNCTION public.check_issue_group_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Prevent modification of title, summary, category, location, department_id, issue_count, created_at
    IF (OLD.id IS DISTINCT FROM NEW.id) OR
       (OLD.department_id IS DISTINCT FROM NEW.department_id) OR
       (OLD.category IS DISTINCT FROM NEW.category) OR
       (OLD.title IS DISTINCT FROM NEW.title) OR
       (OLD.summary IS DISTINCT FROM NEW.summary) OR
       (OLD.location IS DISTINCT FROM NEW.location) OR
       (OLD.issue_count IS DISTINCT FROM NEW.issue_count) OR
       (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
        RAISE EXCEPTION 'Security violation: Only the status column may be updated on issue_groups.';
    END IF;

    IF NEW.status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_issue_group_fields ON public.issue_groups;
CREATE TRIGGER trg_protect_issue_group_fields
    BEFORE UPDATE ON public.issue_groups
    FOR EACH ROW
    EXECUTE FUNCTION public.check_issue_group_immutable_fields();

-- ------------------------------------------------------------------------------
-- 6. Department-Scoped Row Level Security (RLS) Policies
-- ------------------------------------------------------------------------------

-- 6.1 Department Issues RLS
DROP POLICY IF EXISTS "department_issues_select_policy" ON public.department_issues;
CREATE POLICY "department_issues_select_policy" ON public.department_issues 
    FOR SELECT TO authenticated 
    USING (
        student_id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.department_issues.department_id
        )
    );

DROP POLICY IF EXISTS "department_issues_insert_policy" ON public.department_issues;
CREATE POLICY "department_issues_insert_policy" ON public.department_issues 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student()
        AND department_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    );

DROP POLICY IF EXISTS "department_issues_update_policy" ON public.department_issues;
CREATE POLICY "department_issues_update_policy" ON public.department_issues 
    FOR UPDATE TO authenticated 
    USING (
        student_id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.department_issues.department_id
        )
    );

-- 6.2 Issue Groups RLS
DROP POLICY IF EXISTS issue_groups_hod_select_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_select_policy ON public.issue_groups
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.issue_groups.department_id
        )
    );

DROP POLICY IF EXISTS issue_groups_hod_update_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_update_policy ON public.issue_groups
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.issue_groups.department_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.issue_groups.department_id
        )
        AND status IN ('open', 'resolved', 'closed')
    );

-- 6.3 Classes & Class Members RLS
DROP POLICY IF EXISTS "classes_select_policy" ON public.classes;
CREATE POLICY "classes_select_policy" ON public.classes 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR (
            is_active = true 
            AND department_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
        )
        OR public.is_student_enrolled(id)
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.classes.department_id
        )
    );

DROP POLICY IF EXISTS "classes_insert_policy" ON public.classes;
CREATE POLICY "classes_insert_policy" ON public.classes 
    FOR INSERT TO authenticated 
    WITH CHECK (
        auth.uid() = faculty_id 
        AND public.is_faculty()
        AND department_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    );

DROP POLICY IF EXISTS "class_members_insert_policy" ON public.class_members;
CREATE POLICY "class_members_insert_policy" ON public.class_members 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student() 
        AND public.is_class_active(class_id)
        AND (SELECT department_id FROM public.profiles WHERE id = auth.uid()) = 
            (SELECT department_id FROM public.classes WHERE id = class_id)
    );

-- 6.4 Departments Catalog RLS & Grants (allow anon role for registration dropdown)
DROP POLICY IF EXISTS "departments_select_policy" ON public.departments;
CREATE POLICY "departments_select_policy" ON public.departments 
    FOR SELECT TO authenticated, anon 
    USING (true);

GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON TABLE public.departments TO anon;

-- ------------------------------------------------------------------------------
-- 7. Scoped RPC Updates
-- ------------------------------------------------------------------------------

-- 7.1 Similarity Candidate RPC: Enforce strict department matching (di.department_id = p_department_id)
DROP FUNCTION IF EXISTS public.get_similarity_candidates(UUID, TEXT, UUID, INT);
DROP FUNCTION IF EXISTS public.get_similarity_candidates(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.get_similarity_candidates(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.get_similarity_candidates(
    p_issue_id UUID,
    p_category TEXT,
    p_department_id UUID,
    p_limit INT DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    category TEXT,
    location TEXT,
    description TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_department_id IS NULL THEN
        RAISE EXCEPTION 'department_id is required';
    END IF;

    RETURN QUERY
    SELECT di.id, di.category, di.location, di.description
    FROM public.department_issues di
    WHERE di.id <> p_issue_id
      AND di.status = 'open'
      AND di.department_id = p_department_id -- STRICT DEPARTMENT SILO
      AND (p_category IS NULL OR di.category = p_category)
    ORDER BY di.created_at DESC
    LIMIT LEAST(p_limit, 20);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_similarity_candidates TO authenticated, anon;

-- 7.2 Create Issue Group RPC: Require non-null department_id and validate initial_issue
CREATE OR REPLACE FUNCTION public.create_issue_group(
    p_department_id UUID,
    p_category TEXT,
    p_title TEXT,
    p_summary TEXT DEFAULT NULL,
    p_location TEXT DEFAULT NULL,
    p_initial_issue_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
    v_initial_issue_dept UUID;
BEGIN
    IF p_department_id IS NULL THEN
        RAISE EXCEPTION 'Issue group department_id is strictly required.';
    END IF;

    IF p_title IS NULL OR trim(p_title) = '' THEN
        RAISE EXCEPTION 'Issue group title is required.';
    END IF;

    IF p_category IS NULL OR trim(p_category) = '' THEN
        RAISE EXCEPTION 'Issue group category is required.';
    END IF;

    -- Validate initial issue BEFORE group creation
    IF p_initial_issue_id IS NOT NULL THEN
        SELECT department_id INTO v_initial_issue_dept
        FROM public.department_issues
        WHERE id = p_initial_issue_id;

        IF NOT FOUND OR v_initial_issue_dept IS NULL THEN
            RAISE EXCEPTION 'Initial issue % does not exist or has no department assigned.', p_initial_issue_id;
        END IF;

        IF v_initial_issue_dept <> p_department_id THEN
            RAISE EXCEPTION 'Department mismatch: initial issue belongs to department %, but group is being created for department %.',
                v_initial_issue_dept, p_department_id;
        END IF;
    END IF;

    INSERT INTO public.issue_groups (
        department_id, category, title, summary, location, status, issue_count
    )
    VALUES (
        p_department_id, p_category, trim(p_title), trim(p_summary), trim(p_location), 'open', 0
    )
    RETURNING * INTO v_group;

    IF p_initial_issue_id IS NOT NULL THEN
        INSERT INTO public.issue_group_members (issue_group_id, issue_id)
        VALUES (v_group.id, p_initial_issue_id);

        SELECT * INTO v_group FROM public.issue_groups WHERE id = v_group.id;
    END IF;

    RETURN to_jsonb(v_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_issue_group TO authenticated;

-- 7.3 Add Issue to Group RPC: Validate existence and department match
CREATE OR REPLACE FUNCTION public.add_issue_to_group(
    p_group_id UUID,
    p_issue_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
    v_group_dept_id UUID;
    v_issue_dept_id UUID;
BEGIN
    IF p_group_id IS NULL OR p_issue_id IS NULL THEN
        RAISE EXCEPTION 'Both group_id and issue_id are required.';
    END IF;

    SELECT department_id INTO v_issue_dept_id
    FROM public.department_issues
    WHERE id = p_issue_id;

    IF NOT FOUND OR v_issue_dept_id IS NULL THEN
        RAISE EXCEPTION 'Issue % does not exist or has no assigned department.', p_issue_id;
    END IF;

    SELECT department_id INTO v_group_dept_id
    FROM public.issue_groups
    WHERE id = p_group_id;

    IF NOT FOUND OR v_group_dept_id IS NULL THEN
        RAISE EXCEPTION 'Issue group % does not exist or has no assigned department.', p_group_id;
    END IF;

    IF v_group_dept_id <> v_issue_dept_id THEN
        RAISE EXCEPTION 'Department mismatch: cannot add issue from department % to group in department %.',
            v_issue_dept_id, v_group_dept_id;
    END IF;

    INSERT INTO public.issue_group_members (issue_group_id, issue_id)
    VALUES (p_group_id, p_issue_id)
    ON CONFLICT (issue_group_id, issue_id) DO NOTHING;

    SELECT * INTO v_group FROM public.issue_groups WHERE id = p_group_id;

    RETURN to_jsonb(v_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_issue_to_group TO authenticated, anon;

-- 7.4 HOD Dashboard Data RPC: Filter strictly by calling HOD's department
CREATE OR REPLACE FUNCTION public.get_hod_dashboard_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hod_dept_id UUID;
    v_hod_dept_name TEXT;
    v_groups JSONB;
BEGIN
    -- Verify caller has HOD role and retrieve department
    SELECT p.department_id, d.name INTO v_hod_dept_id, v_hod_dept_name
    FROM public.profiles p
    JOIN public.departments d ON d.id = p.department_id
    WHERE p.id = auth.uid() AND p.role = 'hod';

    IF v_hod_dept_id IS NULL THEN
        RAISE EXCEPTION 'Access denied. Authenticated HOD must belong to a registered department.';
    END IF;

    SELECT COALESCE(jsonb_agg(group_data ORDER BY (group_data->>'created_at') DESC), '[]'::jsonb)
    INTO v_groups
    FROM (
        SELECT 
            ig.id,
            ig.department_id,
            v_hod_dept_name AS department_name,
            ig.category,
            ig.title,
            ig.summary,
            ig.location,
            ig.status,
            ig.issue_count,
            ig.created_at,
            ig.updated_at,
            to_jsonb(p.*) AS priority,
            to_jsonb(w.*) AS early_warning,
            to_jsonb(r.*) AS recurrence,
            (
                SELECT COALESCE(jsonb_agg(
                    jsonb_build_object(
                        'id', di.id,
                        'category', di.category,
                        'location', di.location,
                        'description', di.description,
                        'severity', COALESCE(fs.severity, di.severity, 'low'),
                        'is_anonymous', di.is_anonymous,
                        'created_at', di.created_at,
                        'status', di.status
                    ) ORDER BY di.created_at ASC
                ), '[]'::jsonb)
                FROM public.issue_group_members igm
                JOIN public.department_issues di ON di.id = igm.issue_id
                LEFT JOIN public.feedback_severity fs ON fs.issue_id = di.id
                WHERE igm.issue_group_id = ig.id
            ) AS reports
        FROM public.issue_groups ig
        LEFT JOIN public.issue_group_priority p ON p.issue_group_id = ig.id
        LEFT JOIN public.issue_group_early_warning w ON w.issue_group_id = ig.id
        LEFT JOIN public.issue_group_recurrence r ON r.issue_group_id = ig.id
        WHERE ig.department_id = v_hod_dept_id -- STRICT HOD DEPARTMENT ISOLATION
    ) group_data;

    RETURN jsonb_build_object(
        'success', true,
        'department_id', v_hod_dept_id,
        'department_name', v_hod_dept_name,
        'groups', v_groups
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hod_dashboard_data TO authenticated;

-- 7.5 HOD Status Update RPC: Verify HOD department ownership
CREATE OR REPLACE FUNCTION public.update_issue_group_status(
    p_group_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hod_dept_id UUID;
    v_group_dept_id UUID;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required.';
    END IF;

    -- Verify caller is authenticated and has HOD role
    SELECT department_id INTO v_hod_dept_id
    FROM public.profiles
    WHERE id = auth.uid() AND role = 'hod';

    IF v_hod_dept_id IS NULL THEN
        RAISE EXCEPTION 'Access denied. HOD role and department assignment required.';
    END IF;

    -- Verify target issue group belongs to the HOD's department
    SELECT department_id INTO v_group_dept_id
    FROM public.issue_groups
    WHERE id = p_group_id;

    IF v_group_dept_id IS NULL THEN
        RAISE EXCEPTION 'Issue group not found for ID %.', p_group_id;
    END IF;

    IF v_group_dept_id <> v_hod_dept_id THEN
        RAISE EXCEPTION 'Access denied. You can only update issue groups within your own department.';
    END IF;

    -- Validate allowed status values strictly
    IF p_status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', p_status;
    END IF;

    UPDATE public.issue_groups
    SET status = p_status,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_group_id
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_issue_group_status TO authenticated;

COMMIT;
