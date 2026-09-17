-- ==============================================================================
-- Phase 4 Migration: Faculty Improvement System
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Add session_type and parent_session_id to class_feedback_sessions
ALTER TABLE public.class_feedback_sessions 
ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'initial' 
CHECK (session_type IN ('initial', 'follow_up'));

ALTER TABLE public.class_feedback_sessions 
ADD COLUMN IF NOT EXISTS parent_session_id UUID 
REFERENCES public.class_feedback_sessions(id) ON DELETE SET NULL;

-- 2. Create improvement_actions table
CREATE TABLE IF NOT EXISTS public.improvement_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_session_id UUID NOT NULL REFERENCES public.class_feedback_sessions(id) ON DELETE CASCADE,
    faculty_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    improvement_area TEXT NOT NULL CHECK (improvement_area IN (
        'understanding', 
        'teaching_clarity', 
        'pace', 
        'difficulty', 
        'doubt_resolution', 
        'student_suggestions', 
        'other'
    )),
    problem_description TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN (
        'additional_explanation', 
        'extra_examples', 
        'practice_questions', 
        'study_material', 
        'revision_session', 
        'doubt_clearing_session', 
        'other'
    )),
    action_description TEXT NOT NULL,
    action_date DATE DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed')),
    follow_up_session_id UUID REFERENCES public.class_feedback_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Indexes on improvement_actions
CREATE INDEX IF NOT EXISTS idx_improvement_actions_session ON public.improvement_actions(feedback_session_id);
CREATE INDEX IF NOT EXISTS idx_improvement_actions_faculty ON public.improvement_actions(faculty_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_action_followup 
ON public.improvement_actions(follow_up_session_id) 
WHERE follow_up_session_id IS NOT NULL;

-- 4. Row Level Security Policies for improvement_actions
ALTER TABLE public.improvement_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS improvement_actions_select_policy ON public.improvement_actions;
CREATE POLICY improvement_actions_select_policy ON public.improvement_actions 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR (
            status = 'completed' 
            AND public.is_student() 
            AND public.is_student_enrolled_in_session(feedback_session_id)
        )
    );

DROP POLICY IF EXISTS improvement_actions_insert_policy ON public.improvement_actions;
CREATE POLICY improvement_actions_insert_policy ON public.improvement_actions 
    FOR INSERT TO authenticated 
    WITH CHECK (
        faculty_id = auth.uid() 
        AND public.is_faculty() 
        AND public.is_session_faculty(feedback_session_id)
    );

DROP POLICY IF EXISTS improvement_actions_update_policy ON public.improvement_actions;
CREATE POLICY improvement_actions_update_policy ON public.improvement_actions 
    FOR UPDATE TO authenticated 
    USING (faculty_id = auth.uid() AND public.is_faculty())
    WITH CHECK (faculty_id = auth.uid() AND public.is_faculty());

DROP POLICY IF EXISTS improvement_actions_delete_policy ON public.improvement_actions;
CREATE POLICY improvement_actions_delete_policy ON public.improvement_actions 
    FOR DELETE TO authenticated 
    USING (faculty_id = auth.uid() AND public.is_faculty());

-- 5. Privileges & Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.improvement_actions TO authenticated;
