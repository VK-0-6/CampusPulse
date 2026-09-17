/**
 * Feedback Service
 * Handles student feedback submissions and duplicate checks
 */

import { supabase } from './supabase.js';
import { analyzeFeedbackComment } from './sentimentService.js';
import { classifyFeedbackComment } from './classificationService.js';
import { predictFeedbackSeverity } from './severityService.js';


const VALID_PACE_VALUES = ['too_slow', 'good', 'too_fast'];
const VALID_DIFFICULTY_VALUES = ['easy', 'moderate', 'difficult'];
const VALID_DOUBTS_VALUES = ['yes', 'partly', 'no'];

/**
 * Submit structured feedback for an active session
 * @param {Object} params
 * @param {string} params.sessionId - UUID of the feedback session
 * @param {string} params.studentId - UUID of the student
 * @param {number} params.understandingRating - 1 to 5
 * @param {number} params.teachingClarityRating - 1 to 5
 * @param {string} params.pace - 'too_slow' | 'good' | 'too_fast'
 * @param {string} params.difficulty - 'easy' | 'moderate' | 'difficult'
 * @param {string} params.doubtsAddressed - 'yes' | 'partly' | 'no'
 * @param {string} [params.comment] - Optional suggestions or comments
 * @returns {Promise<Object>} Submitted feedback record
 */
export async function submitClassFeedback({
  sessionId,
  studentId,
  understandingRating,
  teachingClarityRating,
  pace,
  difficulty,
  doubtsAddressed,
  comment
}) {
  if (!sessionId) throw new Error('Feedback session ID is required.');
  if (!studentId) throw new Error('Student ID is required.');

  // Validate numeric ratings
  const uRating = parseInt(understandingRating, 10);
  if (isNaN(uRating) || uRating < 1 || uRating > 5) {
    throw new Error('Please select an understanding rating between 1 and 5.');
  }

  const cRating = parseInt(teachingClarityRating, 10);
  if (isNaN(cRating) || cRating < 1 || cRating > 5) {
    throw new Error('Please select a teaching clarity rating between 1 and 5.');
  }

  // Validate structured choices
  if (!VALID_PACE_VALUES.includes(pace)) {
    throw new Error('Please select how the pace of the lecture was.');
  }

  if (!VALID_DIFFICULTY_VALUES.includes(difficulty)) {
    throw new Error('Please select the difficulty level of the topic.');
  }

  if (!VALID_DOUBTS_VALUES.includes(doubtsAddressed)) {
    throw new Error('Please indicate whether your doubts were addressed.');
  }

  // Verify session is active before submitting
  const { data: session, error: sessionErr } = await supabase
    .from('class_feedback_sessions')
    .select('id, status, topic')
    .eq('id', sessionId)
    .maybeSingle();

  if (sessionErr) {
    console.error('[FeedbackService] Error checking session status:', sessionErr);
  }

  if (!session) {
    throw new Error('This feedback session could not be found.');
  }

  if (session.status !== 'active') {
    throw new Error('This feedback session is closed. New submissions are no longer accepted.');
  }

  // Insert into class_feedback table
  const trimmedComment = (comment || '').trim() || null;

  const { data, error } = await supabase
    .from('class_feedback')
    .insert([
      {
        session_id: sessionId,
        student_id: studentId,
        understanding_rating: uRating,
        teaching_clarity_rating: cRating,
        pace,
        difficulty,
        doubts_addressed: doubtsAddressed,
        comment: trimmedComment
      }
    ])
    .select()
    .single();

  if (error) {
    // 23505 is PostgreSQL unique_violation code
    if (error.code === '23505' || error.message?.includes('uq_session_student')) {
      throw new Error('You have already submitted feedback for this session. Only one submission is permitted per student.');
    }
    console.error('[FeedbackService] Error submitting feedback:', error);
    throw new Error(error.message || 'Failed to submit feedback.');
  }

  // Phase 5: Trigger asynchronous sentiment analysis, classification & severity prediction
  // Decoupled: Failure never impacts the stored student feedback
  if (trimmedComment && data?.id) {
    analyzeFeedbackComment({ feedbackId: data.id, text: trimmedComment }).catch(err => {
      console.warn('[FeedbackService] Background sentiment analysis error:', err);
    });
    classifyFeedbackComment({ feedbackId: data.id, text: trimmedComment }).catch(err => {
      console.warn('[FeedbackService] Background classification error:', err);
    });
    predictFeedbackSeverity({ feedbackId: data.id, text: trimmedComment }).catch(err => {
      console.warn('[FeedbackService] Background severity prediction error:', err);
    });
  }

  return data;
}




/**
 * Check whether a student has already submitted feedback for a specific session
 * @param {string} sessionId
 * @param {string} studentId
 * @returns {Promise<boolean>}
 */
export async function hasStudentSubmittedFeedback(sessionId, studentId) {
  if (!sessionId || !studentId) return false;

  const { data, error } = await supabase
    .from('class_feedback')
    .select('id')
    .eq('session_id', sessionId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) {
    console.error('[FeedbackService] Error checking feedback status:', error);
    return false;
  }

  return !!data;
}

/**
 * Get the total count of feedback submissions for a session
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
export async function getSessionFeedbackCount(sessionId) {
  if (!sessionId) return 0;

  const { count, error } = await supabase
    .from('class_feedback')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);

  if (error) {
    console.error('[FeedbackService] Error counting feedback:', error);
    return 0;
  }

  return count || 0;
}
