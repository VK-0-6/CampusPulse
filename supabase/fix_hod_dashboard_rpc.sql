-- ==============================================================================
-- MINIMAL FIX: public.get_hod_dashboard_data()
-- 
-- Fixes PostgreSQL Error:
--   operator does not exist: record ->> unknown
--
-- Change:
--   Converts composite record 'group_data' to JSONB before using '->>' operator:
--   to_jsonb(group_data) ORDER BY (to_jsonb(group_data)->>'created_at') DESC
--
-- Preserves:
--   - Return type: JSONB
--   - SECURITY DEFINER
--   - SET search_path = public
--   - Strict HOD department filtering: ig.department_id = v_hod_dept_id
--   - Authenticated EXECUTE = true, anon EXECUTE = false
--   - Zero RLS changes, zero table modifications
-- ==============================================================================

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
    -- 1. Verify caller has HOD role and retrieve their assigned department
    SELECT p.department_id, d.name INTO v_hod_dept_id, v_hod_dept_name
    FROM public.profiles p
    JOIN public.departments d ON d.id = p.department_id
    WHERE p.id = auth.uid() AND p.role = 'hod';

    IF v_hod_dept_id IS NULL THEN
        RAISE EXCEPTION 'Access denied. Authenticated HOD must belong to a registered department.';
    END IF;

    -- 2. Aggregate department-scoped issue groups with analytical intelligence
    SELECT COALESCE(
        jsonb_agg(
            to_jsonb(group_data) 
            ORDER BY (to_jsonb(group_data)->>'created_at') DESC
        ), 
        '[]'::jsonb
    )
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

-- Security: Strictly authenticated HOD only; no anon access
REVOKE ALL ON FUNCTION public.get_hod_dashboard_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hod_dashboard_data() TO authenticated;

-- Notify PostgREST schema cache to reload immediately
NOTIFY pgrst, 'reload schema';
