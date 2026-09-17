-- ==============================================================================
-- Phase 5 Migration: Automatic Feedback & Issue Classification
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create feedback_classification table
CREATE TABLE IF NOT EXISTS public.feedback_classification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_id UUID REFERENCES public.class_feedback(id) ON DELETE CASCADE,
    issue_id UUID REFERENCES public.department_issues(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    confidence NUMERIC(4, 3) CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    model_provider TEXT NOT NULL DEFAULT 'google-gemini',
    error_message TEXT,
    classified_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT chk_classification_target CHECK (
        (feedback_id IS NOT NULL AND issue_id IS NULL) OR
        (feedback_id IS NULL AND issue_id IS NOT NULL)
    ),
    CONSTRAINT uq_feedback_classification UNIQUE (feedback_id),
    CONSTRAINT uq_issue_classification UNIQUE (issue_id)
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_classification_feedback ON public.feedback_classification(feedback_id);
CREATE INDEX IF NOT EXISTS idx_classification_issue ON public.feedback_classification(issue_id);

-- 3. Security Definer Helper RPC
CREATE OR REPLACE FUNCTION public.record_feedback_classification(
    p_feedback_id UUID DEFAULT NULL,
    p_issue_id UUID DEFAULT NULL,
    p_category TEXT DEFAULT 'other',
    p_confidence NUMERIC DEFAULT 1.0,
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
    v_res RECORD;
BEGIN
    IF p_feedback_id IS NULL AND p_issue_id IS NULL THEN
        RAISE EXCEPTION 'Either feedback_id or issue_id must be provided.';
    END IF;

    IF p_feedback_id IS NOT NULL THEN
        INSERT INTO public.feedback_classification (
            feedback_id, category, confidence, model_provider, status, error_message, classified_at
        )
        VALUES (
            p_feedback_id, p_category, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
        )
        ON CONFLICT (feedback_id) DO UPDATE SET
            category = EXCLUDED.category,
            confidence = EXCLUDED.confidence,
            model_provider = EXCLUDED.model_provider,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            classified_at = timezone('utc'::text, now())
        RETURNING * INTO v_res;
    ELSE
        INSERT INTO public.feedback_classification (
            issue_id, category, confidence, model_provider, status, error_message, classified_at
        )
        VALUES (
            p_issue_id, p_category, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
        )
        ON CONFLICT (issue_id) DO UPDATE SET
            category = EXCLUDED.category,
            confidence = EXCLUDED.confidence,
            model_provider = EXCLUDED.model_provider,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            classified_at = timezone('utc'::text, now())
        RETURNING * INTO v_res;
    END IF;

    RETURN to_jsonb(v_res);
END;
$$;

-- 4. Enable Row Level Security
ALTER TABLE public.feedback_classification ENABLE ROW LEVEL SECURITY;

-- 4.1 SELECT Policies
-- Faculty can view classification rows for feedback in their sessions
-- HOD/Faculty can view classification rows for department issues
DROP POLICY IF EXISTS classification_faculty_select_policy ON public.feedback_classification;
CREATE POLICY classification_faculty_select_policy ON public.feedback_classification
    FOR SELECT TO authenticated
    USING (
        (feedback_id IS NOT NULL AND public.is_faculty() AND public.is_faculty_for_feedback(feedback_id))
        OR (issue_id IS NOT NULL AND (public.is_hod() OR public.is_faculty()))
    );

-- 4.2 INSERT / UPDATE Policies
DROP POLICY IF EXISTS classification_insert_policy ON public.feedback_classification;
CREATE POLICY classification_insert_policy ON public.feedback_classification
    FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS classification_update_policy ON public.feedback_classification;
CREATE POLICY classification_update_policy ON public.feedback_classification
    FOR UPDATE TO authenticated
    USING (true)
    WITH CHECK (true);

-- 5. Privileges & Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feedback_classification TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_feedback_classification TO authenticated;
