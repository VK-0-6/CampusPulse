-- ==============================================================================
-- Phase 7 Migration: Priority & Early Warning Intelligence for Issue Groups
-- Deterministic, Explainable, Zero-AI Scoring Architecture
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create issue_group_priority table
CREATE TABLE IF NOT EXISTS public.issue_group_priority (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_group_id UUID NOT NULL UNIQUE REFERENCES public.issue_groups(id) ON DELETE CASCADE,
    priority_score NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    priority_level TEXT NOT NULL CHECK (priority_level IN ('Low', 'Medium', 'High')),
    severity_score NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    impact_score NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    recurrence_score NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    recency_score NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    max_severity TEXT,
    report_count INTEGER NOT NULL DEFAULT 0,
    days_since_latest NUMERIC(6, 2) DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Create issue_group_early_warning table
CREATE TABLE IF NOT EXISTS public.issue_group_early_warning (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_group_id UUID NOT NULL UNIQUE REFERENCES public.issue_groups(id) ON DELETE CASCADE,
    early_warning_score NUMERIC(5, 2),
    warning_level TEXT NOT NULL CHECK (warning_level IN ('Normal', 'Watch', 'Emerging', 'Alert', 'Insufficient Data')),
    has_sufficient_data BOOLEAN NOT NULL DEFAULT true,
    growth_score NUMERIC(5, 2) DEFAULT 0.00,
    recent_volume_score NUMERIC(5, 2) DEFAULT 0.00,
    recurrence_score NUMERIC(5, 2) DEFAULT 0.00,
    newness_score NUMERIC(5, 2) DEFAULT 0.00,
    recent_7_day_count INTEGER NOT NULL DEFAULT 0,
    previous_7_day_count INTEGER NOT NULL DEFAULT 0,
    growth_rate NUMERIC(6, 2) DEFAULT 0.00,
    group_age_days NUMERIC(6, 2) DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_priority_group ON public.issue_group_priority(issue_group_id);
CREATE INDEX IF NOT EXISTS idx_priority_level ON public.issue_group_priority(priority_level);
CREATE INDEX IF NOT EXISTS idx_priority_score ON public.issue_group_priority(priority_score DESC);

CREATE INDEX IF NOT EXISTS idx_warning_group ON public.issue_group_early_warning(issue_group_id);
CREATE INDEX IF NOT EXISTS idx_warning_level ON public.issue_group_early_warning(warning_level);
CREATE INDEX IF NOT EXISTS idx_warning_score ON public.issue_group_early_warning(early_warning_score DESC);

-- 4. Row Level Security
ALTER TABLE public.issue_group_priority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_group_early_warning ENABLE ROW LEVEL SECURITY;

-- 4.1 HOD-only SELECT access policies
DROP POLICY IF EXISTS priority_hod_select_policy ON public.issue_group_priority;
CREATE POLICY priority_hod_select_policy ON public.issue_group_priority
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

DROP POLICY IF EXISTS early_warning_hod_select_policy ON public.issue_group_early_warning;
CREATE POLICY early_warning_hod_select_policy ON public.issue_group_early_warning
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

GRANT SELECT ON TABLE public.issue_group_priority TO authenticated;
GRANT SELECT ON TABLE public.issue_group_early_warning TO authenticated;

-- 5. RPC: Calculate Group Priority
CREATE OR REPLACE FUNCTION public.calculate_group_priority(
    p_group_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_report_count INT := 0;
    v_latest_report TIMESTAMPTZ;
    v_max_severity TEXT := 'low';
    v_severity_score NUMERIC(5, 2) := 25.00;
    v_impact_score NUMERIC(5, 2) := 0.00;
    v_recurrence_score NUMERIC(5, 2) := 0.00;
    v_recency_score NUMERIC(5, 2) := 0.00;
    v_days_since_latest NUMERIC(6, 2) := 0.00;
    v_priority_score NUMERIC(5, 2) := 0.00;
    v_priority_level TEXT := 'Low';
    v_is_recurring BOOLEAN := false;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required for priority calculation.';
    END IF;

    -- Gather member reports and determine max severity & latest timestamp
    WITH group_reports AS (
        SELECT 
            di.id, 
            di.created_at,
            COALESCE(fs.severity, di.severity, 'low') AS rep_severity
        FROM public.issue_group_members igm
        JOIN public.department_issues di ON di.id = igm.issue_id
        LEFT JOIN public.feedback_severity fs ON fs.feedback_id = di.id
        WHERE igm.issue_group_id = p_group_id
    )
    SELECT
        COUNT(*),
        MAX(created_at),
        CASE 
            WHEN bool_or(LOWER(rep_severity) = 'high') THEN 'high'
            WHEN bool_or(LOWER(rep_severity) = 'medium') THEN 'medium'
            ELSE 'low'
        END
    INTO
        v_report_count,
        v_latest_report,
        v_max_severity
    FROM group_reports;

    IF v_report_count = 0 OR v_latest_report IS NULL THEN
        v_max_severity := 'low';
        v_severity_score := 0.00;
        v_impact_score := 0.00;
        v_recurrence_score := 0.00;
        v_recency_score := 0.00;
        v_priority_score := 0.00;
        v_priority_level := 'Low';
    ELSE
        -- 1. Severity Score (35%)
        IF v_max_severity = 'high' THEN
            v_severity_score := 100.00;
        ELSIF v_max_severity = 'medium' THEN
            v_severity_score := 60.00;
        ELSE
            v_severity_score := 25.00;
        END IF;

        -- 2. Report Impact Score (30%)
        IF v_report_count >= 20 THEN
            v_impact_score := 100.00;
        ELSIF v_report_count >= 10 THEN
            v_impact_score := 80.00;
        ELSIF v_report_count >= 5 THEN
            v_impact_score := 60.00;
        ELSIF v_report_count >= 3 THEN
            v_impact_score := 40.00;
        ELSE
            v_impact_score := 20.00;
        END IF;

        -- 3. Recurrence Score (20%)
        SELECT is_recurring INTO v_is_recurring
        FROM public.issue_group_recurrence
        WHERE issue_group_id = p_group_id;

        IF v_is_recurring = true THEN
            v_recurrence_score := 100.00;
        ELSE
            v_recurrence_score := 0.00;
        END IF;

        -- 4. Recency Score (15%)
        v_days_since_latest := ROUND(GREATEST(0.00, EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - v_latest_report)) / 86400.0), 2);

        IF v_days_since_latest <= 3.00 THEN
            v_recency_score := 100.00;
        ELSIF v_days_since_latest <= 7.00 THEN
            v_recency_score := 80.00;
        ELSIF v_days_since_latest <= 14.00 THEN
            v_recency_score := 60.00;
        ELSIF v_days_since_latest <= 30.00 THEN
            v_recency_score := 40.00;
        ELSE
            v_recency_score := 20.00;
        END IF;

        -- Weighted Priority calculation
        v_priority_score := ROUND(
            (v_severity_score * 0.35) +
            (v_impact_score * 0.30) +
            (v_recurrence_score * 0.20) +
            (v_recency_score * 0.15),
            2
        );

        -- Priority Level Mapping
        IF v_priority_score >= 70.00 THEN
            v_priority_level := 'High';
        ELSIF v_priority_score >= 40.00 THEN
            v_priority_level := 'Medium';
        ELSE
            v_priority_level := 'Low';
        END IF;
    END IF;

    -- Upsert into public.issue_group_priority
    INSERT INTO public.issue_group_priority (
        issue_group_id,
        priority_score,
        priority_level,
        severity_score,
        impact_score,
        recurrence_score,
        recency_score,
        max_severity,
        report_count,
        days_since_latest,
        status,
        error_message,
        calculated_at,
        updated_at
    )
    VALUES (
        p_group_id,
        v_priority_score,
        v_priority_level,
        v_severity_score,
        v_impact_score,
        v_recurrence_score,
        v_recency_score,
        v_max_severity,
        v_report_count,
        v_days_since_latest,
        'completed',
        NULL,
        timezone('utc'::text, now()),
        timezone('utc'::text, now())
    )
    ON CONFLICT (issue_group_id) DO UPDATE SET
        priority_score = EXCLUDED.priority_score,
        priority_level = EXCLUDED.priority_level,
        severity_score = EXCLUDED.severity_score,
        impact_score = EXCLUDED.impact_score,
        recurrence_score = EXCLUDED.recurrence_score,
        recency_score = EXCLUDED.recency_score,
        max_severity = EXCLUDED.max_severity,
        report_count = EXCLUDED.report_count,
        days_since_latest = EXCLUDED.days_since_latest,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        calculated_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_group_priority TO authenticated, anon;

-- 6. RPC: Calculate Group Early Warning
CREATE OR REPLACE FUNCTION public.calculate_group_early_warning(
    p_group_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_reports INT := 0;
    v_first_report TIMESTAMPTZ;
    v_latest_report TIMESTAMPTZ;
    v_group_age_days NUMERIC(6, 2) := 0.00;
    v_recent_count INT := 0;
    v_previous_count INT := 0;
    v_growth_rate NUMERIC(6, 2) := 0.00;
    v_has_sufficient_data BOOLEAN := true;
    v_growth_score NUMERIC(5, 2) := 0.00;
    v_recent_volume_score NUMERIC(5, 2) := 0.00;
    v_recurrence_score NUMERIC(5, 2) := 0.00;
    v_newness_score NUMERIC(5, 2) := 0.00;
    v_early_warning_score NUMERIC(5, 2) := NULL;
    v_warning_level TEXT := 'Normal';
    v_is_recurring BOOLEAN := false;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required for early warning calculation.';
    END IF;

    -- 1. Gather all reports, timestamps and group age
    WITH group_reports AS (
        SELECT di.id, di.created_at
        FROM public.issue_group_members igm
        JOIN public.department_issues di ON di.id = igm.issue_id
        WHERE igm.issue_group_id = p_group_id
    )
    SELECT
        COUNT(*),
        MIN(created_at),
        MAX(created_at),
        COUNT(*) FILTER (WHERE created_at >= timezone('utc'::text, now()) - INTERVAL '7 days'),
        COUNT(*) FILTER (WHERE created_at >= timezone('utc'::text, now()) - INTERVAL '14 days' 
                           AND created_at <  timezone('utc'::text, now()) - INTERVAL '7 days')
    INTO
        v_total_reports,
        v_first_report,
        v_latest_report,
        v_recent_count,
        v_previous_count
    FROM group_reports;

    IF v_total_reports > 0 AND v_first_report IS NOT NULL THEN
        v_group_age_days := ROUND(GREATEST(0.00, EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - v_first_report)) / 86400.0), 2);
    ELSE
        v_group_age_days := 0.00;
    END IF;

    -- 2. Minimum-Data Safeguards
    -- If total reports < 2 or group age < 2.00 days, historical comparison is insufficient
    IF v_total_reports < 2 OR v_group_age_days < 2.00 THEN
        v_has_sufficient_data := false;
        v_early_warning_score := NULL;
        v_warning_level := 'Insufficient Data';
        v_growth_score := 0.00;
        v_recent_volume_score := 0.00;
        v_recurrence_score := 0.00;
        v_newness_score := 0.00;
        v_growth_rate := 0.00;
    ELSE
        v_has_sufficient_data := true;

        -- 2.1 Growth Score (45%)
        IF v_previous_count > 0 THEN
            v_growth_rate := ROUND((v_recent_count::NUMERIC - v_previous_count::NUMERIC) / v_previous_count::NUMERIC, 2);
            IF v_growth_rate <= 0 THEN
                v_growth_score := 0.00;
            ELSIF v_growth_rate <= 0.50 THEN
                v_growth_score := 40.00;
            ELSIF v_growth_rate <= 1.00 THEN
                v_growth_score := 70.00;
            ELSE
                v_growth_score := 100.00;
            END IF;
        ELSE
            IF v_recent_count = 0 THEN
                v_growth_rate := 0.00;
                v_growth_score := 0.00;
            ELSIF v_recent_count = 1 THEN
                v_growth_rate := 1.00;
                v_growth_score := 40.00;
            ELSIF v_recent_count = 2 THEN
                v_growth_rate := 2.00;
                v_growth_score := 70.00;
            ELSE
                v_growth_rate := 3.00;
                v_growth_score := 100.00;
            END IF;
        END IF;

        -- 2.2 Recent Report Volume Score (25%)
        IF v_recent_count >= 5 THEN
            v_recent_volume_score := 100.00;
        ELSIF v_recent_count >= 3 THEN
            v_recent_volume_score := 75.00;
        ELSIF v_recent_count = 2 THEN
            v_recent_volume_score := 50.00;
        ELSIF v_recent_count = 1 THEN
            v_recent_volume_score := 25.00;
        ELSE
            v_recent_volume_score := 0.00;
        END IF;

        -- 2.3 Recurrence Score (20%)
        SELECT is_recurring INTO v_is_recurring
        FROM public.issue_group_recurrence
        WHERE issue_group_id = p_group_id;

        IF v_is_recurring = true THEN
            v_recurrence_score := 100.00;
        ELSE
            v_recurrence_score := 0.00;
        END IF;

        -- 2.4 Group Newness / Age Score (10%)
        IF v_group_age_days <= 3.00 THEN
            v_newness_score := 100.00;
        ELSIF v_group_age_days <= 7.00 THEN
            v_newness_score := 80.00;
        ELSIF v_group_age_days <= 14.00 THEN
            v_newness_score := 60.00;
        ELSIF v_group_age_days <= 30.00 THEN
            v_newness_score := 40.00;
        ELSE
            v_newness_score := 20.00;
        END IF;

        -- Weighted Early Warning calculation
        v_early_warning_score := ROUND(
            (v_growth_score * 0.45) +
            (v_recent_volume_score * 0.25) +
            (v_recurrence_score * 0.20) +
            (v_newness_score * 0.10),
            2
        );

        -- Early Warning Level Mapping
        IF v_early_warning_score >= 75.00 THEN
            v_warning_level := 'Alert';
        ELSIF v_early_warning_score >= 50.00 THEN
            v_warning_level := 'Emerging';
        ELSIF v_early_warning_score >= 30.00 THEN
            v_warning_level := 'Watch';
        ELSE
            v_warning_level := 'Normal';
        END IF;
    END IF;

    -- Upsert into public.issue_group_early_warning
    INSERT INTO public.issue_group_early_warning (
        issue_group_id,
        early_warning_score,
        warning_level,
        has_sufficient_data,
        growth_score,
        recent_volume_score,
        recurrence_score,
        newness_score,
        recent_7_day_count,
        previous_7_day_count,
        growth_rate,
        group_age_days,
        status,
        error_message,
        calculated_at,
        updated_at
    )
    VALUES (
        p_group_id,
        v_early_warning_score,
        v_warning_level,
        v_has_sufficient_data,
        v_growth_score,
        v_recent_volume_score,
        v_recurrence_score,
        v_newness_score,
        v_recent_count,
        v_previous_count,
        v_growth_rate,
        v_group_age_days,
        'completed',
        NULL,
        timezone('utc'::text, now()),
        timezone('utc'::text, now())
    )
    ON CONFLICT (issue_group_id) DO UPDATE SET
        early_warning_score = EXCLUDED.early_warning_score,
        warning_level = EXCLUDED.warning_level,
        has_sufficient_data = EXCLUDED.has_sufficient_data,
        growth_score = EXCLUDED.growth_score,
        recent_volume_score = EXCLUDED.recent_volume_score,
        recurrence_score = EXCLUDED.recurrence_score,
        newness_score = EXCLUDED.newness_score,
        recent_7_day_count = EXCLUDED.recent_7_day_count,
        previous_7_day_count = EXCLUDED.previous_7_day_count,
        growth_rate = EXCLUDED.growth_rate,
        group_age_days = EXCLUDED.group_age_days,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        calculated_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_group_early_warning TO authenticated, anon;

-- 7. Combined RPC: Calculate Group Analytics (Atomic Priority + Early Warning)
CREATE OR REPLACE FUNCTION public.calculate_group_analytics(
    p_group_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_p_res JSONB;
    v_w_res JSONB;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required.';
    END IF;

    v_p_res := public.calculate_group_priority(p_group_id);
    v_w_res := public.calculate_group_early_warning(p_group_id);

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'priority', v_p_res,
        'early_warning', v_w_res
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_group_analytics TO authenticated, anon;

-- 8. Backfill/Diagnostic RPC for Real Wi-Fi Issue Group
CREATE OR REPLACE FUNCTION public.backfill_wifi_priority_warning_test()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
    v_analytics JSONB;
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

    v_analytics := public.calculate_group_analytics(v_group.id);

    RETURN jsonb_build_object(
        'success', true,
        'group_id', v_group.id,
        'group_title', v_group.title,
        'analytics', v_analytics
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_wifi_priority_warning_test TO authenticated, anon;
