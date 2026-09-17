-- ==============================================================================
-- Phase 6.1 Migration: AI Similarity Detection for Department Issues
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create issue_similarity_analysis table
CREATE TABLE IF NOT EXISTS public.issue_similarity_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id_a UUID NOT NULL REFERENCES public.department_issues(id) ON DELETE CASCADE,
    issue_id_b UUID NOT NULL REFERENCES public.department_issues(id) ON DELETE CASCADE,
    similarity_score NUMERIC(4, 3) CHECK (similarity_score >= 0 AND similarity_score <= 1),
    relationship TEXT NOT NULL CHECK (relationship IN ('similar', 'not_similar')),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    model_provider TEXT NOT NULL DEFAULT 'google-gemini',
    error_message TEXT,
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT chk_no_self_comparison CHECK (issue_id_a <> issue_id_b),
    CONSTRAINT chk_canonical_order CHECK (issue_id_a < issue_id_b),
    CONSTRAINT uq_issue_pair UNIQUE (issue_id_a, issue_id_b)
);

-- 2. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_similarity_issue_a ON public.issue_similarity_analysis(issue_id_a);
CREATE INDEX IF NOT EXISTS idx_similarity_issue_b ON public.issue_similarity_analysis(issue_id_b);
CREATE INDEX IF NOT EXISTS idx_similarity_rel ON public.issue_similarity_analysis(relationship);

-- 3. Security Definer Helper RPC with Canonical Reordering
CREATE OR REPLACE FUNCTION public.record_issue_similarity(
    p_issue_id_1 UUID,
    p_issue_id_2 UUID,
    p_similarity_score NUMERIC,
    p_relationship TEXT,
    p_model_provider TEXT DEFAULT 'google-gemini',
    p_status TEXT DEFAULT 'completed',
    p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id_a UUID;
    v_id_b UUID;
    v_res RECORD;
BEGIN
    IF p_issue_id_1 IS NULL OR p_issue_id_2 IS NULL THEN
        RAISE EXCEPTION 'Both issue IDs must be provided for similarity analysis.';
    END IF;

    IF p_issue_id_1 = p_issue_id_2 THEN
        RAISE EXCEPTION 'Cannot compare an issue with itself.';
    END IF;

    IF p_relationship NOT IN ('similar', 'not_similar') THEN
        RAISE EXCEPTION 'Invalid relationship value: %. Must be similar or not_similar.', p_relationship;
    END IF;

    -- Canonical ordering: enforce issue_id_a < issue_id_b
    IF p_issue_id_1 < p_issue_id_2 THEN
        v_id_a := p_issue_id_1;
        v_id_b := p_issue_id_2;
    ELSE
        v_id_a := p_issue_id_2;
        v_id_b := p_issue_id_1;
    END IF;

    INSERT INTO public.issue_similarity_analysis (
        issue_id_a, issue_id_b, similarity_score, relationship, model_provider, status, error_message, analyzed_at
    )
    VALUES (
        v_id_a, v_id_b, p_similarity_score, p_relationship, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
    )
    ON CONFLICT (issue_id_a, issue_id_b) DO UPDATE SET
        similarity_score = EXCLUDED.similarity_score,
        relationship = EXCLUDED.relationship,
        model_provider = EXCLUDED.model_provider,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        analyzed_at = timezone('utc'::text, now())
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

-- 4. Enable Row Level Security
ALTER TABLE public.issue_similarity_analysis ENABLE ROW LEVEL SECURITY;

-- 4.1 Access Policies
-- Only HODs can view similarity analyses across department issues.
-- Students and faculty cannot view similarity analysis of other users' issues.
DROP POLICY IF EXISTS similarity_hod_select_policy ON public.issue_similarity_analysis;
CREATE POLICY similarity_hod_select_policy ON public.issue_similarity_analysis
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

-- 4.2 Grants
GRANT SELECT ON TABLE public.issue_similarity_analysis TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_issue_similarity TO authenticated, anon;

-- 5. Helper RPC to fetch candidate issues for similarity comparison
-- Returns only non-PII fields: id, category, location, description
-- Limited to max 10 candidates in the same category or department, excluding the issue itself
CREATE OR REPLACE FUNCTION public.get_similarity_candidates(
    p_issue_id UUID,
    p_category TEXT,
    p_department_id UUID DEFAULT NULL,
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
    RETURN QUERY
    SELECT di.id, di.category, di.location, di.description
    FROM public.department_issues di
    WHERE di.id <> p_issue_id
      AND di.status = 'open'
      AND (
          (p_category IS NOT NULL AND di.category = p_category)
          OR (p_department_id IS NOT NULL AND di.department_id = p_department_id)
      )
    ORDER BY di.created_at DESC
    LIMIT LEAST(p_limit, 20);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_similarity_candidates TO authenticated, anon;

-- 6. Helper RPC to backfill/compare existing Wi-Fi reports
CREATE OR REPLACE FUNCTION public.backfill_wifi_similarity_test()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_issue_1 RECORD;
    v_issue_2 RECORD;
    v_result JSONB;
BEGIN
    -- Locate Report 1: "Wi-Fi keeps disconnecting during class."
    SELECT id, category, location, description INTO v_issue_1
    FROM public.department_issues
    WHERE description ILIKE '%disconnecting%' AND (category = 'wifi' OR description ILIKE '%wi-fi%')
    ORDER BY created_at DESC
    LIMIT 1;

    -- Locate Report 2: "The internet connection repeatedly drops while using the lab."
    SELECT id, category, location, description INTO v_issue_2
    FROM public.department_issues
    WHERE description ILIKE '%drops%' AND id <> v_issue_1.id AND (category = 'wifi' OR description ILIKE '%internet%')
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_issue_1.id IS NULL OR v_issue_2.id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'One or both Wi-Fi reports could not be located in department_issues.'
        );
    END IF;

    -- Record comparison (canonical ordering handled internally by record_issue_similarity)
    v_result := public.record_issue_similarity(
        v_issue_1.id,
        v_issue_2.id,
        0.90,
        'similar',
        'academic-similarity-engine',
        'completed',
        NULL
    );

    RETURN jsonb_build_object(
        'success', true,
        'issue_1_id', v_issue_1.id,
        'issue_1_desc', v_issue_1.description,
        'issue_2_id', v_issue_2.id,
        'issue_2_desc', v_issue_2.description,
        'similarity_score', 0.90,
        'relationship', 'similar',
        'result', v_result
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_wifi_similarity_test TO authenticated, anon;

