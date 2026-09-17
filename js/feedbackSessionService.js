/**
 * Feedback Session Service
 * Manages class feedback sessions (creation, status toggling, retrieval)
 */

import { supabase } from './supabase.js';

/**
 * Start a new feedback session for a class
 * @param {Object} params
 * @param {string} params.classId - UUID of the class
 * @param {string} params.facultyId - UUID of the faculty member
 * @param {string} params.topic - Learning Concept / Topic title (required)
 * @param {string} [params.unit] - Unit number/identifier (optional)
 * @returns {Promise<Object>} Created session object
 */
export async function createFeedbackSession({ classId, facultyId, topic, unit }) {
  if (!classId) throw new Error('Please select a class.');
  if (!facultyId) throw new Error('Faculty ID is required.');
  
  const trimmedTopic = (topic || '').trim();
  if (!trimmedTopic) {
    throw new Error('Please enter today\'s Learning Concept or Topic.');
  }

  const trimmedUnit = (unit || '').trim() || null;

  // Check if there is already an active session for this specific class
  const { data: activeExisting, error: checkError } = await supabase
    .from('class_feedback_sessions')
    .select('id, topic, unit')
    .eq('class_id', classId)
    .eq('status', 'active')
    .maybeSingle();

  if (checkError) {
    console.error('[FeedbackSessionService] Error checking existing session:', checkError);
  }

  if (activeExisting) {
    const unitText = activeExisting.unit ? ` (Unit ${activeExisting.unit})` : '';
    throw new Error(
      `An active feedback session for "${activeExisting.topic}"${unitText} is already running for this class. Please close it before starting a new one.`
    );
  }

  const { data, error } = await supabase
    .from('class_feedback_sessions')
    .insert([
      {
        class_id: classId,
        faculty_id: facultyId,
        topic: trimmedTopic,
        unit: trimmedUnit,
        status: 'active'
      }
    ])
    .select(`
      id,
      class_id,
      faculty_id,
      topic,
      unit,
      status,
      started_at,
      closed_at,
      created_at
    `)
    .single();

  if (error) {
    console.error('[FeedbackSessionService] Error creating session:', error);
    throw new Error(error.message || 'Failed to start feedback session.');
  }

  return data;
}

/**
 * Fetch all feedback sessions created by a faculty member
 * Includes subject and semester info as well as response count
 * @param {string} facultyId - UUID of faculty member
 * @returns {Promise<Array>} List of session objects
 */
export async function getFacultyFeedbackSessions(facultyId) {
  if (!facultyId) return [];

  const { data, error } = await supabase
    .from('class_feedback_sessions')
    .select(`
      id,
      class_id,
      faculty_id,
      topic,
      unit,
      status,
      session_type,
      parent_session_id,
      started_at,
      closed_at,
      created_at,
      classes (
        id,
        class_code,
        subjects (
          name,
          code,
          semesters (
            semester_number,
            academic_year
          )
        )
      ),
      class_feedback (count)
    `)
    .eq('faculty_id', facultyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[FeedbackSessionService] Error fetching faculty sessions:', error);
    throw new Error(error.message || 'Failed to fetch feedback sessions.');
  }

  return (data || []).map(session => ({
    id: session.id,
    classId: session.class_id,
    topic: session.topic,
    unit: session.unit,
    status: session.status,
    sessionType: session.session_type || 'initial',
    parentSessionId: session.parent_session_id || null,
    startedAt: session.started_at,
    closedAt: session.closed_at,
    createdAt: session.created_at,
    classCode: session.classes?.class_code || '',
    subjectName: session.classes?.subjects?.name || 'Unknown Subject',
    subjectCode: session.classes?.subjects?.code || '',
    semesterNumber: session.classes?.subjects?.semesters?.semester_number || '',
    academicYear: session.classes?.subjects?.semesters?.academic_year || '',
    responseCount: session.class_feedback?.[0]?.count ?? 0
  }));
}

/**
 * Close an active feedback session
 * @param {string} sessionId - UUID of the session
 * @param {string} facultyId - UUID of the faculty member
 * @returns {Promise<Object>} Updated session object
 */
export async function closeFeedbackSession(sessionId, facultyId) {
  if (!sessionId) throw new Error('Session ID is required.');
  if (!facultyId) throw new Error('Faculty ID is required.');

  const { data, error } = await supabase
    .from('class_feedback_sessions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString()
    })
    .eq('id', sessionId)
    .eq('faculty_id', facultyId)
    .select()
    .single();

  if (error) {
    console.error('[FeedbackSessionService] Error closing session:', error);
    throw new Error(error.message || 'Failed to close feedback session.');
  }

  return data;
}

/**
 * Get active feedback sessions for classes the student is enrolled in
 * Also checks whether the student has already submitted feedback for each session
 * @param {string} studentId - UUID of student
 * @returns {Promise<Array>}
 */
export async function getActiveFeedbackSessionsForStudent(studentId) {
  if (!studentId) return [];

  // 1. Get class IDs the student is enrolled in
  const { data: memberships, error: memError } = await supabase
    .from('class_members')
    .select('class_id')
    .eq('student_id', studentId);

  if (memError) {
    console.error('[FeedbackSessionService] Error fetching student classes:', memError);
    throw new Error('Failed to fetch enrolled classes.');
  }

  const enrolledClassIds = (memberships || []).map(m => m.class_id);
  if (enrolledClassIds.length === 0) {
    return [];
  }

  // 2. Fetch active sessions for these classes
  const { data: sessions, error: sessError } = await supabase
    .from('class_feedback_sessions')
    .select(`
      id,
      class_id,
      topic,
      unit,
      status,
      session_type,
      parent_session_id,
      started_at,
      classes (
        id,
        class_code,
        subjects (
          name,
          code,
          semesters (
            semester_number
          )
        ),
        profiles (
          full_name
        )
      )
    `)
    .in('class_id', enrolledClassIds)
    .eq('status', 'active')
    .order('started_at', { ascending: false });

  if (sessError) {
    console.error('[FeedbackSessionService] Error fetching active sessions:', sessError);
    throw new Error('Failed to fetch active feedback sessions.');
  }

  if (!sessions || sessions.length === 0) {
    return [];
  }

  // 3. Find which of these sessions the student has already submitted feedback for
  const sessionIds = sessions.map(s => s.id);
  const { data: submissions, error: subError } = await supabase
    .from('class_feedback')
    .select('session_id')
    .in('session_id', sessionIds)
    .eq('student_id', studentId);

  if (subError) {
    console.error('[FeedbackSessionService] Error checking existing feedback:', subError);
  }

  const submittedSessionIds = new Set((submissions || []).map(s => s.session_id));

  return sessions.map(s => ({
    id: s.id,
    classId: s.class_id,
    topic: s.topic,
    unit: s.unit,
    status: s.status,
    sessionType: s.session_type || 'initial',
    parentSessionId: s.parent_session_id || null,
    startedAt: s.started_at,
    classCode: s.classes?.class_code || '',
    subjectName: s.classes?.subjects?.name || 'Unknown Subject',
    subjectCode: s.classes?.subjects?.code || '',
    semesterNumber: s.classes?.subjects?.semesters?.semester_number || '',
    facultyName: s.classes?.profiles?.full_name || 'Faculty Instructor',
    hasSubmitted: submittedSessionIds.has(s.id)
  }));
}

/**
 * Get feedback participation status for enrolled students in a class feedback session
 * PRIVACY RULE: Only checks whether each enrolled student has submitted or not.
 * Never joins or exposes feedback ratings, difficulty, pace, doubts, or comments.
 * @param {string} sessionId - UUID of the feedback session
 * @param {string} classId - UUID of the class
 * @returns {Promise<{ enrolledCount: number, submittedCount: number, students: Array }>}
 */
export async function getSessionParticipation(sessionId, classId) {
  if (!sessionId || !classId) {
    throw new Error('Session ID and Class ID are required.');
  }

  // 1. Fetch enrolled students from class_members
  const { data: members, error: memError } = await supabase
    .from('class_members')
    .select(`
      student_id,
      joined_at,
      profiles:student_id (
        id,
        full_name,
        email,
        roll_number
      )
    `)
    .eq('class_id', classId)
    .order('joined_at', { ascending: true });

  if (memError) {
    console.error('[FeedbackSessionService] Error fetching enrolled members:', memError);
    throw new Error(memError.message || 'Failed to fetch enrolled members.');
  }

  // 2. Fetch list of student_ids who submitted feedback for this session
  // PRIVACY: Only query student_id column from class_feedback, nothing else!
  const { data: submissions, error: subError } = await supabase
    .from('class_feedback')
    .select('student_id')
    .eq('session_id', sessionId);

  if (subError) {
    console.error('[FeedbackSessionService] Error fetching session submissions:', subError);
    throw new Error(subError.message || 'Failed to fetch session submissions.');
  }

  const submittedStudentIds = new Set((submissions || []).map(s => s.student_id));

  const students = (members || []).map(m => ({
    studentId: m.student_id,
    fullName: m.profiles?.full_name || 'Unknown Student',
    email: m.profiles?.email || '',
    rollNumber: m.profiles?.roll_number || '-',
    joinedAt: m.joined_at,
    hasSubmitted: submittedStudentIds.has(m.student_id)
  }));

  // Sort students: by roll number if available, then by name
  students.sort((a, b) => {
    if (a.rollNumber !== '-' && b.rollNumber !== '-') {
      return a.rollNumber.localeCompare(b.rollNumber);
    }
    return a.fullName.localeCompare(b.fullName);
  });

  const submittedCount = students.filter(s => s.hasSubmitted).length;

  return {
    enrolledCount: students.length,
    submittedCount,
    students
  };
}

