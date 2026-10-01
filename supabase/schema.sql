-- ==============================================================================
-- Student Feedback & Community Improvement System
-- Complete Database Schema & Migration (Phase 1 & Phase 2)
-- Corrected Migration Order, Safe Deduplication, & Single Active Class Rule
-- ==============================================================================

-- ==============================================================================
-- 1. TABLE DEFINITIONS (All tables created FIRST to prevent 42P01 errors)
-- ==============================================================================

-- 1.1 Profiles Table (Phase 1 Foundation)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'hod')),
    roll_number TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Ensure roll_number column exists if table already existed without it
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS roll_number TEXT;

-- 1.2 Departments Table
CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 1.3 Semesters Table
CREATE TABLE IF NOT EXISTS public.semesters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    semester_number INTEGER NOT NULL CHECK (semester_number >= 1 AND semester_number <= 8),
    academic_year TEXT NOT NULL DEFAULT '2025-2026',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT uq_semester_year UNIQUE (semester_number, academic_year)
);

-- 1.4 Subjects Table (department_id is optional to allow dynamic subject addition by faculty)
CREATE TABLE IF NOT EXISTS public.subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    semester_id UUID NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Ensure department_id is nullable if table already existed with NOT NULL
ALTER TABLE public.subjects ALTER COLUMN department_id DROP NOT NULL;

-- Drop legacy compound constraint if present so it does not conflict with code+semester index
ALTER TABLE public.subjects DROP CONSTRAINT IF EXISTS uq_subject_dept_sem;

-- 1.5 Classes Table
CREATE TABLE IF NOT EXISTS public.classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    faculty_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    class_code VARCHAR(6) NOT NULL UNIQUE CHECK (length(class_code) = 6),
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 1.6 Class Members Table
CREATE TABLE IF NOT EXISTS public.class_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT uq_class_student UNIQUE (class_id, student_id)
);

-- 1.7 Class Feedback Sessions Table (Phase 3)
CREATE TABLE IF NOT EXISTS public.class_feedback_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    faculty_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    unit TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    closed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 1.8 Class Feedback Table (Phase 3)
CREATE TABLE IF NOT EXISTS public.class_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.class_feedback_sessions(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    understanding_rating INTEGER NOT NULL CHECK (understanding_rating >= 1 AND understanding_rating <= 5),
    teaching_clarity_rating INTEGER NOT NULL CHECK (teaching_clarity_rating >= 1 AND teaching_clarity_rating <= 5),
    pace TEXT NOT NULL CHECK (pace IN ('too_slow', 'good', 'too_fast')),
    difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'moderate', 'difficult')),
    doubts_addressed TEXT NOT NULL CHECK (doubts_addressed IN ('yes', 'partly', 'no')),
    comment TEXT,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT uq_session_student UNIQUE (session_id, student_id)
);

-- 1.9 Department Issues Table (Academic Environment Feedback - Phase 3)
CREATE TABLE IF NOT EXISTS public.department_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('projector', 'wifi', 'lab_computer', 'lab_equipment', 'classroom_furniture', 'electrical', 'classroom_condition', 'other')),
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
    is_anonymous BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Phase 4 Extensions to class_feedback_sessions
ALTER TABLE public.class_feedback_sessions 
ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'initial' 
CHECK (session_type IN ('initial', 'follow_up'));

ALTER TABLE public.class_feedback_sessions 
ADD COLUMN IF NOT EXISTS parent_session_id UUID 
REFERENCES public.class_feedback_sessions(id) ON DELETE SET NULL;

-- 1.10 Improvement Actions Table (Phase 4 - Faculty Improvement System)
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

-- ==============================================================================
-- 2. SAFE DEDUPLICATION & CANONICAL DATA MIGRATION
-- (Executed BEFORE creating unique indexes to avoid duplicate key errors)
-- ==============================================================================

-- 2.1 Ensure canonical Semesters 1 through 8 exist for '2025-2026'
INSERT INTO public.semesters (semester_number, academic_year) VALUES
    (1, '2025-2026'),
    (2, '2025-2026'),
    (3, '2025-2026'),
    (4, '2025-2026'),
    (5, '2025-2026'),
    (6, '2025-2026'),
    (7, '2025-2026'),
    (8, '2025-2026')
ON CONFLICT (semester_number, academic_year) DO NOTHING;

-- 2.2 Re-link subjects and classes from duplicate/variant semesters to canonical semesters safely
DO $$
DECLARE
    dup_sem RECORD;
    canon_sem_id UUID;
    dup_sub RECORD;
    canon_sub_id UUID;
BEGIN
    FOR dup_sem IN 
        SELECT id, semester_number 
        FROM public.semesters 
        WHERE academic_year <> '2025-2026'
    LOOP
        SELECT id INTO canon_sem_id 
        FROM public.semesters 
        WHERE semester_number = dup_sem.semester_number AND academic_year = '2025-2026' 
        LIMIT 1;

        IF canon_sem_id IS NOT NULL THEN
            FOR dup_sub IN 
                SELECT id, code, name 
                FROM public.subjects 
                WHERE semester_id = dup_sem.id
            LOOP
                SELECT id INTO canon_sub_id 
                FROM public.subjects 
                WHERE semester_id = canon_sem_id 
                  AND UPPER(code) = UPPER(dup_sub.code)
                LIMIT 1;

                IF canon_sub_id IS NOT NULL THEN
                    -- Canonical subject already exists: re-point any classes referencing the duplicate subject
                    UPDATE public.classes 
                    SET subject_id = canon_sub_id 
                    WHERE subject_id = dup_sub.id;

                    -- Safe to delete the redundant duplicate subject record
                    DELETE FROM public.subjects WHERE id = dup_sub.id;
                ELSE
                    -- Subject does not yet exist in canonical semester: simply move it over
                    UPDATE public.subjects 
                    SET semester_id = canon_sem_id 
                    WHERE id = dup_sub.id;
                END IF;
            END LOOP;

            -- Safe to remove the duplicate semester
            DELETE FROM public.semesters WHERE id = dup_sem.id;
        END IF;
    END LOOP;
END $$;

-- 2.3 Intra-semester deduplication safeguard:
-- Resolves any pre-existing duplicate subjects within the same semester before creating the unique index
DO $$
DECLARE
    dup_group RECORD;
    keeper_id UUID;
    discard_id UUID;
BEGIN
    FOR dup_group IN
        SELECT UPPER(code) AS norm_code, semester_id
        FROM public.subjects
        GROUP BY UPPER(code), semester_id
        HAVING COUNT(*) > 1
    LOOP
        SELECT id INTO keeper_id
        FROM public.subjects
        WHERE UPPER(code) = dup_group.norm_code AND semester_id = dup_group.semester_id
        ORDER BY created_at ASC
        LIMIT 1;

        FOR discard_id IN
            SELECT id
            FROM public.subjects
            WHERE UPPER(code) = dup_group.norm_code 
              AND semester_id = dup_group.semester_id 
              AND id <> keeper_id
        LOOP
            UPDATE public.classes SET subject_id = keeper_id WHERE subject_id = discard_id;
            DELETE FROM public.subjects WHERE id = discard_id;
        END LOOP;
    END LOOP;
END $$;

-- 2.4 Active Classes Deduplication Safeguard:
-- If multiple active classes exist for the same (faculty_id, subject_id) (e.g. B2X53C and L786WF),
-- resolve them safely by setting is_active = false on duplicate classes, prioritizing the class
-- with enrolled students (e.g. L786WF). Zero classes or student enrollments are deleted.
DO $$
DECLARE
    dup_active RECORD;
    keeper_class_id UUID;
    other_class_id UUID;
BEGIN
    FOR dup_active IN
        SELECT faculty_id, subject_id
        FROM public.classes
        WHERE is_active = true
        GROUP BY faculty_id, subject_id
        HAVING COUNT(*) > 1
    LOOP
        -- Find the class to keep active:
        -- Prioritize the class with the most enrolled students, then latest created
        SELECT c.id INTO keeper_class_id
        FROM public.classes c
        LEFT JOIN public.class_members cm ON cm.class_id = c.id
        WHERE c.faculty_id = dup_active.faculty_id 
          AND c.subject_id = dup_active.subject_id 
          AND c.is_active = true
        GROUP BY c.id, c.created_at
        ORDER BY COUNT(cm.id) DESC, c.created_at DESC
        LIMIT 1;

        -- Deactivate all other duplicate active classes for this (faculty, subject) WITHOUT deleting them
        FOR other_class_id IN
            SELECT id
            FROM public.classes
            WHERE faculty_id = dup_active.faculty_id 
              AND subject_id = dup_active.subject_id 
              AND is_active = true
              AND id <> keeper_class_id
        LOOP
            UPDATE public.classes 
            SET is_active = false 
            WHERE id = other_class_id;
        END LOOP;
    END LOOP;
END $$;

-- ==============================================================================
-- 3. INDEXES & UNIQUE CONSTRAINTS
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_classes_faculty_id ON public.classes(faculty_id);
CREATE INDEX IF NOT EXISTS idx_classes_class_code ON public.classes(class_code);
CREATE INDEX IF NOT EXISTS idx_class_members_student ON public.class_members(student_id);
CREATE INDEX IF NOT EXISTS idx_class_members_class ON public.class_members(class_id);
CREATE INDEX IF NOT EXISTS idx_subjects_semester ON public.subjects(semester_id);
CREATE INDEX IF NOT EXISTS idx_subjects_department ON public.subjects(department_id);

-- Enforce unique roll numbers for students (case-insensitive, ignoring nulls for faculty/hod/unmigrated users)
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_profiles_roll_number 
ON public.profiles (UPPER(TRIM(roll_number))) 
WHERE roll_number IS NOT NULL AND roll_number <> '';

-- Enforce unique subject codes per semester (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_subject_code_semester 
ON public.subjects (UPPER(code), semester_id);

-- Enforce strictly ONE active class per faculty for the same subject at database level
-- (Deactivated classes do not conflict, allowing subsequent re-creation for a new session)
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_classes_active_faculty_subject 
ON public.classes (faculty_id, subject_id) 
WHERE is_active = true;

-- Phase 3 Indexes
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_class ON public.class_feedback_sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_faculty ON public.class_feedback_sessions(faculty_id);
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_status ON public.class_feedback_sessions(status);

CREATE INDEX IF NOT EXISTS idx_class_feedback_session ON public.class_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_class_feedback_student ON public.class_feedback(student_id);

CREATE INDEX IF NOT EXISTS idx_dept_issues_student ON public.department_issues(student_id);
CREATE INDEX IF NOT EXISTS idx_dept_issues_department ON public.department_issues(department_id);
CREATE INDEX IF NOT EXISTS idx_dept_issues_status ON public.department_issues(status);

-- Phase 4 Indexes
CREATE INDEX IF NOT EXISTS idx_feedback_sessions_parent ON public.class_feedback_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_improvement_actions_session ON public.improvement_actions(feedback_session_id);
CREATE INDEX IF NOT EXISTS idx_improvement_actions_faculty ON public.improvement_actions(faculty_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_action_followup 
ON public.improvement_actions(follow_up_session_id) 
WHERE follow_up_session_id IS NOT NULL;

-- ==============================================================================
-- 4. HELPER FUNCTIONS (SECURITY DEFINER to avoid RLS recursion)
-- ==============================================================================

-- 4.1 Check if current user has faculty role
CREATE OR REPLACE FUNCTION public.is_faculty()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'faculty'
    );
$$;

-- 4.2 Check if current user has student role
CREATE OR REPLACE FUNCTION public.is_student()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'student'
    );
$$;

-- 4.3 Check if current user created a specific class
CREATE OR REPLACE FUNCTION public.is_class_faculty(p_class_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.classes
        WHERE id = p_class_id AND faculty_id = auth.uid()
    );
$$;

-- 4.4 Check if a class is active
CREATE OR REPLACE FUNCTION public.is_class_active(p_class_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.classes
        WHERE id = p_class_id AND is_active = true
    );
$$;

-- 4.5 Check if current student is enrolled in a specific class
CREATE OR REPLACE FUNCTION public.is_student_enrolled(p_class_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.class_members
        WHERE class_id = p_class_id AND student_id = auth.uid()
    );
$$;

-- 4.6 Secure RPC function for class code lookup
CREATE OR REPLACE FUNCTION public.find_class_by_code(p_code TEXT)
RETURNS TABLE (
    id UUID,
    class_code VARCHAR(6),
    is_active BOOLEAN,
    subject_name TEXT,
    subject_code TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT 
        c.id,
        c.class_code,
        c.is_active,
        s.name AS subject_name,
        s.code AS subject_code
    FROM public.classes c
    JOIN public.subjects s ON s.id = c.subject_id
    WHERE c.class_code = UPPER(TRIM(p_code))
    LIMIT 1;
$$;

-- 4.7 Check if a feedback session is active
CREATE OR REPLACE FUNCTION public.is_session_active(p_session_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.class_feedback_sessions
        WHERE id = p_session_id AND status = 'active'
    );
$$;

-- 4.8 Check if student is enrolled in the class of a feedback session
CREATE OR REPLACE FUNCTION public.is_student_enrolled_in_session(p_session_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.class_feedback_sessions s
        JOIN public.class_members cm ON cm.class_id = s.class_id
        WHERE s.id = p_session_id AND cm.student_id = auth.uid()
    );
$$;

-- 4.9 Check if user is the faculty of a feedback session
CREATE OR REPLACE FUNCTION public.is_session_faculty(p_session_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.class_feedback_sessions
        WHERE id = p_session_id AND faculty_id = auth.uid()
    );
$$;

-- 4.10 Safe RPC function to check roll number existence for unauthenticated sign-up
CREATE OR REPLACE FUNCTION public.check_roll_number_exists(p_roll_number TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE UPPER(TRIM(roll_number)) = UPPER(TRIM(p_roll_number))
    );
$$;


-- ==============================================================================
-- 5. ROW LEVEL SECURITY POLICIES
-- ==============================================================================

-- 5.1 Profiles Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy" ON public.profiles 
    FOR SELECT TO authenticated 
    USING (
        auth.uid() = id 
        OR role IN ('faculty', 'hod')
        OR EXISTS (
            SELECT 1 FROM public.class_members cm
            JOIN public.classes c ON c.id = cm.class_id
            WHERE cm.student_id = public.profiles.id AND c.faculty_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
CREATE POLICY "profiles_insert_policy" ON public.profiles 
    FOR INSERT TO authenticated 
    WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;
CREATE POLICY "profiles_update_policy" ON public.profiles 
    FOR UPDATE TO authenticated 
    USING (auth.uid() = id);

-- 5.2 Departments Policies
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view departments" ON public.departments;
DROP POLICY IF EXISTS "departments_select_policy" ON public.departments;
CREATE POLICY "departments_select_policy" ON public.departments 
    FOR SELECT TO authenticated, anon USING (true);

-- 5.3 Semesters Policies
ALTER TABLE public.semesters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view semesters" ON public.semesters;
DROP POLICY IF EXISTS "semesters_select_policy" ON public.semesters;
CREATE POLICY "semesters_select_policy" ON public.semesters 
    FOR SELECT TO authenticated USING (true);

-- 5.4 Subjects Policies (Allowing faculty to create subjects)
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view subjects" ON public.subjects;
DROP POLICY IF EXISTS "subjects_select_policy" ON public.subjects;
CREATE POLICY "subjects_select_policy" ON public.subjects 
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "subjects_insert_policy" ON public.subjects;
CREATE POLICY "subjects_insert_policy" ON public.subjects 
    FOR INSERT TO authenticated 
    WITH CHECK (public.is_faculty());

-- 5.5 Classes Policies
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view relevant classes" ON public.classes;
DROP POLICY IF EXISTS "classes_select_policy" ON public.classes;
CREATE POLICY "classes_select_policy" ON public.classes 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR is_active = true 
        OR public.is_student_enrolled(id)
    );

DROP POLICY IF EXISTS "Faculty can create classes" ON public.classes;
DROP POLICY IF EXISTS "classes_insert_policy" ON public.classes;
CREATE POLICY "classes_insert_policy" ON public.classes 
    FOR INSERT TO authenticated 
    WITH CHECK (
        auth.uid() = faculty_id 
        AND public.is_faculty()
    );

DROP POLICY IF EXISTS "Faculty can update own classes" ON public.classes;
DROP POLICY IF EXISTS "classes_update_policy" ON public.classes;
CREATE POLICY "classes_update_policy" ON public.classes 
    FOR UPDATE TO authenticated 
    USING (auth.uid() = faculty_id)
    WITH CHECK (auth.uid() = faculty_id);

DROP POLICY IF EXISTS "Faculty can delete own classes" ON public.classes;
DROP POLICY IF EXISTS "classes_delete_policy" ON public.classes;
CREATE POLICY "classes_delete_policy" ON public.classes 
    FOR DELETE TO authenticated 
    USING (auth.uid() = faculty_id);

-- 5.6 Class Members Policies
ALTER TABLE public.class_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view policy" ON public.class_members;
DROP POLICY IF EXISTS "class_members_select_policy" ON public.class_members;
CREATE POLICY "class_members_select_policy" ON public.class_members 
    FOR SELECT TO authenticated 
    USING (
        student_id = auth.uid() 
        OR public.is_class_faculty(class_id)
    );

DROP POLICY IF EXISTS "Students can join classes" ON public.class_members;
DROP POLICY IF EXISTS "class_members_insert_policy" ON public.class_members;
CREATE POLICY "class_members_insert_policy" ON public.class_members 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student() 
        AND public.is_class_active(class_id)
    );

DROP POLICY IF EXISTS "Students can leave classes" ON public.class_members;
DROP POLICY IF EXISTS "class_members_delete_policy" ON public.class_members;
CREATE POLICY "class_members_delete_policy" ON public.class_members 
    FOR DELETE TO authenticated 
    USING (student_id = auth.uid());

-- 5.7 Class Feedback Sessions Policies (Phase 3)
ALTER TABLE public.class_feedback_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "class_feedback_sessions_select_policy" ON public.class_feedback_sessions;
CREATE POLICY "class_feedback_sessions_select_policy" ON public.class_feedback_sessions 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR public.is_student_enrolled(class_id)
    );

DROP POLICY IF EXISTS "class_feedback_sessions_insert_policy" ON public.class_feedback_sessions;
CREATE POLICY "class_feedback_sessions_insert_policy" ON public.class_feedback_sessions 
    FOR INSERT TO authenticated 
    WITH CHECK (
        faculty_id = auth.uid() 
        AND public.is_faculty() 
        AND public.is_class_faculty(class_id)
    );

DROP POLICY IF EXISTS "class_feedback_sessions_update_policy" ON public.class_feedback_sessions;
CREATE POLICY "class_feedback_sessions_update_policy" ON public.class_feedback_sessions 
    FOR UPDATE TO authenticated 
    USING (faculty_id = auth.uid())
    WITH CHECK (faculty_id = auth.uid());

DROP POLICY IF EXISTS "class_feedback_sessions_delete_policy" ON public.class_feedback_sessions;
CREATE POLICY "class_feedback_sessions_delete_policy" ON public.class_feedback_sessions 
    FOR DELETE TO authenticated 
    USING (faculty_id = auth.uid());

-- 5.8 Class Feedback Policies (Phase 3)
ALTER TABLE public.class_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "class_feedback_select_policy" ON public.class_feedback;
CREATE POLICY "class_feedback_select_policy" ON public.class_feedback 
    FOR SELECT TO authenticated 
    USING (
        student_id = auth.uid() 
        OR public.is_session_faculty(session_id)
    );

DROP POLICY IF EXISTS "class_feedback_insert_policy" ON public.class_feedback;
CREATE POLICY "class_feedback_insert_policy" ON public.class_feedback 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student() 
        AND public.is_session_active(session_id) 
        AND public.is_student_enrolled_in_session(session_id)
    );

-- 5.9 Department Issues Policies (Phase 3)
ALTER TABLE public.department_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "department_issues_select_policy" ON public.department_issues;
CREATE POLICY "department_issues_select_policy" ON public.department_issues 
    FOR SELECT TO authenticated 
    USING (
        student_id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

DROP POLICY IF EXISTS "department_issues_insert_policy" ON public.department_issues;
CREATE POLICY "department_issues_insert_policy" ON public.department_issues 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student()
    );

DROP POLICY IF EXISTS "department_issues_update_policy" ON public.department_issues;
CREATE POLICY "department_issues_update_policy" ON public.department_issues 
    FOR UPDATE TO authenticated 
    USING (
        student_id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'hod'
        )
    );

-- 5.10 Improvement Actions Policies (Phase 4)
ALTER TABLE public.improvement_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "improvement_actions_select_policy" ON public.improvement_actions;
CREATE POLICY "improvement_actions_select_policy" ON public.improvement_actions 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR (
            status = 'completed' 
            AND public.is_student() 
            AND public.is_student_enrolled_in_session(feedback_session_id)
        )
    );

DROP POLICY IF EXISTS "improvement_actions_insert_policy" ON public.improvement_actions;
CREATE POLICY "improvement_actions_insert_policy" ON public.improvement_actions 
    FOR INSERT TO authenticated 
    WITH CHECK (
        faculty_id = auth.uid() 
        AND public.is_faculty() 
        AND public.is_session_faculty(feedback_session_id)
    );

DROP POLICY IF EXISTS "improvement_actions_update_policy" ON public.improvement_actions;
CREATE POLICY "improvement_actions_update_policy" ON public.improvement_actions 
    FOR UPDATE TO authenticated 
    USING (faculty_id = auth.uid() AND public.is_faculty())
    WITH CHECK (faculty_id = auth.uid() AND public.is_faculty());

DROP POLICY IF EXISTS "improvement_actions_delete_policy" ON public.improvement_actions;
CREATE POLICY "improvement_actions_delete_policy" ON public.improvement_actions 
    FOR DELETE TO authenticated 
    USING (faculty_id = auth.uid() AND public.is_faculty());

-- ==============================================================================
-- 6. TABLE & FUNCTION PRIVILEGES (GRANT to authenticated role)
-- ==============================================================================
GRANT USAGE ON SCHEMA public TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.departments TO authenticated, anon;
GRANT SELECT ON TABLE public.semesters TO authenticated;
GRANT SELECT, INSERT ON TABLE public.subjects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.classes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.class_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.class_feedback_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.class_feedback TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.department_issues TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.improvement_actions TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

GRANT EXECUTE ON FUNCTION public.is_faculty() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_student() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_class_faculty(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_class_active(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_student_enrolled(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_class_by_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_session_active(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_student_enrolled_in_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_session_faculty(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_roll_number_exists(TEXT) TO anon, authenticated;

-- ==============================================================================
-- 7. AUTHENTICATION TRIGGER (Phase 1)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, email, role, roll_number)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Anonymous User'),
        COALESCE(NEW.email, ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'student'),
        NULLIF(UPPER(TRIM(NEW.raw_user_meta_data->>'roll_number')), '')
    )
    ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        roll_number = COALESCE(EXCLUDED.roll_number, public.profiles.roll_number);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ==============================================================================
-- 8. INITIAL SEED DATA (Idempotent)
-- ==============================================================================

-- 8.1 Seed Departments
INSERT INTO public.departments (name) VALUES 
    ('Computer Science'),
    ('Information Technology'),
    ('Electronics & Communication')
ON CONFLICT (name) DO NOTHING;

-- 8.2 Seed Initial Subjects for Computer Science (Idempotent)
DO $$
DECLARE
    cs_dept_id UUID;
    sem3_id UUID;
    sem4_id UUID;
    sem5_id UUID;
BEGIN
    SELECT id INTO cs_dept_id FROM public.departments WHERE name = 'Computer Science' LIMIT 1;
    SELECT id INTO sem3_id FROM public.semesters WHERE semester_number = 3 AND academic_year = '2025-2026' LIMIT 1;
    SELECT id INTO sem4_id FROM public.semesters WHERE semester_number = 4 AND academic_year = '2025-2026' LIMIT 1;
    SELECT id INTO sem5_id FROM public.semesters WHERE semester_number = 5 AND academic_year = '2025-2026' LIMIT 1;

    IF sem4_id IS NOT NULL THEN
        INSERT INTO public.subjects (name, code, department_id, semester_id) VALUES
            ('Data Mining', 'CS401', cs_dept_id, sem4_id),
            ('Operating Systems', 'CS402', cs_dept_id, sem4_id),
            ('Java Programming', 'CS403', cs_dept_id, sem4_id),
            ('Database Management Systems', 'CS404', cs_dept_id, sem4_id)
        ON CONFLICT (UPPER(code), semester_id) DO NOTHING;
    END IF;

    IF sem3_id IS NOT NULL THEN
        INSERT INTO public.subjects (name, code, department_id, semester_id) VALUES
            ('Data Structures & Algorithms', 'CS301', cs_dept_id, sem3_id),
            ('Discrete Mathematics', 'CS302', cs_dept_id, sem3_id),
            ('Digital Logic Design', 'CS303', cs_dept_id, sem3_id)
        ON CONFLICT (UPPER(code), semester_id) DO NOTHING;
    END IF;

    IF sem5_id IS NOT NULL THEN
        INSERT INTO public.subjects (name, code, department_id, semester_id) VALUES
            ('Computer Networks', 'CS501', cs_dept_id, sem5_id),
            ('Software Engineering', 'CS502', cs_dept_id, sem5_id),
            ('Web Technologies', 'CS503', cs_dept_id, sem5_id)
        ON CONFLICT (UPPER(code), semester_id) DO NOTHING;
    END IF;
END $$;

-- ==============================================================================
-- 1.11 Feedback Sentiment Analysis Table (Phase 5 - AI Feedback Analysis)
-- ==============================================================================
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

CREATE INDEX IF NOT EXISTS idx_sentiment_feedback ON public.feedback_sentiment_analysis(feedback_id);
CREATE INDEX IF NOT EXISTS idx_sentiment_issue ON public.feedback_sentiment_analysis(issue_id);

ALTER TABLE public.feedback_sentiment_analysis ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 1.12 Feedback Classification Table (Phase 5 - AI Feedback Classification)
-- ==============================================================================
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

CREATE INDEX IF NOT EXISTS idx_classification_feedback ON public.feedback_classification(feedback_id);
CREATE INDEX IF NOT EXISTS idx_classification_issue ON public.feedback_classification(issue_id);

ALTER TABLE public.feedback_classification ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 1.13 Feedback Severity Table (Phase 5 - AI Severity Prediction)
-- ==============================================================================
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

CREATE INDEX IF NOT EXISTS idx_severity_feedback ON public.feedback_severity(feedback_id);
CREATE INDEX IF NOT EXISTS idx_severity_issue ON public.feedback_severity(issue_id);

ALTER TABLE public.feedback_severity ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 1.14 Issue Similarity Analysis Table (Phase 6.1 - AI Similarity Detection)
-- ==============================================================================
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

CREATE INDEX IF NOT EXISTS idx_similarity_issue_a ON public.issue_similarity_analysis(issue_id_a);
CREATE INDEX IF NOT EXISTS idx_similarity_issue_b ON public.issue_similarity_analysis(issue_id_b);
CREATE INDEX IF NOT EXISTS idx_similarity_rel ON public.issue_similarity_analysis(relationship);

ALTER TABLE public.issue_similarity_analysis ENABLE ROW LEVEL SECURITY;

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

-- Phase 6.2: Issue Relationship Analysis (Duplicate vs Related)
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

CREATE INDEX IF NOT EXISTS idx_rel_issue_a ON public.issue_relationship_analysis(issue_id_a);
CREATE INDEX IF NOT EXISTS idx_rel_issue_b ON public.issue_relationship_analysis(issue_id_b);
CREATE INDEX IF NOT EXISTS idx_rel_type ON public.issue_relationship_analysis(relationship);
CREATE INDEX IF NOT EXISTS idx_rel_sim_id ON public.issue_relationship_analysis(similarity_analysis_id);

ALTER TABLE public.issue_relationship_analysis ENABLE ROW LEVEL SECURITY;

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

    IF p_issue_id_1 < p_issue_id_2 THEN
        v_id_a := p_issue_id_1;
        v_id_b := p_issue_id_2;
    ELSE
        v_id_a := p_issue_id_2;
        v_id_b := p_issue_id_1;
    END IF;

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

-- Phase 6.3: Issue Groups and Group Members
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

CREATE TABLE IF NOT EXISTS public.issue_group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_group_id UUID NOT NULL REFERENCES public.issue_groups(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES public.department_issues(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT uq_group_member UNIQUE (issue_group_id, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_groups_dept ON public.issue_groups(department_id);
CREATE INDEX IF NOT EXISTS idx_groups_cat ON public.issue_groups(category);
CREATE INDEX IF NOT EXISTS idx_groups_status ON public.issue_groups(status);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON public.issue_group_members(issue_group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_issue ON public.issue_group_members(issue_id);

ALTER TABLE public.issue_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_group_members ENABLE ROW LEVEL SECURITY;

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
    INSERT INTO public.issue_group_members (issue_group_id, issue_id)
    VALUES (p_group_id, p_issue_id)
    ON CONFLICT (issue_group_id, issue_id) DO NOTHING;

    SELECT * INTO v_group FROM public.issue_groups WHERE id = p_group_id;

    RETURN to_jsonb(v_group);
END;
$$;

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

-- Phase 6.4: Recurring Issue Detection
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

CREATE INDEX IF NOT EXISTS idx_recurrence_group ON public.issue_group_recurrence(issue_group_id);
CREATE INDEX IF NOT EXISTS idx_recurrence_is_recurring ON public.issue_group_recurrence(is_recurring);

ALTER TABLE public.issue_group_recurrence ENABLE ROW LEVEL SECURITY;

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
        v_time_span := ROUND(EXTRACT(EPOCH FROM (v_latest_report - v_first_report)) / 86400.0, 2);

        IF v_report_count >= p_min_reports
           AND v_distinct_dates >= p_min_dates
           AND v_time_span <= p_window_days THEN
            v_is_recurring := true;
        ELSE
            v_is_recurring := false;
        END IF;

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

-- ==============================================================================
-- Phase 8 Migration: HOD Intelligence Dashboard
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Restrict Issue Group Updates to Status Only (Defense-in-Depth)
-- Revoke any broad table-level update privilege
REVOKE UPDATE ON TABLE public.issue_groups FROM authenticated, anon, public;

-- Grant column-level UPDATE strictly on status and updated_at
GRANT UPDATE (status, updated_at) ON TABLE public.issue_groups TO authenticated;

-- Row Level Security: Enforce HOD role and valid status values
DROP POLICY IF EXISTS issue_groups_hod_update_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_update_policy ON public.issue_groups
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod'
        )
        AND status IN ('open', 'resolved', 'closed')
    );

-- Trigger Protection: Block any modification to immutable fields
CREATE OR REPLACE FUNCTION public.check_issue_group_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Prevent modification of title, summary, category, location, department_id, issue_count, created_at
    IF (OLD.id IS DISTINCT FROM NEW.id) OR
       (OLD.department_id IS DISTINCT FROM NEW.department_id) OR
       (OLD.category IS DISTINCT FROM NEW.category) OR
       (OLD.title IS DISTINCT FROM NEW.title) OR
       (OLD.summary IS DISTINCT FROM NEW.summary) OR
       (OLD.location IS DISTINCT FROM NEW.location) OR
       (OLD.issue_count IS DISTINCT FROM NEW.issue_count) OR
       (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
        RAISE EXCEPTION 'Security violation: Only the status column may be updated on issue_groups.';
    END IF;

    IF NEW.status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_issue_group_fields ON public.issue_groups;
CREATE TRIGGER trg_protect_issue_group_fields
    BEFORE UPDATE ON public.issue_groups
    FOR EACH ROW
    EXECUTE FUNCTION public.check_issue_group_immutable_fields();

-- 2. Secure RPC: Update Issue Group Status (HOD Only Controlled Mechanism)
CREATE OR REPLACE FUNCTION public.update_issue_group_status(
    p_group_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_hod BOOLEAN;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required.';
    END IF;

    -- Verify caller is authenticated and has HOD role
    SELECT (role = 'hod') INTO v_is_hod
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_is_hod IS NOT TRUE THEN
        RAISE EXCEPTION 'Access denied. HOD role required to update issue group status.';
    END IF;

    -- Validate allowed status values strictly
    IF p_status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', p_status;
    END IF;

    UPDATE public.issue_groups
    SET status = p_status,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_group_id
    RETURNING * INTO v_res;

    IF v_res.id IS NULL THEN
        RAISE EXCEPTION 'Issue group not found for ID %.', p_group_id;
    END IF;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_issue_group_status TO authenticated;

-- 3. Atomic Consolidated RPC: Get HOD Dashboard Data
-- Retrieves all issue groups with analytical results and member reports in 1 database round-trip
-- Zero-PII: Does NOT expose student_id, student_email, or roll_number
-- Correct severity join: Joins public.feedback_severity ON fs.issue_id = di.id
CREATE OR REPLACE FUNCTION public.get_hod_dashboard_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_hod BOOLEAN;
    v_groups JSONB;
BEGIN
    -- Verify caller has HOD role
    SELECT (role = 'hod') INTO v_is_hod
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_is_hod IS NOT TRUE THEN
        RAISE EXCEPTION 'Access denied. HOD role required to access intelligence dashboard data.';
    END IF;

    SELECT COALESCE(jsonb_agg(group_data ORDER BY (group_data->>'created_at') DESC), '[]'::jsonb)
    INTO v_groups
    FROM (
        SELECT 
            ig.id,
            ig.department_id,
            ig.category,
            ig.title,
            ig.summary,
            ig.location,
            ig.status,
            ig.issue_count,
            ig.created_at,
            ig.updated_at,
            to_jsonb(p.*) AS priority,
            to_jsonb(w.*) AS early_warning,
            to_jsonb(r.*) AS recurrence,
            (
                SELECT COALESCE(jsonb_agg(
                    jsonb_build_object(
                        'id', di.id,
                        'category', di.category,
                        'location', di.location,
                        'description', di.description,
                        'severity', COALESCE(fs.severity, di.severity, 'low'),
                        'is_anonymous', di.is_anonymous,
                        'created_at', di.created_at,
                        'status', di.status
                    ) ORDER BY di.created_at ASC
                ), '[]'::jsonb)
                FROM public.issue_group_members igm
                JOIN public.department_issues di ON di.id = igm.issue_id
                LEFT JOIN public.feedback_severity fs ON fs.issue_id = di.id
                WHERE igm.issue_group_id = ig.id
            ) AS reports
        FROM public.issue_groups ig
        LEFT JOIN public.issue_group_priority p ON p.issue_group_id = ig.id
        LEFT JOIN public.issue_group_early_warning w ON w.issue_group_id = ig.id
        LEFT JOIN public.issue_group_recurrence r ON r.issue_group_id = ig.id
    ) group_data;

    RETURN jsonb_build_object(
        'success', true,
        'groups', v_groups
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hod_dashboard_data TO authenticated;

-- ==============================================================================
-- Phase 8.1 Migration: Department Scoping & Institutional Ownership
-- Safe, Idempotent, and Non-Destructive
-- ==============================================================================

-- 1. Canonical Department Catalog (Exactly 8 Departments)
INSERT INTO public.departments (name) VALUES 
    ('Civil'),
    ('Chemical'),
    ('CSE'),
    ('CSIT'),
    ('ECE'),
    ('EEE'),
    ('Mechanical'),
    ('Data Engineering')
ON CONFLICT (name) DO NOTHING;

-- Map legacy department names to canonical equivalents safely
DO $$
DECLARE
    v_cs_id UUID;
    v_cse_id UUID;
    v_it_id UUID;
    v_csit_id UUID;
    v_ec_id UUID;
    v_ece_id UUID;
BEGIN
    SELECT id INTO v_cs_id FROM public.departments WHERE name = 'Computer Science';
    SELECT id INTO v_cse_id FROM public.departments WHERE name = 'CSE';
    IF v_cs_id IS NOT NULL AND v_cse_id IS NOT NULL THEN
        UPDATE public.subjects SET department_id = v_cse_id WHERE department_id = v_cs_id;
        UPDATE public.department_issues SET department_id = v_cse_id WHERE department_id = v_cs_id;
        UPDATE public.issue_groups SET department_id = v_cse_id WHERE department_id = v_cs_id;
        DELETE FROM public.departments WHERE id = v_cs_id;
    ELSIF v_cs_id IS NOT NULL AND v_cse_id IS NULL THEN
        UPDATE public.departments SET name = 'CSE' WHERE id = v_cs_id;
    END IF;

    SELECT id INTO v_it_id FROM public.departments WHERE name = 'Information Technology';
    SELECT id INTO v_csit_id FROM public.departments WHERE name = 'CSIT';
    IF v_it_id IS NOT NULL AND v_csit_id IS NOT NULL THEN
        UPDATE public.subjects SET department_id = v_csit_id WHERE department_id = v_it_id;
        UPDATE public.department_issues SET department_id = v_csit_id WHERE department_id = v_it_id;
        UPDATE public.issue_groups SET department_id = v_csit_id WHERE department_id = v_it_id;
        DELETE FROM public.departments WHERE id = v_it_id;
    ELSIF v_it_id IS NOT NULL AND v_csit_id IS NULL THEN
        UPDATE public.departments SET name = 'CSIT' WHERE id = v_it_id;
    END IF;

    SELECT id INTO v_ec_id FROM public.departments WHERE name = 'Electronics & Communication';
    SELECT id INTO v_ece_id FROM public.departments WHERE name = 'ECE';
    IF v_ec_id IS NOT NULL AND v_ece_id IS NOT NULL THEN
        UPDATE public.subjects SET department_id = v_ece_id WHERE department_id = v_ec_id;
        UPDATE public.department_issues SET department_id = v_ece_id WHERE department_id = v_ec_id;
        UPDATE public.issue_groups SET department_id = v_ece_id WHERE department_id = v_ec_id;
        DELETE FROM public.departments WHERE id = v_ec_id;
    ELSIF v_ec_id IS NOT NULL AND v_ece_id IS NULL THEN
        UPDATE public.departments SET name = 'ECE' WHERE id = v_ec_id;
    END IF;
END $$;

-- 1.2 Department Catalog Safeguard: Verify exactly 8 canonical departments exist
DO $$
DECLARE
    v_invalid_depts TEXT;
    v_missing_depts TEXT;
    v_dept_count INT;
BEGIN
    -- Check for unexpected / non-canonical departments
    SELECT string_agg(name, ', ') INTO v_invalid_depts
    FROM public.departments
    WHERE name NOT IN (
        'Civil', 'Chemical', 'CSE', 'CSIT', 'ECE', 'EEE', 'Mechanical', 'Data Engineering'
    );

    IF v_invalid_depts IS NOT NULL THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Unexpected departments detected in public.departments catalog: [%]. Only the 8 canonical departments are permitted.', v_invalid_depts;
    END IF;

    -- Check for missing canonical departments
    SELECT string_agg(canonical_name, ', ') INTO v_missing_depts
    FROM (
        SELECT unnest(ARRAY['Civil', 'Chemical', 'CSE', 'CSIT', 'ECE', 'EEE', 'Mechanical', 'Data Engineering']) AS canonical_name
    ) c
    WHERE NOT EXISTS (
        SELECT 1 FROM public.departments d WHERE d.name = c.canonical_name
    );

    IF v_missing_depts IS NOT NULL THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Missing canonical departments in public.departments catalog: [%].', v_missing_depts;
    END IF;

    SELECT COUNT(*) INTO v_dept_count FROM public.departments;
    IF v_dept_count <> 8 THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Expected exactly 8 departments, found %.', v_dept_count;
    END IF;
END $$;

-- 2. Schema Extensions & Indexes
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_profiles_department ON public.profiles(department_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_hod_per_department 
ON public.profiles (department_id) 
WHERE role = 'hod';

-- 2.3 Classes: Add department_id (Institutional boundary: strictly ON DELETE RESTRICT)
ALTER TABLE public.classes 
ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT;

-- Ensure foreign key constraint is strictly ON DELETE RESTRICT
DO $$
DECLARE
    v_fk_name TEXT;
BEGIN
    SELECT tc.constraint_name INTO v_fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
     AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
      AND tc.table_name = 'classes' 
      AND kcu.column_name = 'department_id'
    LIMIT 1;

    IF v_fk_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public.classes DROP CONSTRAINT IF EXISTS ' || quote_ident(v_fk_name);
    END IF;

    ALTER TABLE public.classes 
    ADD CONSTRAINT fk_classes_department FOREIGN KEY (department_id) 
    REFERENCES public.departments(id) ON DELETE RESTRICT;
END $$;

CREATE INDEX IF NOT EXISTS idx_classes_department ON public.classes(department_id);

-- 3. Targeted Data Migration for Existing Known Test Records
-- Strictly targets verified test/demo entities (subjects, classes, Wi-Fi
-- issue groups & reports, and test profiles). Any unknown NULL record causes
-- an immediate abort with detailed error output.
DO $$
DECLARE
    v_csit_id UUID;
    v_unmapped_profiles INT;
    v_unmapped_issues INT;
    v_unmapped_groups INT;
    v_unmapped_classes INT;
    v_unmapped_subjects INT;
    v_unmapped_profile_ids TEXT;
    v_unmapped_issue_ids TEXT;
    v_unmapped_group_ids TEXT;
    v_unmapped_class_ids TEXT;
    v_unmapped_subject_ids TEXT;
BEGIN
    SELECT id INTO v_csit_id FROM public.departments WHERE name = 'CSIT';
    IF v_csit_id IS NULL THEN
        RAISE EXCEPTION 'CSIT department not found in public.departments catalog.';
    END IF;

    -- 3.1 Explicitly map verified test subjects to CSIT
    UPDATE public.subjects
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND id IN (
          'cd335bed-e859-4c6c-af88-db1c85b69354'::UUID,
          'efca16ed-ffb2-4a11-afe0-0d1e033fd27b'::UUID,
          'd77f60b6-d113-411c-957d-7ec2bdd389a2'::UUID,
          '892c5ce8-6b03-4bd5-9cb4-e6b149b1381f'::UUID,
          '0d29404a-23a3-4e6a-8cda-9c38917b52bd'::UUID,
          '09d40a71-8b8b-4507-bbf2-afc79859573d'::UUID,
          '21c56cc3-4e5e-4dcb-a657-a8f962020f69'::UUID,
          'c6de876a-f70f-48bd-94b5-7d19c5189318'::UUID,
          '408d1b5e-ba54-4789-aaf1-4f69c41e20e8'::UUID,
          '2318b944-8246-4bcf-b179-335a6ded9eb9'::UUID,
          'cc15352d-2743-4b79-a881-d850a20d33e0'::UUID
      );

    -- 3.2 Explicitly map verified test classes (823VCW, B2X53C, L786WF) and classes of mapped CS subjects to CSIT
    UPDATE public.classes
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND (
          UPPER(class_code) IN ('823VCW', 'B2X53C', 'L786WF')
          OR subject_id IN (
              SELECT id FROM public.subjects WHERE department_id = v_csit_id
          )
      );

    -- 3.3 Explicitly map verified test Wi-Fi issue group ('3a20f250-ab06-437f-9574-bfe3ec6e9b81' / 'Lab Wi-Fi Connectivity Issue') to CSIT
    UPDATE public.issue_groups
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND (
          id = '3a20f250-ab06-437f-9574-bfe3ec6e9b81'::UUID
          OR title = 'Lab Wi-Fi Connectivity Issue'
      );

    -- 3.4 Explicitly map verified test Wi-Fi department issue reports to CSIT
    UPDATE public.department_issues
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND id IN (
          'b3040253-0cc3-49ec-85e3-1b06bbab9494'::UUID,
          '2eeba2fc-770f-412b-9ca4-f25db3829658'::UUID,
          '6f5f2c63-6b82-49e7-9575-f15aa820438c'::UUID,
          '79b76cb1-0e9d-42b0-b99b-e1ae6651965b'::UUID
      );

    -- 3.5 Explicitly map verified test profiles to CSIT
    UPDATE public.profiles
    SET department_id = v_csit_id
    WHERE department_id IS NULL
      AND id IN (
          'e0c9b25d-42ee-4110-87b3-d1d76c93a619'::UUID,
          'ee1316ea-d02e-4c4c-896e-eb8ac465ef38'::UUID,
          '522583e6-156b-4ec4-b1d9-ff02a573bc14'::UUID,
          '32de79fa-1d6e-4192-8328-5e4d0688fe48'::UUID
      );

    -- 3.6 Safeguard Verification: If ANY unexpected/unmapped record remains with NULL department_id, FAIL and STOP
    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_profiles, v_unmapped_profile_ids 
    FROM public.profiles WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_issues, v_unmapped_issue_ids 
    FROM public.department_issues WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_groups, v_unmapped_group_ids 
    FROM public.issue_groups WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_classes, v_unmapped_class_ids 
    FROM public.classes WHERE department_id IS NULL;

    SELECT COUNT(*), string_agg(id::text, ', ') INTO v_unmapped_subjects, v_unmapped_subject_ids 
    FROM public.subjects WHERE department_id IS NULL;

    IF v_unmapped_profiles > 0 OR v_unmapped_issues > 0 OR v_unmapped_groups > 0 OR v_unmapped_classes > 0 OR v_unmapped_subjects > 0 THEN
        RAISE EXCEPTION 'MIGRATION HALTED: Unmapped records with NULL department_id detected. CSIT is not a generic fallback. Unmapped Profiles: % (IDs: %); Issues: % (IDs: %); Groups: % (IDs: %); Classes: % (IDs: %); Subjects: % (IDs: %). Please inspect pre-migration queries and explicitly assign departments to these records before re-running the migration.',
            v_unmapped_profiles, COALESCE(v_unmapped_profile_ids, 'none'),
            v_unmapped_issues, COALESCE(v_unmapped_issue_ids, 'none'),
            v_unmapped_groups, COALESCE(v_unmapped_group_ids, 'none'),
            v_unmapped_classes, COALESCE(v_unmapped_class_ids, 'none'),
            v_unmapped_subjects, COALESCE(v_unmapped_subject_ids, 'none');
    END IF;
END $$;

-- 4. Enforce NOT NULL Constraints on Department Columns
ALTER TABLE public.profiles ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE public.department_issues ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE public.issue_groups ALTER COLUMN department_id SET NOT NULL;
ALTER TABLE public.classes ALTER COLUMN department_id SET NOT NULL;

-- 5. Authentication & Integrity Triggers
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_dept_id UUID;
    v_dept_raw TEXT;
BEGIN
    v_dept_raw := NEW.raw_user_meta_data->>'department_id';
    IF v_dept_raw IS NOT NULL AND v_dept_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_dept_id := v_dept_raw::UUID;
    END IF;

    IF v_dept_id IS NULL THEN
        RAISE EXCEPTION 'Registration rejected: department_id is required for all accounts.';
    END IF;

    INSERT INTO public.profiles (id, full_name, email, role, roll_number, department_id)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Academic User'),
        COALESCE(NEW.email, ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'student'),
        NULLIF(UPPER(TRIM(NEW.raw_user_meta_data->>'roll_number')), ''),
        v_dept_id
    )
    ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        roll_number = COALESCE(EXCLUDED.roll_number, public.profiles.roll_number),
        department_id = EXCLUDED.department_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.set_department_issue_dept()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    SELECT department_id INTO NEW.department_id 
    FROM public.profiles 
    WHERE id = NEW.student_id;

    IF NEW.department_id IS NULL THEN
        RAISE EXCEPTION 'Student must belong to a valid department to report an issue.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_dept_issue ON public.department_issues;
CREATE TRIGGER trg_set_dept_issue
    BEFORE INSERT ON public.department_issues
    FOR EACH ROW
    EXECUTE FUNCTION public.set_department_issue_dept();

CREATE OR REPLACE FUNCTION public.check_class_department_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_faculty_dept UUID;
    v_subject_dept UUID;
BEGIN
    SELECT department_id INTO v_faculty_dept FROM public.profiles WHERE id = NEW.faculty_id;
    IF v_faculty_dept IS NULL OR NEW.department_id <> v_faculty_dept THEN
        RAISE EXCEPTION 'Faculty can only create classes within their own department.';
    END IF;

    SELECT department_id INTO v_subject_dept FROM public.subjects WHERE id = NEW.subject_id;
    IF v_subject_dept IS NOT NULL AND NEW.department_id <> v_subject_dept THEN
        RAISE EXCEPTION 'Class department must match the subject department.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_class_department ON public.classes;
CREATE TRIGGER trg_check_class_department
    BEFORE INSERT OR UPDATE ON public.classes
    FOR EACH ROW
    EXECUTE FUNCTION public.check_class_department_consistency();

-- Group membership department integrity trigger:
-- Enforces that an issue can only be linked to an issue group belonging to the same department
CREATE OR REPLACE FUNCTION public.check_group_member_department_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_group_dept UUID;
    v_issue_dept UUID;
BEGIN
    SELECT department_id INTO v_group_dept FROM public.issue_groups WHERE id = NEW.issue_group_id;
    SELECT department_id INTO v_issue_dept FROM public.department_issues WHERE id = NEW.issue_id;

    IF v_group_dept IS NULL OR v_issue_dept IS NULL THEN
        RAISE EXCEPTION 'Cannot link issue to group: both issue and group must have valid departments.';
    END IF;

    IF v_group_dept <> v_issue_dept THEN
        RAISE EXCEPTION 'Department mismatch: cannot link issue from department % to group in department %.',
            v_issue_dept, v_group_dept;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_group_member_dept ON public.issue_group_members;
CREATE TRIGGER trg_check_group_member_dept
    BEFORE INSERT OR UPDATE ON public.issue_group_members
    FOR EACH ROW
    EXECUTE FUNCTION public.check_group_member_department_match();

-- 5.5 Trigger Protection: Immutable issue group fields (Restored Phase 8 security)
CREATE OR REPLACE FUNCTION public.check_issue_group_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Prevent modification of title, summary, category, location, department_id, issue_count, created_at
    IF (OLD.id IS DISTINCT FROM NEW.id) OR
       (OLD.department_id IS DISTINCT FROM NEW.department_id) OR
       (OLD.category IS DISTINCT FROM NEW.category) OR
       (OLD.title IS DISTINCT FROM NEW.title) OR
       (OLD.summary IS DISTINCT FROM NEW.summary) OR
       (OLD.location IS DISTINCT FROM NEW.location) OR
       (OLD.issue_count IS DISTINCT FROM NEW.issue_count) OR
       (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
        RAISE EXCEPTION 'Security violation: Only the status column may be updated on issue_groups.';
    END IF;

    IF NEW.status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_issue_group_fields ON public.issue_groups;
CREATE TRIGGER trg_protect_issue_group_fields
    BEFORE UPDATE ON public.issue_groups
    FOR EACH ROW
    EXECUTE FUNCTION public.check_issue_group_immutable_fields();

-- 6. Department-Scoped Row Level Security (RLS) Policies
DROP POLICY IF EXISTS "department_issues_select_policy" ON public.department_issues;
CREATE POLICY "department_issues_select_policy" ON public.department_issues 
    FOR SELECT TO authenticated 
    USING (
        student_id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.department_issues.department_id
        )
    );

DROP POLICY IF EXISTS "department_issues_insert_policy" ON public.department_issues;
CREATE POLICY "department_issues_insert_policy" ON public.department_issues 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student()
        AND department_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    );

DROP POLICY IF EXISTS "department_issues_update_policy" ON public.department_issues;
CREATE POLICY "department_issues_update_policy" ON public.department_issues 
    FOR UPDATE TO authenticated 
    USING (
        student_id = auth.uid() 
        OR EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.department_issues.department_id
        )
    );

DROP POLICY IF EXISTS issue_groups_hod_select_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_select_policy ON public.issue_groups
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.issue_groups.department_id
        )
    );

DROP POLICY IF EXISTS issue_groups_hod_update_policy ON public.issue_groups;
CREATE POLICY issue_groups_hod_update_policy ON public.issue_groups
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.issue_groups.department_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.issue_groups.department_id
        )
        AND status IN ('open', 'resolved', 'closed')
    );

DROP POLICY IF EXISTS "classes_select_policy" ON public.classes;
CREATE POLICY "classes_select_policy" ON public.classes 
    FOR SELECT TO authenticated 
    USING (
        faculty_id = auth.uid() 
        OR (
            is_active = true 
            AND department_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
        )
        OR public.is_student_enrolled(id)
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'hod' AND department_id = public.classes.department_id
        )
    );

DROP POLICY IF EXISTS "classes_insert_policy" ON public.classes;
CREATE POLICY "classes_insert_policy" ON public.classes 
    FOR INSERT TO authenticated 
    WITH CHECK (
        auth.uid() = faculty_id 
        AND public.is_faculty()
        AND department_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    );

DROP POLICY IF EXISTS "class_members_insert_policy" ON public.class_members;
CREATE POLICY "class_members_insert_policy" ON public.class_members 
    FOR INSERT TO authenticated 
    WITH CHECK (
        student_id = auth.uid() 
        AND public.is_student() 
        AND public.is_class_active(class_id)
        AND (SELECT department_id FROM public.profiles WHERE id = auth.uid()) = 
            (SELECT department_id FROM public.classes WHERE id = class_id)
    );

-- 7. Scoped RPC Updates
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
    v_initial_issue_dept UUID;
BEGIN
    IF p_department_id IS NULL THEN
        RAISE EXCEPTION 'Issue group department_id is strictly required.';
    END IF;

    IF p_title IS NULL OR trim(p_title) = '' THEN
        RAISE EXCEPTION 'Issue group title is required.';
    END IF;

    IF p_category IS NULL OR trim(p_category) = '' THEN
        RAISE EXCEPTION 'Issue group category is required.';
    END IF;

    -- Validate initial issue BEFORE group creation
    IF p_initial_issue_id IS NOT NULL THEN
        SELECT department_id INTO v_initial_issue_dept
        FROM public.department_issues
        WHERE id = p_initial_issue_id;

        IF NOT FOUND OR v_initial_issue_dept IS NULL THEN
            RAISE EXCEPTION 'Initial issue % does not exist or has no department assigned.', p_initial_issue_id;
        END IF;

        IF v_initial_issue_dept <> p_department_id THEN
            RAISE EXCEPTION 'Department mismatch: initial issue belongs to department %, but group is being created for department %.',
                v_initial_issue_dept, p_department_id;
        END IF;
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

GRANT EXECUTE ON FUNCTION public.create_issue_group TO authenticated;

-- Add Issue to Group RPC: Validate existence and department match
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
    v_group_dept_id UUID;
    v_issue_dept_id UUID;
BEGIN
    IF p_group_id IS NULL OR p_issue_id IS NULL THEN
        RAISE EXCEPTION 'Both group_id and issue_id are required.';
    END IF;

    SELECT department_id INTO v_issue_dept_id
    FROM public.department_issues
    WHERE id = p_issue_id;

    IF NOT FOUND OR v_issue_dept_id IS NULL THEN
        RAISE EXCEPTION 'Issue % does not exist or has no assigned department.', p_issue_id;
    END IF;

    SELECT department_id INTO v_group_dept_id
    FROM public.issue_groups
    WHERE id = p_group_id;

    IF NOT FOUND OR v_group_dept_id IS NULL THEN
        RAISE EXCEPTION 'Issue group % does not exist or has no assigned department.', p_group_id;
    END IF;

    IF v_group_dept_id <> v_issue_dept_id THEN
        RAISE EXCEPTION 'Department mismatch: cannot add issue from department % to group in department %.',
            v_issue_dept_id, v_group_dept_id;
    END IF;

    INSERT INTO public.issue_group_members (issue_group_id, issue_id)
    VALUES (p_group_id, p_issue_id)
    ON CONFLICT (issue_group_id, issue_id) DO NOTHING;

    SELECT * INTO v_group FROM public.issue_groups WHERE id = p_group_id;

    RETURN to_jsonb(v_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_issue_to_group TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.get_hod_dashboard_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hod_dept_id UUID;
    v_hod_dept_name TEXT;
    v_groups JSONB;
BEGIN
    -- Verify caller has HOD role and retrieve department
    SELECT p.department_id, d.name INTO v_hod_dept_id, v_hod_dept_name
    FROM public.profiles p
    JOIN public.departments d ON d.id = p.department_id
    WHERE p.id = auth.uid() AND p.role = 'hod';

    IF v_hod_dept_id IS NULL THEN
        RAISE EXCEPTION 'Access denied. Authenticated HOD must belong to a registered department.';
    END IF;

    SELECT COALESCE(jsonb_agg(group_data ORDER BY (group_data->>'created_at') DESC), '[]'::jsonb)
    INTO v_groups
    FROM (
        SELECT 
            ig.id,
            ig.department_id,
            v_hod_dept_name AS department_name,
            ig.category,
            ig.title,
            ig.summary,
            ig.location,
            ig.status,
            ig.issue_count,
            ig.created_at,
            ig.updated_at,
            to_jsonb(p.*) AS priority,
            to_jsonb(w.*) AS early_warning,
            to_jsonb(r.*) AS recurrence,
            (
                SELECT COALESCE(jsonb_agg(
                    jsonb_build_object(
                        'id', di.id,
                        'category', di.category,
                        'location', di.location,
                        'description', di.description,
                        'severity', COALESCE(fs.severity, di.severity, 'low'),
                        'is_anonymous', di.is_anonymous,
                        'created_at', di.created_at,
                        'status', di.status
                    ) ORDER BY di.created_at ASC
                ), '[]'::jsonb)
                FROM public.issue_group_members igm
                JOIN public.department_issues di ON di.id = igm.issue_id
                LEFT JOIN public.feedback_severity fs ON fs.issue_id = di.id
                WHERE igm.issue_group_id = ig.id
            ) AS reports
        FROM public.issue_groups ig
        LEFT JOIN public.issue_group_priority p ON p.issue_group_id = ig.id
        LEFT JOIN public.issue_group_early_warning w ON w.issue_group_id = ig.id
        LEFT JOIN public.issue_group_recurrence r ON r.issue_group_id = ig.id
        WHERE ig.department_id = v_hod_dept_id -- STRICT HOD DEPARTMENT ISOLATION
    ) group_data;

    RETURN jsonb_build_object(
        'success', true,
        'department_id', v_hod_dept_id,
        'department_name', v_hod_dept_name,
        'groups', v_groups
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hod_dashboard_data TO authenticated;

CREATE OR REPLACE FUNCTION public.update_issue_group_status(
    p_group_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hod_dept_id UUID;
    v_group_dept_id UUID;
    v_res RECORD;
BEGIN
    IF p_group_id IS NULL THEN
        RAISE EXCEPTION 'Group ID is required.';
    END IF;

    -- Verify caller is authenticated and has HOD role
    SELECT department_id INTO v_hod_dept_id
    FROM public.profiles
    WHERE id = auth.uid() AND role = 'hod';

    IF v_hod_dept_id IS NULL THEN
        RAISE EXCEPTION 'Access denied. HOD role and department assignment required.';
    END IF;

    -- Verify target issue group belongs to the HOD's department
    SELECT department_id INTO v_group_dept_id
    FROM public.issue_groups
    WHERE id = p_group_id;

    IF v_group_dept_id IS NULL THEN
        RAISE EXCEPTION 'Issue group not found for ID %.', p_group_id;
    END IF;

    IF v_group_dept_id <> v_hod_dept_id THEN
        RAISE EXCEPTION 'Access denied. You can only update issue groups within your own department.';
    END IF;

    -- Validate allowed status values strictly
    IF p_status NOT IN ('open', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid status: %. Allowed values are open, resolved, closed.', p_status;
    END IF;

    UPDATE public.issue_groups
    SET status = p_status,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_group_id
    RETURNING * INTO v_res;

    RETURN to_jsonb(v_res);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_issue_group_status TO authenticated;

