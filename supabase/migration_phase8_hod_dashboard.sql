-- ==============================================================================
-- Phase 8 Migration: HOD Intelligence Dashboard
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Restrict Issue Group Updates to Status Only (Defense-in-Depth)
-- Revoke any broad table-level update privilege
REVOKE UPDATE ON TABLE public.issue_groups FROM authenticated, anon, public;

-- Grant column-level UPDATE strictly on status and updated_at
GRANT UPDATE (status, updated_at) ON TABLE public.issue_groups TO authenticated;

-- Row Level Security: Enforce HOD role and valid status values
DROP POLICY IF EXISTS issue_groups_hod_update_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_update_policy ON public.issue_groups
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
        AND status IN ('open', 'resolved', 'closed')
    );

-- Trigger Protection: Block any modification to immutable fields
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

-- 2. Secure RPC: Update Issue Group Status (HOD Only Controlled Mechanism)
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
    v_is_hod BOOLEAN;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required.';
    END IF;

    -- Verify caller is authenticated and has HOD role
    SELECT (role = 'hod') INTO v_is_hod
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_is_hod IS NOT TRUE THEN
        RAISE EXCEPTION 'Access denied. HOD role required to update issue group status.';
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

    IF v_res.id IS NULL THEN
        RAISE EXCEPTION 'Issue group not found for ID %.', p_group_id;
    END IF;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_issue_group_status TO authenticated;

-- 3. Atomic Consolidated RPC: Get HOD Dashboard Data
-- Retrieves all issue groups with analytical results and member reports in 1 database round-trip
-- Zero-PII: Does NOT expose student_id, student_email, or roll_number
-- Correct severity join: Joins public.feedback_severity ON fs.issue_id = di.id
CREATE OR REPLACE FUNCTION public.get_hod_dashboard_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_hod BOOLEAN;
    v_groups JSONB;
BEGIN
    -- Verify caller has HOD role
    SELECT (role = 'hod') INTO v_is_hod
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_is_hod IS NOT TRUE THEN
        RAISE EXCEPTION 'Access denied. HOD role required to access intelligence dashboard data.';
    END IF;

    SELECT COALESCE(jsonb_agg(group_data ORDER BY (group_data->>'created_at') DESC), '[]'::jsonb)
    INTO v_groups
    FROM (
        SELECT 
            ig.id,
            ig.department_id,
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
    ) group_data;

    RETURN jsonb_build_object(
        'success', true,
        'groups', v_groups
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hod_dashboard_data TO authenticated;
