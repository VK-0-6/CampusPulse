-- Migration: Phase 8.2 Similarity Candidate Department ID
-- Purpose: Include department_id in get_similarity_candidates return table so candidates fulfill grouping contract.

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
    description TEXT,
    department_id UUID
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
    SELECT di.id, di.category, di.location, di.description, di.department_id
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

-- Allow issue_count updates on issue_groups so trg_sync_issue_group_count and add_issue_to_group can maintain counts
CREATE OR REPLACE FUNCTION public.check_issue_group_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Prevent modification of title, summary, category, location, department_id, created_at
    IF (OLD.id IS DISTINCT FROM NEW.id) OR
       (OLD.department_id IS DISTINCT FROM NEW.department_id) OR
       (OLD.category IS DISTINCT FROM NEW.category) OR
       (OLD.title IS DISTINCT FROM NEW.title) OR
       (OLD.summary IS DISTINCT FROM NEW.summary) OR
       (OLD.location IS DISTINCT FROM NEW.location) OR
       (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
        RAISE EXCEPTION 'Security violation: Core metadata fields on issue_groups may not be modified.';
    END IF;

    IF NEW.status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

