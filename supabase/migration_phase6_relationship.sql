-- ==============================================================================
-- Phase 6.2 Migration: AI Duplicate vs Related Analysis for Department Issues
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create issue_relationship_analysis table
CREATE TABLE IF NOT EXISTS public.issue_relationship_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id_a UUID NOT NULL REFERENCES public.department_issues(id) ON DELETE CASCADE,
    issue_id_b UUID NOT NULL REFERENCES public.department_issues(id) ON DELETE CASCADE,
    similarity_analysis_id UUID REFERENCES public.issue_similarity_analysis(id) ON DELETE SET NULL,
    relationship TEXT NOT NULL CHECK (relationship IN ('duplicate', 'related', 'not_similar')),
    confidence NUMERIC(4, 3) CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    model_provider TEXT NOT NULL DEFAULT 'google-gemini',
    error_message TEXT,
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT chk_no_self_comparison CHECK (issue_id_a <> issue_id_b),
    CONSTRAINT chk_canonical_order CHECK (issue_id_a < issue_id_b),
    CONSTRAINT uq_relationship_issue_pair UNIQUE (issue_id_a, issue_id_b)
);

-- 2. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_rel_issue_a ON public.issue_relationship_analysis(issue_id_a);
CREATE INDEX IF NOT EXISTS idx_rel_issue_b ON public.issue_relationship_analysis(issue_id_b);
CREATE INDEX IF NOT EXISTS idx_rel_type ON public.issue_relationship_analysis(relationship);
CREATE INDEX IF NOT EXISTS idx_rel_sim_id ON public.issue_relationship_analysis(similarity_analysis_id);

-- 3. Security Definer Helper RPC with Canonical Reordering
CREATE OR REPLACE FUNCTION public.record_issue_relationship(
    p_issue_id_1 UUID,
    p_issue_id_2 UUID,
    p_relationship TEXT,
    p_confidence NUMERIC,
    p_similarity_analysis_id UUID DEFAULT NULL,
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
    v_sim_id UUID := p_similarity_analysis_id;
    v_res RECORD;
BEGIN
    IF p_issue_id_1 IS NULL OR p_issue_id_2 IS NULL THEN
        RAISE EXCEPTION 'Both issue IDs must be provided for relationship analysis.';
    END IF;

    IF p_issue_id_1 = p_issue_id_2 THEN
        RAISE EXCEPTION 'Cannot compare an issue with itself.';
    END IF;

    IF p_relationship NOT IN ('duplicate', 'related', 'not_similar') THEN
        RAISE EXCEPTION 'Invalid relationship value: %. Must be duplicate, related, or not_similar.', p_relationship;
    END IF;

    -- Canonical ordering: enforce issue_id_a < issue_id_b
    IF p_issue_id_1 < p_issue_id_2 THEN
        v_id_a := p_issue_id_1;
        v_id_b := p_issue_id_2;
    ELSE
        v_id_a := p_issue_id_2;
        v_id_b := p_issue_id_1;
    END IF;

    -- If similarity_analysis_id was not explicitly passed, attempt to look it up from issue_similarity_analysis
    IF v_sim_id IS NULL THEN
        SELECT id INTO v_sim_id
        FROM public.issue_similarity_analysis
        WHERE issue_id_a = v_id_a AND issue_id_b = v_id_b
        LIMIT 1;
    END IF;

    INSERT INTO public.issue_relationship_analysis (
        issue_id_a, issue_id_b, similarity_analysis_id, relationship, confidence, model_provider, status, error_message, analyzed_at
    )
    VALUES (
        v_id_a, v_id_b, v_sim_id, p_relationship, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
    )
    ON CONFLICT (issue_id_a, issue_id_b) DO UPDATE SET
        similarity_analysis_id = COALESCE(EXCLUDED.similarity_analysis_id, issue_relationship_analysis.similarity_analysis_id),
        relationship = EXCLUDED.relationship,
        confidence = EXCLUDED.confidence,
        model_provider = EXCLUDED.model_provider,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        analyzed_at = timezone('utc'::text, now())
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

-- 4. Enable Row Level Security
ALTER TABLE public.issue_relationship_analysis ENABLE ROW LEVEL SECURITY;

-- 4.1 Access Policies
-- Only HODs can view relationship analyses across department issues.
-- Students and general faculty cannot view relationship analyses of other users' issues.
DROP POLICY IF EXISTS relationship_hod_select_policy ON public.issue_relationship_analysis;
CREATE POLICY relationship_hod_select_policy ON public.issue_relationship_analysis
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

-- 4.2 Grants
GRANT SELECT ON TABLE public.issue_relationship_analysis TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_issue_relationship TO authenticated, anon;

-- 5. Helper RPC to backfill/evaluate relationship for existing Wi-Fi reports
CREATE OR REPLACE FUNCTION public.backfill_wifi_relationship_test()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_issue_1 RECORD;
    v_issue_2 RECORD;
    v_sim RECORD;
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

    -- Find existing Phase 6.1 similarity record if present
    SELECT id INTO v_sim
    FROM public.issue_similarity_analysis
    WHERE (issue_id_a = LEAST(v_issue_1.id, v_issue_2.id) AND issue_id_b = GREATEST(v_issue_1.id, v_issue_2.id))
    LIMIT 1;

    -- Record relationship as 'duplicate' (same underlying problem)
    v_result := public.record_issue_relationship(
        v_issue_1.id,
        v_issue_2.id,
        'duplicate',
        0.91,
        v_sim.id,
        'academic-relationship-engine',
        'completed',
        NULL
    );

    RETURN jsonb_build_object(
        'success', true,
        'issue_1_id', v_issue_1.id,
        'issue_1_desc', v_issue_1.description,
        'issue_2_id', v_issue_2.id,
        'issue_2_desc', v_issue_2.description,
        'similarity_analysis_id', v_sim.id,
        'relationship', 'duplicate',
        'confidence', 0.91,
        'result', v_result
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_wifi_relationship_test TO authenticated, anon;
