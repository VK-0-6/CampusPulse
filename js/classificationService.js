/**
 * Feedback & Issue Classification Service
 * Coordinates zero-PII classification via server-side / Edge Function endpoints
 * Aggregates classification data for faculty feedback reviews.
 */

import { supabase } from './supabase.js';

export const CLASSIFICATION_LABELS = {
  understanding: { label: 'Understanding', icon: '🧠' },
  teaching_clarity: { label: 'Teaching Clarity', icon: '💡' },
  pace: { label: 'Pace', icon: '⏱️' },
  difficulty: { label: 'Difficulty', icon: '🧩' },
  doubt_resolution: { label: 'Doubt Resolution', icon: '❓' },
  student_suggestion: { label: 'Student Suggestion', icon: '💬' },
  positive_feedback: { label: 'Positive Feedback', icon: '⭐' },
  other: { label: 'Other', icon: '📌' }
};

/**
 * Call the server-side / Edge Function classification endpoint
 * Never sends student personal information (only feedbackId/issueId and raw text).
 * @param {Object} payload
 * @param {string} [payload.feedbackId]
 * @param {string} [payload.issueId]
 * @param {string} payload.text
 * @param {string} [payload.context='feedback'] - 'feedback' | 'issue'
 * @returns {Promise<Object|null>}
 */
async function callClassificationEndpoint({ feedbackId, issueId, text, context = 'feedback' }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const trimmedText = text.trim();

  // Try Supabase Edge Function first
  try {
    const { data, error } = await supabase.functions.invoke('classify-feedback', {
      body: { feedbackId, issueId, text: trimmedText, context }
    });

    if (!error && data?.success) {
      return data;
    }
  } catch (edgeErr) {
    // Edge function not deployed or unreachable in current environment, fallback to server endpoint
  }

  // Fallback to local server-side endpoint (/api/classify-feedback)
  try {
    const session = (await supabase.auth.getSession())?.data?.session;
    const headers = { 'Content-Type': 'application/json' };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const res = await fetch('/api/classify-feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({ feedbackId, issueId, text: trimmedText, context })
    });

    if (res.ok) {
      const result = await res.json();
      return result;
    }
  } catch (serverErr) {
    console.warn('[ClassificationService] Classification endpoint error:', serverErr.message);
  }

  return null;
}

/**
 * Classify a written class feedback comment
 * Runs asynchronously and decoupled; failure never disrupts feedback submission.
 * @param {Object} params
 * @param {string} params.feedbackId - UUID of the class_feedback record
 * @param {string} params.text - Written student comment
 * @returns {Promise<Object|null>}
 */
export async function classifyFeedbackComment({ feedbackId, text }) {
  if (!feedbackId || !text || !text.trim()) {
    return null;
  }

  try {
    return await callClassificationEndpoint({ feedbackId, text, context: 'feedback' });
  } catch (err) {
    console.warn('[ClassificationService] Could not complete classification for comment:', err);
    return null;
  }
}

/**
 * Classify an academic department issue description
 * Runs asynchronously and decoupled; failure never disrupts issue reporting.
 * @param {Object} params
 * @param {string} params.issueId - UUID of the department_issues record
 * @param {string} params.text - Issue description text
 * @returns {Promise<Object|null>}
 */
export async function classifyIssueDescription({ issueId, text }) {
  if (!issueId || !text || !text.trim()) {
    return null;
  }

  try {
    return await callClassificationEndpoint({ issueId, text, context: 'issue' });
  } catch (err) {
    console.warn('[ClassificationService] Could not complete classification for issue:', err);
    return null;
  }
}

/**
 * Get aggregated classification summary for a feedback session
 * Never returns student identities, mappings, or individual student links.
 * @param {string} sessionId - UUID of the session
 * @returns {Promise<Object>} Aggregated classification metrics across categories
 */
export async function getSessionClassificationSummary(sessionId) {
  const defaultCounts = {
    understanding: 0,
    teaching_clarity: 0,
    pace: 0,
    difficulty: 0,
    doubt_resolution: 0,
    student_suggestion: 0,
    positive_feedback: 0,
    other: 0
  };

  const defaultSummary = {
    counts: { ...defaultCounts },
    total: 0,
    hasClassifications: false
  };

  if (!sessionId) return defaultSummary;

  try {
    // 1. Fetch class_feedback IDs for this session
    const { data: feedbacks, error: fbErr } = await supabase
      .from('class_feedback')
      .select('id')
      .eq('session_id', sessionId);

    if (fbErr || !feedbacks || feedbacks.length === 0) {
      return defaultSummary;
    }

    const feedbackIds = feedbacks.map(f => f.id);

    // 2. Fetch classification records for these feedbacks
    const { data: classifications, error: classErr } = await supabase
      .from('feedback_classification')
      .select('category, confidence, model_provider')
      .in('feedback_id', feedbackIds);

    if (classErr || !classifications || classifications.length === 0) {
      return defaultSummary;
    }

    const counts = { ...defaultCounts };
    let total = 0;

    classifications.forEach(c => {
      const cat = (c.category || '').toLowerCase();
      if (counts[cat] !== undefined) {
        counts[cat]++;
        total++;
      } else {
        counts.other++;
        total++;
      }
    });

    return {
      counts,
      total,
      hasClassifications: total > 0
    };
  } catch (err) {
    console.warn('[ClassificationService] Error fetching classification summary:', err);
    return defaultSummary;
  }
}
