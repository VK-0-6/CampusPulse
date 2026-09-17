-- ==============================================================================
-- Phase 6.3 Migration: AI-Assisted Issue Groups for Department Issues
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Create issue_groups table
CREATE TABLE IF NOT EXISTS public.issue_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'closed')),
    issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Create issue_group_members table
CREATE TABLE IF NOT EXISTS public.issue_group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_group_id UUID NOT NULL REFERENCES public.issue_groups(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES public.department_issues(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT uq_group_member UNIQUE (issue_group_id, issue_id)
);

-- 3. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_groups_dept ON public.issue_groups(department_id);
CREATE INDEX IF NOT EXISTS idx_groups_cat ON public.issue_groups(category);
CREATE INDEX IF NOT EXISTS idx_groups_status ON public.issue_groups(status);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON public.issue_group_members(issue_group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_issue ON public.issue_group_members(issue_id);

-- 4. Constraint Enforcement: An issue can belong to only ONE active (status = 'open') group
CREATE OR REPLACE FUNCTION public.check_issue_single_active_group()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.issue_group_members igm
        JOIN public.issue_groups ig ON ig.id = igm.issue_group_id
        WHERE igm.issue_id = NEW.issue_id
          AND igm.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND ig.status = 'open'
    ) THEN
        RAISE EXCEPTION 'Issue % is already a member of an active issue group.', NEW.issue_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_issue_single_active_group ON public.issue_group_members;
CREATE TRIGGER trg_check_issue_single_active_group
BEFORE INSERT OR UPDATE ON public.issue_group_members
FOR EACH ROW
EXECUTE FUNCTION public.check_issue_single_active_group();

-- 5. Safe Issue Count Synchronization Trigger
CREATE OR REPLACE FUNCTION public.sync_issue_group_count()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE public.issue_groups
        SET issue_count = (
            SELECT COUNT(*) FROM public.issue_group_members WHERE issue_group_id = NEW.issue_group_id
        ),
        updated_at = timezone('utc'::text, now())
        WHERE id = NEW.issue_group_id;
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE public.issue_groups
        SET issue_count = (
            SELECT COUNT(*) FROM public.issue_group_members WHERE issue_group_id = OLD.issue_group_id
        ),
        updated_at = timezone('utc'::text, now())
        WHERE id = OLD.issue_group_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_issue_group_count ON public.issue_group_members;
CREATE TRIGGER trg_sync_issue_group_count
AFTER INSERT OR DELETE ON public.issue_group_members
FOR EACH ROW
EXECUTE FUNCTION public.sync_issue_group_count();

-- 6. Row Level Security
ALTER TABLE public.issue_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_group_members ENABLE ROW LEVEL SECURITY;

-- 6.1 Only HODs have SELECT permissions.
-- Students and ordinary faculty cannot inspect issue groups or member mappings.
DROP POLICY IF EXISTS issue_groups_hod_select_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_select_policy ON public.issue_groups
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

DROP POLICY IF EXISTS issue_group_members_hod_select_policy ON public.issue_group_members;
CREATE POLICY issue_group_members_hod_select_policy ON public.issue_group_members
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

GRANT SELECT ON TABLE public.issue_groups TO authenticated;
GRANT SELECT ON TABLE public.issue_group_members TO authenticated;

-- 7. Security Definer Helper RPCs
-- 7.1 Create Issue Group
CREATE OR REPLACE FUNCTION public.create_issue_group(
    p_department_id UUID,
    p_category TEXT,
    p_title TEXT,
    p_summary TEXT DEFAULT NULL,
    p_location TEXT DEFAULT NULL,
    p_initial_issue_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
BEGIN
    IF p_title IS NULL OR trim(p_title) = '' THEN
        RAISE EXCEPTION 'Issue group title is required.';
    END IF;

    IF p_category IS NULL OR trim(p_category) = '' THEN
        RAISE EXCEPTION 'Issue group category is required.';
    END IF;

    INSERT INTO public.issue_groups (
        department_id, category, title, summary, location, status, issue_count
    )
    VALUES (
        p_department_id, p_category, trim(p_title), trim(p_summary), trim(p_location), 'open', 0
    )
    RETURNING * INTO v_group;

    IF p_initial_issue_id IS NOT NULL THEN
        INSERT INTO public.issue_group_members (issue_group_id, issue_id)
        VALUES (v_group.id, p_initial_issue_id);

        SELECT * INTO v_group FROM public.issue_groups WHERE id = v_group.id;
    END IF;

    RETURN to_jsonb(v_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_issue_group TO authenticated, anon;

-- 7.2 Add Issue to Group
CREATE OR REPLACE FUNCTION public.add_issue_to_group(
    p_group_id UUID,
    p_issue_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
BEGIN
    IF p_group_id IS NULL OR p_issue_id IS NULL THEN
        RAISE EXCEPTION 'Both group_id and issue_id are required.';
    END IF;

    INSERT INTO public.issue_group_members (issue_group_id, issue_id)
    VALUES (p_group_id, p_issue_id)
    ON CONFLICT (issue_group_id, issue_id) DO NOTHING;

    SELECT * INTO v_group FROM public.issue_groups WHERE id = p_group_id;

    RETURN to_jsonb(v_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_issue_to_group TO authenticated, anon;

-- 7.3 Get Active Issue Group for Issue
CREATE OR REPLACE FUNCTION public.get_issue_group_for_issue(
    p_issue_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group RECORD;
BEGIN
    IF p_issue_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT ig.* INTO v_group
    FROM public.issue_groups ig
    JOIN public.issue_group_members igm ON igm.issue_group_id = ig.id
    WHERE igm.issue_id = p_issue_id
      AND ig.status = 'open'
    LIMIT 1;

    IF v_group.id IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN to_jsonb(v_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_issue_group_for_issue TO authenticated, anon;

-- 7.4 Backfill/Group real existing Wi-Fi reports into ONE group
CREATE OR REPLACE FUNCTION public.backfill_wifi_groups_test()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_issue_1 RECORD;
    v_issue_2 RECORD;
    v_existing_group RECORD;
    v_group_id UUID;
BEGIN
    -- Locate Report 1: "Wi-Fi keeps disconnecting during class."
    SELECT id, category, location, description, department_id INTO v_issue_1
    FROM public.department_issues
    WHERE description ILIKE '%disconnecting%' AND (category = 'wifi' OR description ILIKE '%wi-fi%')
    ORDER BY created_at DESC LIMIT 1;

    -- Locate Report 2: "The internet connection repeatedly drops while using the lab."
    SELECT id, category, location, description, department_id INTO v_issue_2
    FROM public.department_issues
    WHERE description ILIKE '%drops%' AND id <> v_issue_1.id AND (category = 'wifi' OR description ILIKE '%internet%')
    ORDER BY created_at DESC LIMIT 1;

    IF v_issue_1.id IS NULL OR v_issue_2.id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'One or both Wi-Fi reports could not be located in department_issues.'
        );
    END IF;

    -- Check if either issue already belongs to an open group
    SELECT ig.* INTO v_existing_group
    FROM public.issue_groups ig
    JOIN public.issue_group_members igm ON igm.issue_group_id = ig.id
    WHERE (igm.issue_id = v_issue_1.id OR igm.issue_id = v_issue_2.id)
      AND ig.status = 'open'
    LIMIT 1;

    IF v_existing_group.id IS NOT NULL THEN
        v_group_id := v_existing_group.id;
    ELSE
        INSERT INTO public.issue_groups (
            department_id, category, title, summary, location, status, issue_count
        )
        VALUES (
            v_issue_1.department_id,
            'wifi',
            'Lab Wi-Fi Connectivity Issue',
            'Multiple student reports indicate repeated Wi-Fi disconnections and dropped internet access in the lab.',
            COALESCE(v_issue_1.location, 'Lab'),
            'open',
            0
        )
        RETURNING id INTO v_group_id;
    END IF;

    -- Add Issue 1 to group
    INSERT INTO public.issue_group_members (issue_group_id, issue_id)
    VALUES (v_group_id, v_issue_1.id)
    ON CONFLICT (issue_group_id, issue_id) DO NOTHING;

    -- Add Issue 2 to group
    INSERT INTO public.issue_group_members (issue_group_id, issue_id)
    VALUES (v_group_id, v_issue_2.id)
    ON CONFLICT (issue_group_id, issue_id) DO NOTHING;

    SELECT ig.* INTO v_existing_group FROM public.issue_groups ig WHERE ig.id = v_group_id;

    RETURN jsonb_build_object(
        'success', true,
        'group_id', v_group_id,
        'group_title', v_existing_group.title,
        'issue_count', v_existing_group.issue_count,
        'issue_1_id', v_issue_1.id,
        'issue_2_id', v_issue_2.id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_wifi_groups_test TO authenticated, anon;
