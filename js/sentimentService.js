/**
 * Sentiment Analysis Service
 * Coordinates zero-PII sentiment analysis via server-side / Edge Function endpoints
 * Aggregates sentiment data for faculty and department reviews.
 */

import { supabase } from './supabase.js';

/**
 * Call the server-side / Edge Function sentiment endpoint
 * Never sends student personal information (only feedbackId/issueId and raw text).
 * @param {Object} payload
 * @param {string} [payload.feedbackId]
 * @param {string} [payload.issueId]
 * @param {string} payload.text
 * @returns {Promise<Object|null>}
 */
async function callSentimentEndpoint({ feedbackId, issueId, text }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const trimmedText = text.trim();

  // Try Supabase Edge Function first
  try {
    const { data, error } = await supabase.functions.invoke('analyze-sentiment', {
      body: { feedbackId, issueId, text: trimmedText }
    });

    if (!error && data?.success) {
      return data;
    }
  } catch (edgeErr) {
    // Edge function not deployed or unreachable in current environment, fallback to server endpoint
  }

  // Fallback to local server-side endpoint (/api/analyze-sentiment)
  try {
    const session = (await supabase.auth.getSession())?.data?.session;
    const headers = { 'Content-Type': 'application/json' };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const res = await fetch('/api/analyze-sentiment', {
      method: 'POST',
      headers,
      body: JSON.stringify({ feedbackId, issueId, text: trimmedText })
    });

    if (res.ok) {
      const result = await res.json();
      return result;
    }
  } catch (serverErr) {
    console.warn('[SentimentService] Sentiment analysis endpoint error:', serverErr.message);
  }

  return null;
}

/**
 * Analyze sentiment for a written class feedback comment
 * Runs asynchronously and decoupled; failure never disrupts feedback submission.
 * @param {Object} params
 * @param {string} params.feedbackId - UUID of the class_feedback record
 * @param {string} params.text - Written student comment/suggestion
 * @returns {Promise<Object|null>}
 */
export async function analyzeFeedbackComment({ feedbackId, text }) {
  if (!feedbackId || !text || !text.trim()) {
    return null;
  }

  try {
    return await callSentimentEndpoint({ feedbackId, text });
  } catch (err) {
    console.warn('[SentimentService] Could not complete sentiment analysis for comment:', err);
    return null;
  }
}

/**
 * Analyze sentiment for an academic department issue description
 * Runs asynchronously and decoupled; failure never disrupts issue reporting.
 * @param {Object} params
 * @param {string} params.issueId - UUID of the department_issues record
 * @param {string} params.text - Issue description text
 * @returns {Promise<Object|null>}
 */
export async function analyzeIssueDescription({ issueId, text }) {
  if (!issueId || !text || !text.trim()) {
    return null;
  }

  try {
    return await callSentimentEndpoint({ issueId, text });
  } catch (err) {
    console.warn('[SentimentService] Could not complete sentiment analysis for issue:', err);
    return null;
  }
}

/**
 * Get aggregated sentiment summary for a feedback session
 * Never returns student identities, mappings, or individual student links.
 * @param {string} sessionId - UUID of the session
 * @returns {Promise<Object>} Aggregated sentiment metrics
 */
export async function getSessionSentimentSummary(sessionId) {
  const defaultSummary = {
    positive: 0,
    neutral: 0,
    negative: 0,
    total: 0,
    overallSentiment: 'No comments analyzed',
    isLimited: false,
    hasAnalysis: false
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

    // 2. Fetch sentiment records for these feedbacks
    const { data: sentiments, error: sentErr } = await supabase
      .from('feedback_sentiment_analysis')
      .select('sentiment, confidence, model_provider')
      .in('feedback_id', feedbackIds);

    if (sentErr || !sentiments || sentiments.length === 0) {
      return defaultSummary;
    }

    let positive = 0;
    let neutral = 0;
    let negative = 0;

    sentiments.forEach(s => {
      const normalized = (s.sentiment || '').toLowerCase();
      if (normalized === 'positive') positive++;
      else if (normalized === 'negative') negative++;
      else neutral++;
    });

    const total = sentiments.length;
    let overallSentiment = 'Neutral';

    if (total > 0) {
      if (positive > negative && positive >= neutral) {
        overallSentiment = positive / total >= 0.5 ? 'Mostly Positive' : 'Leaning Positive';
      } else if (negative > positive && negative >= neutral) {
        overallSentiment = negative / total >= 0.5 ? 'Mostly Negative' : 'Leaning Negative';
      } else if (neutral >= positive && neutral >= negative) {
        overallSentiment = 'Neutral / Balanced';
      } else {
        overallSentiment = 'Mixed';
      }
    }

    return {
      positive,
      neutral,
      negative,
      total,
      overallSentiment,
      isLimited: total > 0 && total < 3,
      hasAnalysis: total > 0
    };
  } catch (err) {
    console.warn('[SentimentService] Error fetching sentiment summary:', err);
    return defaultSummary;
  }
}
