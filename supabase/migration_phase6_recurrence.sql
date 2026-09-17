-- ==============================================================================
-- Phase 6.4 Migration: Recurring Issue Detection for Issue Groups
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create issue_group_recurrence table
CREATE TABLE IF NOT EXISTS public.issue_group_recurrence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_group_id UUID NOT NULL UNIQUE REFERENCES public.issue_groups(id) ON DELETE CASCADE,
    is_recurring BOOLEAN NOT NULL DEFAULT false,
    report_count INTEGER NOT NULL DEFAULT 0,
    distinct_report_dates INTEGER NOT NULL DEFAULT 0,
    first_report_at TIMESTAMP WITH TIME ZONE,
    latest_report_at TIMESTAMP WITH TIME ZONE,
    time_span_days NUMERIC(6, 2) DEFAULT 0.00,
    recurrence_rate NUMERIC(6, 2) DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_recurrence_group ON public.issue_group_recurrence(issue_group_id);
CREATE INDEX IF NOT EXISTS idx_recurrence_is_recurring ON public.issue_group_recurrence(is_recurring);

-- 3. Row Level Security
ALTER TABLE public.issue_group_recurrence ENABLE ROW LEVEL SECURITY;

-- 3.1 Only HODs have SELECT permissions.
-- Students and ordinary faculty cannot inspect recurrence intelligence.
DROP POLICY IF EXISTS recurrence_hod_select_policy ON public.issue_group_recurrence;
CREATE POLICY recurrence_hod_select_policy ON public.issue_group_recurrence
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

GRANT SELECT ON TABLE public.issue_group_recurrence TO authenticated;

-- 4. Helper RPC: Calculate Group Recurrence (Deterministic data-driven logic)
CREATE OR REPLACE FUNCTION public.calculate_group_recurrence(
    p_group_id UUID,
    p_window_days INT DEFAULT 30,
    p_min_reports INT DEFAULT 3,
    p_min_dates INT DEFAULT 2
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_report_count INT := 0;
    v_distinct_dates INT := 0;
    v_first_report TIMESTAMPTZ;
    v_latest_report TIMESTAMPTZ;
    v_time_span NUMERIC(6, 2) := 0.00;
    v_recurrence_rate NUMERIC(6, 2) := 0.00;
    v_is_recurring BOOLEAN := false;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required for recurrence calculation.';
    END IF;

    -- Aggregate reports belonging strictly to this group
    WITH group_reports AS (
        SELECT di.id, di.created_at, date(timezone('utc', di.created_at)) AS report_date
        FROM public.issue_group_members igm
        JOIN public.department_issues di ON di.id = igm.issue_id
        WHERE igm.issue_group_id = p_group_id
    )
    SELECT
        COUNT(*),
        COUNT(DISTINCT report_date),
        MIN(created_at),
        MAX(created_at)
    INTO
        v_report_count,
        v_distinct_dates,
        v_first_report,
        v_latest_report
    FROM group_reports;

    IF v_report_count > 0 AND v_first_report IS NOT NULL AND v_latest_report IS NOT NULL THEN
        -- Calculate time span in days
        v_time_span := ROUND(EXTRACT(EPOCH FROM (v_latest_report - v_first_report)) / 86400.0, 2);

        -- Recurrence Rule:
        -- 1. At least p_min_reports (default 3)
        -- 2. At least p_min_dates (default 2) distinct calendar dates
        -- 3. Time span between first and latest report is within p_window_days (default 30)
        IF v_report_count >= p_min_reports
           AND v_distinct_dates >= p_min_dates
           AND v_time_span <= p_window_days THEN
            v_is_recurring := true;
        ELSE
            v_is_recurring := false;
        END IF;

        -- Recurrence rate (reports per week)
        IF v_time_span > 0 THEN
            v_recurrence_rate := ROUND((v_report_count::NUMERIC / (v_time_span / 7.0)), 2);
        ELSE
            v_recurrence_rate := v_report_count;
        END IF;
    ELSE
        v_is_recurring := false;
        v_report_count := 0;
        v_distinct_dates := 0;
        v_time_span := 0.00;
        v_recurrence_rate := 0.00;
    END IF;

    -- Upsert into issue_group_recurrence (idempotent, 1 record per group)
    INSERT INTO public.issue_group_recurrence (
        issue_group_id,
        is_recurring,
        report_count,
        distinct_report_dates,
        first_report_at,
        latest_report_at,
        time_span_days,
        recurrence_rate,
        status,
        error_message,
        calculated_at,
        updated_at
    )
    VALUES (
        p_group_id,
        v_is_recurring,
        v_report_count,
        v_distinct_dates,
        v_first_report,
        v_latest_report,
        v_time_span,
        v_recurrence_rate,
        'completed',
        NULL,
        timezone('utc'::text, now()),
        timezone('utc'::text, now())
    )
    ON CONFLICT (issue_group_id) DO UPDATE SET
        is_recurring = EXCLUDED.is_recurring,
        report_count = EXCLUDED.report_count,
        distinct_report_dates = EXCLUDED.distinct_report_dates,
        first_report_at = EXCLUDED.first_report_at,
        latest_report_at = EXCLUDED.latest_report_at,
        time_span_days = EXCLUDED.time_span_days,
        recurrence_rate = EXCLUDED.recurrence_rate,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        calculated_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_group_recurrence TO authenticated, anon;

-- 5. Helper RPC: Backfill/Evaluate recurrence for real Wi-Fi Issue Group
CREATE OR REPLACE FUNCTION public.backfill_wifi_recurrence_test()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
    v_result JSONB;
BEGIN
    SELECT id, title, category, issue_count INTO v_group
    FROM public.issue_groups
    WHERE category = 'wifi' OR title ILIKE '%wi-fi%'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_group.id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'No Wi-Fi issue group found in issue_groups.'
        );
    END IF;

    -- Calculate recurrence
    v_result := public.calculate_group_recurrence(v_group.id, 30, 3, 2);

    RETURN jsonb_build_object(
        'success', true,
        'group_id', v_group.id,
        'group_title', v_group.title,
        'recurrence', v_result
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_wifi_recurrence_test TO authenticated, anon;
