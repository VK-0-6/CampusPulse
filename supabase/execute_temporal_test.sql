BEGIN;

-- 1. Fixed test UUIDs
-- Group UUID:
--   eeee0000-0000-0000-0000-000000000001
-- Issue UUIDs:
--   eeee0000-0000-0000-0000-000000000011 (Student S1)
--   eeee0000-0000-0000-0000-000000000012 (Student S2)
--   eeee0000-0000-0000-0000-000000000013 (Student S3)
--   eeee0000-0000-0000-0000-000000000014 (Student S4)

-- 2. Insert Issue Group (issue_count omitted; starts at 0 via DEFAULT)
INSERT INTO public.issue_groups (
    id,
    department_id,
    category,
    title,
    summary,
    location,
    status,
    created_at,
    updated_at
) VALUES (
    'eeee0000-0000-0000-0000-000000000001'::uuid,
    '7b37ee6f-9d23-4cdd-87da-30177456e26f'::uuid, -- CSIT
    'projector',
    'Recurring Projector HDMI Signal Failures in IECT18',
    'Controlled temporal test group to verify recurrence and early warning detection.',
    'IECT18',
    'open',
    '2026-09-11 09:30:00+00'::timestamptz,
    '2026-09-20 11:45:00+00'::timestamptz
);

-- 3. Insert Historical Department Issues
INSERT INTO public.department_issues (
    id,
    student_id,
    department_id,
    category,
    location,
    description,
    severity,
    is_anonymous,
    status,
    created_at
) VALUES 
(
    'eeee0000-0000-0000-0000-000000000011'::uuid,
    '47f2b912-336e-4322-a894-02efbec426dd'::uuid, -- S1
    '7b37ee6f-9d23-4cdd-87da-30177456e26f'::uuid,
    'projector',
    'IECT18',
    'Projector in IECT18 displays intermittent flickering and blank screen over HDMI.',
    'high',
    false,
    'open',
    '2026-09-11 09:30:00+00'::timestamptz
),
(
    'eeee0000-0000-0000-0000-000000000012'::uuid,
    '90c5daff-bcdc-4219-83a0-06a0bbce4270'::uuid, -- S2
    '7b37ee6f-9d23-4cdd-87da-30177456e26f'::uuid,
    'projector',
    'IECT18',
    'HDMI connection in IECT18 loses signal after 10 minutes of lecture.',
    'medium',
    false,
    'open',
    '2026-09-17 10:15:00+00'::timestamptz
),
(
    'eeee0000-0000-0000-0000-000000000013'::uuid,
    'dc71f9a8-c094-4b50-b4d4-e10a6deb21bb'::uuid, -- S3
    '7b37ee6f-9d23-4cdd-87da-30177456e26f'::uuid,
    'projector',
    'IECT18',
    'Projector shut down during presentations and would not detect HDMI input.',
    'high',
    false,
    'open',
    '2026-09-19 14:00:00+00'::timestamptz
),
(
    'eeee0000-0000-0000-0000-000000000014'::uuid,
    '878eb83b-c987-4f05-8b3d-0b1a995d9fa9'::uuid, -- S4
    '7b37ee6f-9d23-4cdd-87da-30177456e26f'::uuid,
    'projector',
    'IECT18',
    'Complete failure of projector display in IECT18, HDMI port is loose.',
    'high',
    false,
    'open',
    '2026-09-20 11:45:00+00'::timestamptz
);

-- 4. Link Issues to Group (trg_sync_issue_group_count increments count 0 -> 1 -> 2 -> 3 -> 4)
INSERT INTO public.issue_group_members (
    issue_group_id,
    issue_id,
    created_at
) VALUES 
(
    'eeee0000-0000-0000-0000-000000000001'::uuid,
    'eeee0000-0000-0000-0000-000000000011'::uuid,
    '2026-09-11 09:30:00+00'::timestamptz
),
(
    'eeee0000-0000-0000-0000-000000000001'::uuid,
    'eeee0000-0000-0000-0000-000000000012'::uuid,
    '2026-09-17 10:15:00+00'::timestamptz
),
(
    'eeee0000-0000-0000-0000-000000000001'::uuid,
    'eeee0000-0000-0000-0000-000000000013'::uuid,
    '2026-09-19 14:00:00+00'::timestamptz
),
(
    'eeee0000-0000-0000-0000-000000000001'::uuid,
    'eeee0000-0000-0000-0000-000000000014'::uuid,
    '2026-09-20 11:45:00+00'::timestamptz
);

-- 5. Calculate Recurrence FIRST (populates issue_group_recurrence)
SELECT public.calculate_group_recurrence('eeee0000-0000-0000-0000-000000000001'::uuid);

-- 6. Calculate Analytics SECOND (reads is_recurring to populate priority and early warning)
SELECT public.calculate_group_analytics('eeee0000-0000-0000-0000-000000000001'::uuid);

COMMIT;
