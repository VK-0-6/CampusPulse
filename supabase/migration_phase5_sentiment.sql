-- ==============================================================================
-- Phase 5 Migration: AI Feedback Analysis (Sentiment Analysis Only)
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create feedback_sentiment_analysis table
CREATE TABLE IF NOT EXISTS public.feedback_sentiment_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_id UUID REFERENCES public.class_feedback(id) ON DELETE CASCADE,
    issue_id UUID REFERENCES public.department_issues(id) ON DELETE CASCADE,
    sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative')),
    confidence NUMERIC(4, 3) CHECK (confidence >= 0 AND confidence <= 1),
    model_provider TEXT NOT NULL DEFAULT 'google-gemini',
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT chk_sentiment_target CHECK (
        (feedback_id IS NOT NULL AND issue_id IS NULL) OR
        (feedback_id IS NULL AND issue_id IS NOT NULL)
    ),
    CONSTRAINT uq_feedback_sentiment UNIQUE (feedback_id),
    CONSTRAINT uq_issue_sentiment UNIQUE (issue_id)
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_sentiment_feedback ON public.feedback_sentiment_analysis(feedback_id);
CREATE INDEX IF NOT EXISTS idx_sentiment_issue ON public.feedback_sentiment_analysis(issue_id);

-- 3. Security Definer Helper Functions
-- Helper to check if current user is the faculty teaching the session for a feedback record
CREATE OR REPLACE FUNCTION public.is_faculty_for_feedback(p_feedback_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.class_feedback f
    JOIN public.class_feedback_sessions s ON f.session_id = s.id
    WHERE f.id = p_feedback_id AND s.faculty_id = auth.uid()
  );
$$;

-- Helper to safely record sentiment results
CREATE OR REPLACE FUNCTION public.record_feedback_sentiment(
    p_feedback_id UUID DEFAULT NULL,
    p_issue_id UUID DEFAULT NULL,
    p_sentiment TEXT DEFAULT 'neutral',
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

    IF p_sentiment NOT IN ('positive', 'neutral', 'negative') THEN
        RAISE EXCEPTION 'Invalid sentiment value: %', p_sentiment;
    END IF;

    IF p_feedback_id IS NOT NULL THEN
        INSERT INTO public.feedback_sentiment_analysis (
            feedback_id, sentiment, confidence, model_provider, status, error_message, analyzed_at
        )
        VALUES (
            p_feedback_id, p_sentiment, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
        )
        ON CONFLICT (feedback_id) DO UPDATE SET
            sentiment = EXCLUDED.sentiment,
            confidence = EXCLUDED.confidence,
            model_provider = EXCLUDED.model_provider,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            analyzed_at = timezone('utc'::text, now())
        RETURNING * INTO v_res;
    ELSE
        INSERT INTO public.feedback_sentiment_analysis (
            issue_id, sentiment, confidence, model_provider, status, error_message, analyzed_at
        )
        VALUES (
            p_issue_id, p_sentiment, p_confidence, p_model_provider, p_status, p_error_message, timezone('utc'::text, now())
        )
        ON CONFLICT (issue_id) DO UPDATE SET
            sentiment = EXCLUDED.sentiment,
            confidence = EXCLUDED.confidence,
            model_provider = EXCLUDED.model_provider,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            analyzed_at = timezone('utc'::text, now())
        RETURNING * INTO v_res;
    END IF;

    RETURN to_jsonb(v_res);
END;
$$;

-- 4. Enable Row Level Security
ALTER TABLE public.feedback_sentiment_analysis ENABLE ROW LEVEL SECURITY;

-- 4.1 SELECT Policies
-- Faculty can view sentiment rows for class feedback in their sessions
DROP POLICY IF EXISTS sentiment_faculty_select_policy ON public.feedback_sentiment_analysis;
CREATE POLICY sentiment_faculty_select_policy ON public.feedback_sentiment_analysis
    FOR SELECT TO authenticated
    USING (
        (feedback_id IS NOT NULL AND public.is_faculty() AND public.is_faculty_for_feedback(feedback_id))
        OR (issue_id IS NOT NULL AND (public.is_hod() OR public.is_faculty()))
    );

-- 4.2 INSERT / UPDATE / DELETE Policies
DROP POLICY IF EXISTS sentiment_insert_policy ON public.feedback_sentiment_analysis;
CREATE POLICY sentiment_insert_policy ON public.feedback_sentiment_analysis
    FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS sentiment_update_policy ON public.feedback_sentiment_analysis;
CREATE POLICY sentiment_update_policy ON public.feedback_sentiment_analysis
    FOR UPDATE TO authenticated
    USING (true)
    WITH CHECK (true);

-- 5. Privileges & Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feedback_sentiment_analysis TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_feedback_sentiment TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_faculty_for_feedback TO authenticated;
