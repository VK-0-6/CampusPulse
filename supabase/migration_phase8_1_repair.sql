-- ==============================================================================
-- PHASE 8.1 REPAIR MIGRATION: RLS Anti-Recursion & PostgREST Schema Reload
-- 
-- Description:
--   1. Eliminates mutual RLS recursion between public.profiles and public.classes
--      by introducing 4 minimal, strictly scoped SECURITY DEFINER helper functions.
--   2. Updates RLS policies on profiles, classes, class_members, department_issues,
--      and issue_groups to use these helpers, breaking the query rewriter loop.
--   3. Reloads PostgREST schema cache (NOTIFY pgrst, 'reload schema';).
--   4. Preserves 100% of department isolation and Phase 8 security boundaries.
--   5. DOES NOT grant get_hod_dashboard_data to anon (strictly authenticated/HOD).
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- SECTION 1: ANTI-RECURSION SECURITY DEFINER HELPER FUNCTIONS
-- ==============================================================================

-- 1.1 Helper: Retrieve authenticated user's department_id without RLS recursion
CREATE OR REPLACE FUNCTION public.get_auth_department_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT department_id FROM public.profiles WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_auth_department_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_auth_department_id() TO authenticated;

-- 1.2 Helper: Check if authenticated user is HOD of a specific department without RLS recursion
CREATE OR REPLACE FUNCTION public.is_department_hod(p_dept_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() 
          AND role = 'hod' 
          AND department_id = p_dept_id
          AND p_dept_id IS NOT NULL
    );
$$;

REVOKE ALL ON FUNCTION public.is_department_hod(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_department_hod(UUID) TO authenticated;

-- 1.3 Helper: Check if faculty can view a student profile without RLS recursion
CREATE OR REPLACE FUNCTION public.can_faculty_view_student_profile(p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.class_members cm
        JOIN public.classes c ON c.id = cm.class_id
        WHERE cm.student_id = p_student_id 
          AND c.faculty_id = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION public.can_faculty_view_student_profile(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_faculty_view_student_profile(UUID) TO authenticated;

-- 1.4 Helper: Retrieve class department_id without triggering classes RLS from class_members
CREATE OR REPLACE FUNCTION public.get_class_department_id(p_class_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT department_id FROM public.classes WHERE id = p_class_id;
$$;

REVOKE ALL ON FUNCTION public.get_class_department_id(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_class_department_id(UUID) TO authenticated;

-- ==============================================================================
-- SECTION 2: PROFILES RLS REPAIR (Sever dependency on classes RLS)
-- ==============================================================================

DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy" ON public.profiles 
    FOR SELECT TO authenticated 
    USING (
        auth.uid() = id 
        OR (
            role IN ('faculty', 'hod') 
            AND department_id = public.get_auth_department_id()
        )
        OR public.can_faculty_view_student_profile(id)
    );

-- ==============================================================================
-- SECTION 3: CLASSES & CLASS MEMBERS RLS REPAIR (Sever dependency on profiles RLS)
-- ==============================================================================

-- 3.1 Classes SELECT: Department-scoped, zero profiles recursion
DROP POLICY IF EXISTS "classes_select_policy" ON public.classes;
CREATE POLICY "classes_select_policy" ON public.classes 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR (
            is_active = true 
            AND department_id = public.get_auth_department_id()
        )
        OR public.is_student_enrolled(id)
        OR public.is_department_hod(department_id)
    );

-- 3.2 Classes INSERT: Faculty-owned, department-consistent
DROP POLICY IF EXISTS "classes_insert_policy" ON public.classes;
CREATE POLICY "classes_insert_policy" ON public.classes 
    FOR INSERT TO authenticated 
    WITH CHECK (
        auth.uid() = faculty_id 
        AND public.is_faculty()
        AND department_id = public.get_auth_department_id()
    );

-- 3.3 Class Members INSERT: Student department must match class department
DROP POLICY IF EXISTS "class_members_insert_policy" ON public.class_members;
CREATE POLICY "class_members_insert_policy" ON public.class_members 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student() 
        AND public.is_class_active(class_id)
        AND public.get_auth_department_id() = public.get_class_department_id(class_id)
    );

-- ==============================================================================
-- SECTION 4: DEPARTMENT ISSUES RLS REPAIR
-- ==============================================================================

-- 4.1 Department Issues SELECT: Student views own; HOD views own department
DROP POLICY IF EXISTS "department_issues_select_policy" ON public.department_issues;
CREATE POLICY "department_issues_select_policy" ON public.department_issues 
    FOR SELECT TO authenticated 
    USING (
        student_id = auth.uid() 
        OR public.is_department_hod(department_id)
    );

-- 4.2 Department Issues INSERT: Bound to student's department
DROP POLICY IF EXISTS "department_issues_insert_policy" ON public.department_issues;
CREATE POLICY "department_issues_insert_policy" ON public.department_issues 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student()
        AND department_id = public.get_auth_department_id()
    );

-- 4.3 Department Issues UPDATE: Student or HOD of department
DROP POLICY IF EXISTS "department_issues_update_policy" ON public.department_issues;
CREATE POLICY "department_issues_update_policy" ON public.department_issues 
    FOR UPDATE TO authenticated 
    USING (
        student_id = auth.uid() 
        OR public.is_department_hod(department_id)
    );

-- ==============================================================================
-- SECTION 5: ISSUE GROUPS & MEMBERS RLS REPAIR
-- ==============================================================================

-- 5.1 Issue Groups SELECT: HOD restricted to own department
DROP POLICY IF EXISTS issue_groups_hod_select_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_select_policy ON public.issue_groups
    FOR SELECT TO authenticated
    USING (
        public.is_department_hod(department_id)
    );

-- 5.2 Issue Groups UPDATE: HOD restricted to own department status changes
DROP POLICY IF EXISTS issue_groups_hod_update_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_update_policy ON public.issue_groups
    FOR UPDATE TO authenticated
    USING (
        public.is_department_hod(department_id)
    )
    WITH CHECK (
        public.is_department_hod(department_id)
        AND status IN ('open', 'resolved', 'closed')
    );

-- 5.3 Issue Group Members SELECT: HOD views members in own department groups
DROP POLICY IF EXISTS "issue_group_members_select_policy" ON public.issue_group_members;
CREATE POLICY "issue_group_members_select_policy" ON public.issue_group_members
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.issue_groups ig
            WHERE ig.id = public.issue_group_members.issue_group_id
              AND public.is_department_hod(ig.department_id)
        )
    );

-- ==============================================================================
-- SECTION 6: HOD DASHBOARD RPC & POSTGREST SCHEMA CACHE RELOAD
-- ==============================================================================

-- Re-assert get_hod_dashboard_data with search_path and STRICT authenticated-only permissions
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

    SELECT COALESCE(jsonb_agg(to_jsonb(group_data) ORDER BY (to_jsonb(group_data)->>'created_at') DESC), '[]'::jsonb)
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
        WHERE ig.department_id = v_hod_dept_id
    ) group_data;

    RETURN jsonb_build_object(
        'success', true,
        'department_id', v_hod_dept_id,
        'department_name', v_hod_dept_name,
        'groups', v_groups
    );
END;
$$;

-- Security Enforcement: HOD dashboard is strictly authenticated/HOD-only (NO anon access)
REVOKE ALL ON FUNCTION public.get_hod_dashboard_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hod_dashboard_data() TO authenticated;

-- Force PostgREST to reload its schema cache immediately so the RPC is discovered
NOTIFY pgrst, 'reload schema';

COMMIT;
