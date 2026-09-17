-- ==============================================================================
-- Phase 5 Migration: AI Severity Prediction
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create feedback_severity table
CREATE TABLE IF NOT EXISTS public.feedback_severity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_id UUID REFERENCES public.class_feedback(id) ON DELETE CASCADE,
    issue_id UUID REFERENCES public.department_issues(id) ON DELETE CASCADE,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    confidence NUMERIC(4, 3) CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    model_provider TEXT NOT NULL DEFAULT 'google-gemini',
    error_message TEXT,
    predicted_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT chk_severity_target CHECK (
        (feedback_id IS NOT NULL AND issue_id IS NULL) OR
        (feedback_id IS NULL AND issue_id IS NOT NULL)
    ),
    CONSTRAINT uq_feedback_severity UNIQUE (feedback_id),
    CONSTRAINT uq_issue_severity UNIQUE (issue_id)
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_severity_feedback ON public.feedback_severity(feedback_id);
CREATE INDEX IF NOT EXISTS idx_severity_issue ON public.feedback_severity(issue_id);

-- 3. Security Definer Helper RPC
CREATE OR REPLACE FUNCTION public.record_feedback_severity(
    p_feedback_id UUID DEFAULT NULL,
    p_issue_id UUID DEFAULT NULL,
    p_severity TEXT DEFAULT 'medium',
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

    IF p_severity NOT IN ('low', 'medium', 'high') THEN
        RAISE EXCEPTION 'Invalid severity value: %', p_severity;
    END IF;

    IF p_feedback_id IS NOT NULL THEN
        INSERT INTO public.feedback_severity (
            feedback_id, severity, confidence, model_provider, status, error_message, predicted_at
        )
        VALUES (
            p_feedback_id, p_severity, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
        )
        ON CONFLICT (feedback_id) DO UPDATE SET
            severity = EXCLUDED.severity,
            confidence = EXCLUDED.confidence,
            model_provider = EXCLUDED.model_provider,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            predicted_at = timezone('utc'::text, now())
        RETURNING * INTO v_res;
    ELSE
        INSERT INTO public.feedback_severity (
            issue_id, severity, confidence, model_provider, status, error_message, predicted_at
        )
        VALUES (
            p_issue_id, p_severity, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
        )
        ON CONFLICT (issue_id) DO UPDATE SET
            severity = EXCLUDED.severity,
            confidence = EXCLUDED.confidence,
            model_provider = EXCLUDED.model_provider,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            predicted_at = timezone('utc'::text, now())
        RETURNING * INTO v_res;
    END IF;

    RETURN to_jsonb(v_res);
END;
$$;

-- 4. Enable Row Level Security
ALTER TABLE public.feedback_severity ENABLE ROW LEVEL SECURITY;

-- 4.1 SELECT Policies
-- Faculty can view severity rows for feedback in their sessions
-- HOD/Faculty can view severity rows for department issues
DROP POLICY IF EXISTS severity_faculty_select_policy ON public.feedback_severity;
CREATE POLICY severity_faculty_select_policy ON public.feedback_severity
    FOR SELECT TO authenticated
    USING (
        (feedback_id IS NOT NULL AND public.is_faculty() AND public.is_faculty_for_feedback(feedback_id))
        OR (issue_id IS NOT NULL AND (public.is_hod() OR public.is_faculty()))
    );

-- 4.2 INSERT / UPDATE Policies
DROP POLICY IF EXISTS severity_insert_policy ON public.feedback_severity;
CREATE POLICY severity_insert_policy ON public.feedback_severity
    FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS severity_update_policy ON public.feedback_severity;
CREATE POLICY severity_update_policy ON public.feedback_severity
    FOR UPDATE TO authenticated
    USING (true)
    WITH CHECK (true);

-- 5. Privileges & Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feedback_severity TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_feedback_severity TO authenticated;
