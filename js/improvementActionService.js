/**
 * Improvement Action Service (Phase 4)
 * Manages faculty improvement actions, follow-up feedback sessions,
 * and before/after impact comparisons.
 */

import { supabase, isSupabaseConfigured } from './supabase.js';
import { getSessionSentimentSummary } from './sentimentService.js';
import { getSessionClassificationSummary } from './classificationService.js';
import { getSessionSeveritySummary } from './severityService.js';



export const IMPROVEMENT_AREAS = {
  understanding: { label: 'Understanding of Concepts', icon: '🧠' },
  teaching_clarity: { label: 'Teaching Clarity & Delivery', icon: '💡' },
  pace: { label: 'Lecture / Course Pace', icon: '⏱️' },
  difficulty: { label: 'Topic / Subject Difficulty', icon: '🧩' },
  doubt_resolution: { label: 'Doubt Resolution', icon: '❓' },
  student_suggestions: { label: 'Student Suggestions & Feedback', icon: '💬' },
  other: { label: 'Other Improvement Area', icon: '📌' }
};

export const ACTION_TYPES = {
  additional_explanation: { label: 'Additional In-Class Explanation', icon: '🗣️' },
  extra_examples: { label: 'Extra Worked Examples & Problems', icon: '✏️' },
  practice_questions: { label: 'Practice Questions & Exercises', icon: '📝' },
  study_material: { label: 'Curated Study Material & Notes', icon: '📚' },
  revision_session: { label: 'Revision / Recap Session', icon: '🔄' },
  doubt_clearing_session: { label: 'Dedicated Doubt-Clearing Session', icon: '🙋' },
  other: { label: 'Other Pedagogical Action', icon: '⚡' }
};

export const ACTION_STATUSES = {
  planned: { label: 'Planned', badge: '⏳' },
  in_progress: { label: 'In Progress', badge: '▶️' },
  completed: { label: 'Completed', badge: '✅' }
};

function normalizeActionRecord(act) {
  if (!act) return null;
  return {
    ...act,
    session_id: act.feedback_session_id || act.session_id,
    area: act.improvement_area || act.area,
    description: act.action_description || act.description,
    target_date: act.action_date || act.target_date,
    completed_at: act.completed_at || (act.status === 'completed' ? act.updated_at : null)
  };
}

/**
 * Fetch aggregate feedback results for a closed session
 * STRICT PRIVACY: Returns only aggregate statistics, distributions, and anonymous comments.
 * Never exposes individual student responses or identities.
 * @param {string} sessionId - UUID of the session
 * @returns {Promise<Object>} Aggregate results object
 */
export async function getFeedbackSessionResults(sessionId) {
  if (!sessionId) throw new Error('Session ID is required.');

  // 1. Fetch session details
  const { data: session, error: sessionErr } = await supabase
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
      classes (
        id,
        class_code,
        subjects (
          name,
          code,
          semesters (
            semester_number
          )
        )
      )
    `)
    .eq('id', sessionId)
    .single();

  if (sessionErr) {
    console.error('[ImprovementActionService] Error fetching session details:', sessionErr);
    throw new Error('Failed to load session details.');
  }

  // 2. Fetch feedback responses (only metrics & anonymous comment, no student_id/profiles)
  const { data: responses, error: respErr } = await supabase
    .from('class_feedback')
    .select('understanding_rating, teaching_clarity_rating, pace, difficulty, doubts_addressed, comment')
    .eq('session_id', sessionId);

  if (respErr) {
    console.error('[ImprovementActionService] Error fetching responses:', respErr);
    throw new Error('Failed to load feedback results.');
  }

  const list = responses || [];
  const count = list.length;

  // If no responses
  if (count === 0) {
    return {
      sessionId,
      session,
      totalResponses: 0,
      responseCount: 0,
      hasResponses: false,
      isLimitedResponses: false,
      metrics: {
        understanding: { avg: 0 },
        clarity: { avg: 0 },
        difficulty: { avg: 0 },
        doubtsAddressed: { positivePct: 0 }
      },
      averages: null,
      distributions: {
        pace: { too_slow: 0, good: 0, too_fast: 0 },
        difficulty: { easy: 0, moderate: 0, difficult: 0 },
        doubts: { yes: 0, partly: 0, no: 0 },
        clarity: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
      },
      comments: [],
      sentimentSummary: {
        positive: 0,
        neutral: 0,
        negative: 0,
        total: 0,
        overallSentiment: 'No comments yet',
        isLimited: false,
        hasAnalysis: false
      },
      classificationSummary: {
        counts: {
          understanding: 0,
          teaching_clarity: 0,
          pace: 0,
          difficulty: 0,
          doubt_resolution: 0,
          student_suggestion: 0,
          positive_feedback: 0,
          other: 0
        },
        total: 0,
        hasClassifications: false
      },
      severitySummary: {
        counts: { low: 0, medium: 0, high: 0 },
        total: 0,
        hasSeverities: false,
        isLimited: false
      }
    };
  }




  // Compute numerical averages
  const sumUnderstanding = list.reduce((acc, r) => acc + (r.understanding_rating || 0), 0);
  const sumClarity = list.reduce((acc, r) => acc + (r.teaching_clarity_rating || 0), 0);
  const avgUnderstanding = parseFloat((sumUnderstanding / count).toFixed(1));
  const avgClarity = parseFloat((sumClarity / count).toFixed(1));

  // Compute categorical distributions
  const paceCounts = { too_slow: 0, good: 0, too_fast: 0 };
  const difficultyCounts = { easy: 0, moderate: 0, difficult: 0 };
  const doubtsCounts = { yes: 0, partly: 0, no: 0 };
  const clarityCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  // Difficulty numeric score (Easy=1, Moderate=2, Difficult=3)
  let difficultyScoreSum = 0;
  const diffScoreMap = { easy: 1, moderate: 2, difficult: 3 };

  list.forEach(r => {
    if (r.pace && paceCounts[r.pace] !== undefined) paceCounts[r.pace]++;
    if (r.difficulty && difficultyCounts[r.difficulty] !== undefined) {
      difficultyCounts[r.difficulty]++;
      difficultyScoreSum += (diffScoreMap[r.difficulty] || 2);
    }
    if (r.doubts_addressed && doubtsCounts[r.doubts_addressed] !== undefined) doubtsCounts[r.doubts_addressed]++;
    if (r.teaching_clarity_rating && clarityCounts[r.teaching_clarity_rating] !== undefined) {
      clarityCounts[r.teaching_clarity_rating]++;
    }
  });

  const avgDifficultyScore = parseFloat((difficultyScoreSum / count).toFixed(1));
  const doubtsResolvedPct = Math.round((doubtsCounts.yes / count) * 100);

  // Extract non-empty anonymous comments
  const comments = list
    .map(r => (r.comment || '').trim())
    .filter(c => c.length > 0);

  // Fetch aggregate sentiment summary for this session (zero PII)
  const sentimentSummary = await getSessionSentimentSummary(sessionId);

  // Fetch aggregate classification summary for this session (zero PII)
  const classificationSummary = await getSessionClassificationSummary(sessionId);

  // Fetch aggregate severity summary for this session (zero PII)
  const severitySummary = await getSessionSeveritySummary(sessionId);

  return {
    sessionId,
    session,
    totalResponses: count,
    responseCount: count,
    hasResponses: true,
    isLimitedResponses: count < 3,
    metrics: {
      understanding: { avg: avgUnderstanding, scale: 5 },
      clarity: { avg: avgClarity, scale: 5 },
      difficulty: { avg: avgDifficultyScore, scale: 3 },
      doubtsAddressed: { positivePct: doubtsResolvedPct, counts: doubtsCounts }
    },
    averages: {
      understanding: avgUnderstanding,
      clarity: avgClarity,
      difficultyScore: avgDifficultyScore, // 1 (Easy) to 3 (Difficult)
      doubtsResolvedPct
    },
    distributions: {
      pace: paceCounts,
      difficulty: difficultyCounts,
      doubts: doubtsCounts,
      clarity: clarityCounts
    },
    comments,
    sentimentSummary,
    classificationSummary,
    severitySummary
  };
}




/**
 * Create a new improvement action for a closed feedback session
 * @param {Object} params
 * @returns {Promise<Object>} Created improvement action record
 */
export async function createImprovementAction(params) {
  const feedbackSessionId = params.feedbackSessionId || params.sessionId;
  const facultyId = params.facultyId;
  const improvementArea = params.improvementArea || params.area;
  const problemDescription = (params.problemDescription || '').trim();
  const actionType = params.actionType;
  const actionDescription = (params.actionDescription || params.description || '').trim();
  const actionDate = params.actionDate || params.targetDate || new Date().toISOString().split('T')[0];

  if (!feedbackSessionId) throw new Error('Feedback session ID is required.');
  if (!facultyId) throw new Error('Faculty ID is required.');

  if (!improvementArea || !IMPROVEMENT_AREAS[improvementArea]) {
    throw new Error('Please select a valid improvement area.');
  }

  if (!actionType || !ACTION_TYPES[actionType]) {
    throw new Error('Please select a valid action type.');
  }

  if (!actionDescription) {
    throw new Error('Please enter a description of the improvement action.');
  }

  const { data, error } = await supabase
    .from('improvement_actions')
    .insert([
      {
        feedback_session_id: feedbackSessionId,
        faculty_id: facultyId,
        improvement_area: improvementArea,
        problem_description: problemDescription || 'No specific reflection provided.',
        action_type: actionType,
        action_description: actionDescription,
        action_date: actionDate,
        status: 'planned'
      }
    ])
    .select()
    .single();

  if (error) {
    console.error('[ImprovementActionService] Error creating improvement action:', error);
    throw new Error(error.message || 'Failed to create improvement action.');
  }

  return normalizeActionRecord(data);
}

/**
 * Fetch improvement action linked to a feedback session
 * @param {string} sessionId
 * @returns {Promise<Object|null>}
 */
export async function getActionForSession(sessionId) {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from('improvement_actions')
    .select('*')
    .eq('feedback_session_id', sessionId)
    .maybeSingle();

  if (error) {
    console.error('[ImprovementActionService] Error fetching session action:', error);
    return null;
  }

  return normalizeActionRecord(data);
}

/**
 * Fetch all improvement actions created by a faculty member
 * @param {string} facultyId
 * @returns {Promise<Array>}
 */
export async function getFacultyImprovementActions(facultyId) {
  if (!facultyId) return [];

  const { data, error } = await supabase
    .from('improvement_actions')
    .select('*')
    .eq('faculty_id', facultyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[ImprovementActionService] Error fetching faculty actions:', error);
    return [];
  }

  return (data || []).map(normalizeActionRecord);
}

/**
 * Update the status of an improvement action
 * Supports (actionId, newStatus, facultyId) and (actionId, facultyId, newStatus)
 * Workflow: planned -> in_progress -> completed
 */
export async function updateActionStatus(actionId, arg2, arg3) {
  if (!actionId) throw new Error('Action ID is required.');
  
  const validStatuses = ['planned', 'in_progress', 'completed'];
  const newStatus = validStatuses.includes(arg2) ? arg2 : arg3;
  const facultyId = arg2 === newStatus ? arg3 : arg2;

  if (!validStatuses.includes(newStatus)) {
    throw new Error('Invalid action status.');
  }

  const updatePayload = {
    status: newStatus,
    updated_at: new Date().toISOString()
  };

  let query = supabase
    .from('improvement_actions')
    .update(updatePayload)
    .eq('id', actionId);

  if (facultyId) {
    query = query.eq('faculty_id', facultyId);
  }

  const { data, error } = await query.select().single();

  if (error) {
    console.error('[ImprovementActionService] Error updating action status:', error);
    throw new Error(error.message || 'Failed to update action status.');
  }

  return normalizeActionRecord(data);
}

/**
 * Create a follow-up feedback session for a completed improvement action
 * Supports both createFollowUpSession(actionId, facultyId) and createFollowUpSession({ actionId, facultyId })
 */
export async function createFollowUpSession(arg1, arg2) {
  const actionId = typeof arg1 === 'object' ? arg1.actionId : arg1;
  const facultyId = typeof arg1 === 'object' ? arg1.facultyId : arg2;

  if (!actionId) throw new Error('Improvement action ID is required.');
  if (!facultyId) throw new Error('Faculty ID is required.');

  // 1. Verify action is completed and doesn't already have a follow-up
  const { data: action, error: actionErr } = await supabase
    .from('improvement_actions')
    .select('id, status, follow_up_session_id, feedback_session_id')
    .eq('id', actionId)
    .single();

  if (actionErr || !action) {
    throw new Error('Improvement action not found.');
  }

  if (action.status !== 'completed') {
    throw new Error('A follow-up session can only be created after the improvement action is marked as Completed.');
  }

  if (action.follow_up_session_id) {
    throw new Error('A follow-up session has already been created for this improvement action.');
  }

  // 2. Fetch original session details
  const { data: origSession, error: origErr } = await supabase
    .from('class_feedback_sessions')
    .select('id, class_id, topic, unit')
    .eq('id', action.feedback_session_id)
    .single();

  if (origErr || !origSession) {
    throw new Error('Original feedback session not found.');
  }

  const followUpTopic = origSession.topic.startsWith('Follow-Up:')
    ? origSession.topic
    : 'Follow-Up: ' + origSession.topic;

  // 3. Create the follow-up session
  const { data: followUpSession, error: createErr } = await supabase
    .from('class_feedback_sessions')
    .insert([
      {
        class_id: origSession.class_id,
        faculty_id: facultyId,
        topic: followUpTopic,
        unit: origSession.unit,
        status: 'active',
        session_type: 'follow_up',
        parent_session_id: origSession.id
      }
    ])
    .select()
    .single();

  if (createErr) {
    console.error('[ImprovementActionService] Error creating follow-up session:', createErr);
    throw new Error(createErr.message || 'Failed to create follow-up session.');
  }

  // 4. Link follow-up session back to improvement_actions
  const { error: linkErr } = await supabase
    .from('improvement_actions')
    .update({
      follow_up_session_id: followUpSession.id,
      updated_at: new Date().toISOString()
    })
    .eq('id', actionId);

  if (linkErr) {
    console.warn('[ImprovementActionService] Warning linking follow-up to action:', linkErr);
  }

  return followUpSession;
}

/**
 * Compare aggregate results between Original and Follow-Up sessions
 */
export async function getImprovementComparison(originalSessionId, followUpSessionId) {
  if (!originalSessionId || !followUpSessionId) {
    throw new Error('Both Original and Follow-Up session IDs are required.');
  }

  const [origResults, followUpResults] = await Promise.all([
    getFeedbackSessionResults(originalSessionId),
    getFeedbackSessionResults(followUpSessionId)
  ]);

  const origCount = origResults.totalResponses || origResults.responseCount || 0;
  const followUpCount = followUpResults.totalResponses || followUpResults.responseCount || 0;

  // Helper to compute delta
  const computeMetric = (before, after, invert = false) => {
    if (before === null || after === null || isNaN(before) || isNaN(after)) {
      return { before: before ?? 0, after: after ?? 0, delta: 0, diff: 0, diffFormatted: '0.0', improved: false, isImproved: false, status: 'No Data' };
    }
    const diff = parseFloat((after - before).toFixed(1));
    const isImproved = invert ? diff < -0.05 : diff > 0.05;
    const isDegraded = invert ? diff > 0.05 : diff < -0.05;

    let status = 'Little / No Change';
    if (isImproved) status = 'Improved';
    if (isDegraded) status = 'Declined';

    const sign = diff > 0 ? '+' : '';
    const formattedDelta = sign + diff;

    return {
      before,
      after,
      delta: diff,
      diff,
      formattedDelta,
      diffFormatted: formattedDelta,
      isImproved,
      improved: isImproved,
      isDegraded,
      degraded: isDegraded,
      status
    };
  };

  const origAvg = origResults.averages || {};
  const followUpAvg = followUpResults.averages || {};

  const understandingComp = computeMetric(origAvg.understanding || 0, followUpAvg.understanding || 0, false);
  const clarityComp = computeMetric(origAvg.clarity || 0, followUpAvg.clarity || 0, false);
  const difficultyComp = computeMetric(origAvg.difficultyScore || 0, followUpAvg.difficultyScore || 0, true);

  const beforeDoubts = origAvg.doubtsResolvedPct || 0;
  const afterDoubts = followUpAvg.doubtsResolvedPct || 0;
  const diffDoubts = afterDoubts - beforeDoubts;
  const doubtsComp = {
    before: beforeDoubts,
    beforePct: beforeDoubts,
    after: afterDoubts,
    afterPct: afterDoubts,
    delta: diffDoubts,
    diff: diffDoubts,
    formattedDelta: (diffDoubts > 0 ? '+' : '') + diffDoubts + '%',
    diffFormatted: (diffDoubts > 0 ? '+' : '') + diffDoubts + '%',
    isImproved: diffDoubts > 0,
    improved: diffDoubts > 0,
    isDegraded: diffDoubts < 0,
    degraded: diffDoubts < 0
  };

  const metrics = {
    understanding: understandingComp,
    clarity: clarityComp,
    difficulty: difficultyComp,
    doubts: doubtsComp,
    doubtsAddressed: doubtsComp
  };

  let positiveCount = 0;
  let negativeCount = 0;

  if (understandingComp.isImproved) positiveCount++;
  if (understandingComp.isDegraded) negativeCount++;

  if (clarityComp.isImproved) positiveCount++;
  if (clarityComp.isDegraded) negativeCount++;

  if (difficultyComp.isImproved) positiveCount++;
  if (difficultyComp.isDegraded) negativeCount++;

  if (doubtsComp.isImproved) positiveCount++;
  if (doubtsComp.isDegraded) negativeCount++;

  let overallOutcome = 'Little / No Change';
  let overallStatus = 'neutral';

  if (positiveCount >= 2 && negativeCount === 0) {
    overallOutcome = 'Positive Improvement Observed';
    overallStatus = 'improved';
  } else if (positiveCount > negativeCount) {
    overallOutcome = 'Positive Trend Observed';
    overallStatus = 'improved';
  } else if (negativeCount >= 2) {
    overallOutcome = 'Needs Attention';
    overallStatus = 'needs_attention';
  }

  return {
    originalSessionId,
    followUpSessionId,
    originalResponses: origCount,
    followUpResponses: followUpCount,
    responses: {
      before: origCount,
      after: followUpCount
    },
    hasComparisonData: origCount > 0 && followUpCount > 0,
    metrics,
    understanding: understandingComp,
    clarity: clarityComp,
    difficulty: difficultyComp,
    doubts: doubtsComp,
    doubtsAddressed: doubtsComp,
    overallOutcome,
    overallStatus,
    outcomeType: overallStatus === 'improved' ? 'success' : (overallStatus === 'needs_attention' ? 'danger' : 'neutral'),
    originalSession: origResults.session,
    followUpSession: followUpResults.session
  };
}

/**
 * Fetch completed improvement updates for courses a student is enrolled in
 * PRIVACY: Omits private problem_description notes.
 * @param {string} studentId - UUID of student
 * @returns {Promise<Array>} List of public student improvement updates
 */
export async function getStudentImprovementUpdates(studentId) {
  if (!studentId) return [];

  // 1. Get class IDs the student is enrolled in
  const { data: memberships, error: memError } = await supabase
    .from('class_members')
    .select('class_id')
    .eq('student_id', studentId);

  if (memError || !memberships || memberships.length === 0) {
    return [];
  }

  const classIds = memberships.map(m => m.class_id);

  // 2. Fetch completed improvement actions for sessions in these classes
  const { data: actions, error: actError } = await supabase
    .from('improvement_actions')
    .select(`
      id,
      improvement_area,
      action_type,
      action_description,
      action_date,
      status,
      created_at,
      updated_at,
      class_feedback_sessions!feedback_session_id (
        id,
        class_id,
        topic,
        unit,
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
      )
    `)
    .eq('status', 'completed')
    .order('action_date', { ascending: false });

  if (actError) {
    console.error('[ImprovementActionService] Error fetching student improvement updates:', actError);
    return [];
  }

  // Filter actions belonging to enrolled classes (safely handles any RLS filtering)
  const enrolledClassSet = new Set(classIds);
  const relevantActions = (actions || []).filter(act => {
    const classId = act.class_feedback_sessions?.class_id;
    return classId && enrolledClassSet.has(classId);
  });

  return relevantActions.map(act => {
    const session = act.class_feedback_sessions;
    const cls = session?.classes;
    const subject = cls?.subjects;
    const semester = subject?.semesters;
    const faculty = cls?.profiles;

    return {
      id: act.id,
      area: act.improvement_area,
      action_type: act.action_type,
      description: act.action_description,
      completed_at: act.action_date || act.updated_at,
      topic: session?.topic || 'Topic',
      unit: session?.unit || '',
      subject_name: subject?.name || 'Subject',
      subject_code: subject?.code || '',
      semester_number: semester?.semester_number || '',
      faculty_name: faculty?.full_name || 'Faculty Instructor',
      class_code: cls?.class_code || ''
    };
  });
}
