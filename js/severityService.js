/**
 * Severity Prediction Service
 * Coordinates zero-PII severity prediction via server-side / Edge Function endpoints
 * Aggregates severity data for faculty feedback reviews.
 */

import { supabase } from './supabase.js';

export const SEVERITY_LEVELS = {
  low: { label: 'Low', badgeClass: 'badge-success', color: '#059669', icon: '🟢' },
  medium: { label: 'Medium', badgeClass: 'badge-warning', color: '#d97706', icon: '🟡' },
  high: { label: 'High', badgeClass: 'badge-danger', color: '#dc2626', icon: '🔴' }
};

/**
 * Call the server-side / Edge Function severity endpoint
 * Never sends student personal information (only feedbackId/issueId and raw text).
 * @param {Object} payload
 * @param {string} [payload.feedbackId]
 * @param {string} [payload.issueId]
 * @param {string} payload.text
 * @param {string} [payload.context='feedback']
 * @returns {Promise<Object|null>}
 */
async function callSeverityEndpoint({ feedbackId, issueId, text, context = 'feedback' }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const trimmedText = text.trim();

  // Try Supabase Edge Function first
  try {
    const { data, error } = await supabase.functions.invoke('predict-severity', {
      body: { feedbackId, issueId, text: trimmedText, context }
    });

    if (!error && data?.success) {
      return data;
    }
  } catch (edgeErr) {
    // Edge function not deployed or unreachable in current environment, fallback to server endpoint
  }

  // Fallback to local server-side endpoint (/api/predict-severity)
  try {
    const session = (await supabase.auth.getSession())?.data?.session;
    const headers = { 'Content-Type': 'application/json' };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const res = await fetch('/api/predict-severity', {
      method: 'POST',
      headers,
      body: JSON.stringify({ feedbackId, issueId, text: trimmedText, context })
    });

    if (res.ok) {
      const result = await res.json();
      return result;
    }
  } catch (serverErr) {
    console.warn('[SeverityService] Severity endpoint error:', serverErr.message);
  }

  return null;
}

/**
 * Predict severity for a written class feedback comment
 * Runs asynchronously and decoupled; failure never disrupts feedback submission.
 * @param {Object} params
 * @param {string} params.feedbackId - UUID of the class_feedback record
 * @param {string} params.text - Written student comment
 * @returns {Promise<Object|null>}
 */
export async function predictFeedbackSeverity({ feedbackId, text }) {
  if (!feedbackId || !text || !text.trim()) {
    return null;
  }

  try {
    return await callSeverityEndpoint({ feedbackId, text, context: 'feedback' });
  } catch (err) {
    console.warn('[SeverityService] Could not complete severity prediction for comment:', err);
    return null;
  }
}

/**
 * Predict severity for an academic department issue description
 * Runs asynchronously and decoupled; failure never disrupts issue reporting.
 * @param {Object} params
 * @param {string} params.issueId - UUID of the department_issues record
 * @param {string} params.text - Issue description text
 * @returns {Promise<Object|null>}
 */
export async function predictIssueSeverity({ issueId, text }) {
  if (!issueId || !text || !text.trim()) {
    return null;
  }

  try {
    return await callSeverityEndpoint({ issueId, text, context: 'issue' });
  } catch (err) {
    console.warn('[SeverityService] Could not complete severity prediction for issue:', err);
    return null;
  }
}

/**
 * Get aggregated severity summary for a feedback session
 * Never returns student identities, mappings, or individual student links.
 * @param {string} sessionId - UUID of the session
 * @returns {Promise<Object>} Aggregated severity metrics
 */
export async function getSessionSeveritySummary(sessionId) {
  const defaultSummary = {
    counts: {
      low: 0,
      medium: 0,
      high: 0
    },
    total: 0,
    hasSeverities: false,
    isLimited: false
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

    // 2. Fetch severity records for these feedbacks
    const { data: severities, error: sevErr } = await supabase
      .from('feedback_severity')
      .select('severity, confidence, model_provider')
      .in('feedback_id', feedbackIds);

    if (sevErr || !severities || severities.length === 0) {
      return defaultSummary;
    }

    const counts = { low: 0, medium: 0, high: 0 };
    let total = 0;

    severities.forEach(s => {
      const level = (s.severity || '').toLowerCase();
      if (counts[level] !== undefined) {
        counts[level]++;
        total++;
      } else {
        counts.low++;
        total++;
      }
    });

    return {
      counts,
      total,
      hasSeverities: total > 0,
      isLimited: total > 0 && total < 3
    };
  } catch (err) {
    console.warn('[SeverityService] Error fetching severity summary:', err);
    return defaultSummary;
  }
}
