/**
 * Server-side Feedback / Issue Severity Prediction Handler
 * Executes strictly on the backend/server. Never exposes API keys or PII to the browser.
 */

import { createClient } from '@supabase/supabase-js';

export const ALLOWED_SEVERITIES = ['low', 'medium', 'high'];

/**
 * Fallback rule-based severity predictor for academic feedback & issues
 */
export function predictSeverityFallback(text, context = 'feedback') {
  if (!text || typeof text !== 'string') {
    return { severity: 'low', confidence: 0.50 };
  }

  const lower = text.toLowerCase().trim();

  // 1. High-impact indicators
  // Widespread scope across student population
  const isWidespread = /\b(entire class|whole class|all students|most students|everyone in class|nobody|no one in class|every student)\b/i.test(lower);

  // Inability to complete required academic work/activity/practical
  const isCompletionBlocked =
    /\b(could not complete|couldn't complete|cannot complete|can't complete|unable to complete|unable to perform|incomplete)\b.*\b(required|activity|practical|lab|assignment|lesson activity|class activity|experiment)\b/i.test(lower) ||
    /\b(required (activity|lesson|practical|lab|assignment|work))\b.*\b(could not be completed|cannot be completed|incomplete|prevented|blocked)\b/i.test(lower) ||
    (/\bcannot complete\b/i.test(lower) && /\bpractical\b/i.test(lower)) ||
    (/\bcould not complete\b/i.test(lower) && /\b(activity|practical|lesson)\b/i.test(lower));

  // Severe learning breakdown
  const isLearningBreakdown = /\b(unable to understand|could not understand|couldn't understand|struggled to understand|cannot understand|unable to follow|couldn't follow|failed to grasp|did not learn|could not learn)\b/i.test(lower);

  // Critical infrastructure failures / outages
  const isCriticalInfraFailure =
    /\b(none of the computers|all computers not working|none of the lab computers|cannot conduct class|cancelled class|canceled class|severe outage|completely unusable)\b/i.test(lower) ||
    (/\bnone of the\b/i.test(lower) && /\b(working|usable|functional)\b/i.test(lower));

  // HIGH: Widespread learning failure, blocked required activities, or total outages
  if (
    isCriticalInfraFailure ||
    isCompletionBlocked ||
    (isWidespread && isLearningBreakdown) ||
    (isWidespread && /\b(could not|couldn't|cannot|unable to|failed to)\b/i.test(lower))
  ) {
    return { severity: 'high', confidence: 0.92 };
  }

  // 2. Low-impact indicators:
  // Minor suggestions, small improvements, slight/cosmetic issues without widespread impact or learning blockage
  const isMinorOrSuggestion = /\b(small suggestion|suggestion for the next class|would be helpful|helpful to have|suggest adding|suggestion|suggestions|minor|slightly dim|slightly unclear|a bit unclear|small improvement|more examples|more practice examples|could be a little|cosmetic)\b/i.test(lower);

  // Notice: Pacing issue ("a little too fast") affects comprehension and should be medium
  const isPacingIssue = /\b(too fast|too slow|too quickly|fast pace|slow down|rushed)\b/i.test(lower);
  const isNoticeableLearningIssue = isLearningBreakdown || /\b(confusing|confused|hard to follow|struggling to follow|cannot follow|unanswered|questions were not answered|difficult for me|difficulty|too complex)\b/i.test(lower);
  const isNoticeableInfraIssue = /\b(disconnecting|keeps disconnecting|disconnecting during class|frequent disconnection|not working properly)\b/i.test(lower);

  if (isMinorOrSuggestion && !isPacingIssue && !isNoticeableLearningIssue) {
    return { severity: 'low', confidence: 0.88 };
  }

  // 3. Medium-impact indicators:
  // Noticeable learning/pacing/clarity issues or operational problems affecting normal flow
  if (isPacingIssue || isNoticeableLearningIssue || isNoticeableInfraIssue) {
    return { severity: 'medium', confidence: 0.85 };
  }

  return { severity: 'low', confidence: 0.70 };
}

/**
 * Handle incoming severity prediction request
 */
export async function handleSeverityPrediction(reqBody, headers = {}) {
  const { feedbackId, issueId, text, context } = reqBody || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, body: { error: 'Written text is required for severity prediction.' } };
  }

  if (!feedbackId && !issueId) {
    return { status: 400, body: { error: 'Either feedbackId or issueId must be provided.' } };
  }

  const trimmedText = text.trim();
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  let severity = 'low';
  let confidence = 0.75;
  let modelProvider = 'academic-severity-engine';

  if (apiKey) {
    try {
      const prompt = `You are an academic feedback severity analyzer.
Evaluate the severity of the problem reported in the feedback based strictly on ACADEMIC IMPACT, SCOPE, and CONSEQUENCES:
- low: Minor issue, small suggestion, minor inconvenience, or slight imperfection that does not disrupt academic progress (e.g., suggestions for examples, slightly dim projector, minor clarity tweak).
- medium: Noticeable problem affecting an individual or small group's understanding, pacing, or normal learning experience, but without widespread academic failure or stoppage of required work (e.g., student couldn't understand a topic, Wi-Fi disconnecting, explanation was a little fast).
- high: Serious disruption that significantly affects learning or academic activity, widespread impact (entire class, most students), or failure to complete required academic work/practicals (e.g., entire class unable to understand, unable to complete required activity, lab computers completely down).

Guidelines:
1. Consider Scope: Is the issue isolated to one student ("I had trouble") or widespread across the class ("entire class", "most students")?
2. Consider Consequences: Did it prevent students from completing required lessons, activities, or practicals?
3. Consider Impact: Is it an optional suggestion (low), a learning difficulty (medium), or a severe breakdown of learning (high)?
4. Do NOT classify as high merely because negative words appear. High requires severe academic consequence or widespread impact.
5. Return ONLY valid JSON: {"severity": "low"|"medium"|"high", "confidence": 0.88}

Examples:
- "I had a small suggestion for the next class." -> {"severity": "low", "confidence": 0.90}
- "It would be helpful to have more examples." -> {"severity": "low", "confidence": 0.88}
- "The explanation was slightly unclear." -> {"severity": "low", "confidence": 0.88}
- "The projector is slightly dim." -> {"severity": "low", "confidence": 0.88}
- "I couldn't understand one part of the topic." -> {"severity": "medium", "confidence": 0.85}
- "The explanation was a little too fast." -> {"severity": "medium", "confidence": 0.85}
- "The Wi-Fi keeps disconnecting during class." -> {"severity": "medium", "confidence": 0.85}
- "I couldn't understand the topic even after the explanation." -> {"severity": "medium", "confidence": 0.85}
- "The entire class was unable to understand the topic." -> {"severity": "high", "confidence": 0.95}
- "Most students could not complete the required activity." -> {"severity": "high", "confidence": 0.95}
- "The entire class could not complete the required practical activity." -> {"severity": "high", "confidence": 0.95}
- "None of the computers in the lab are working and we cannot complete the practical." -> {"severity": "high", "confidence": 0.95}
- "The entire class was unable to understand the topic because the explanation was not provided, and we could not complete the required lesson activity." -> {"severity": "high", "confidence": 0.95}

Feedback Text: "${trimmedText}"`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        }
      );

      if (response.ok) {
        const data = await response.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (ALLOWED_SEVERITIES.includes(parsed.severity)) {
            severity = parsed.severity;
            confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.85;
            modelProvider = 'google-gemini-1.5-flash';
          } else {
            console.warn('[SeverityServer] Model returned unknown severity:', parsed.severity);
            const fallback = predictSeverityFallback(trimmedText, context);
            severity = fallback.severity;
            confidence = fallback.confidence;
          }
        }
      } else {
        console.warn('[SeverityServer] Gemini API status:', response.status);
        const fallback = predictSeverityFallback(trimmedText, context);
        severity = fallback.severity;
        confidence = fallback.confidence;
      }
    } catch (err) {
      console.warn('[SeverityServer] Gemini error, fallback used:', err.message);
      const fallback = predictSeverityFallback(trimmedText, context);
      severity = fallback.severity;
      confidence = fallback.confidence;
    }
  } else {
    const fallback = predictSeverityFallback(trimmedText, context);
    severity = fallback.severity;
    confidence = fallback.confidence;
  }

  // Validate severity strictly
  if (!ALLOWED_SEVERITIES.includes(severity)) {
    severity = 'low';
  }

  // Persist into Supabase
  const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ebenxdbvtgmfbszplkyt.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const clientOptions = {};
      const authHeader = headers['authorization'] || headers['Authorization'];
      if (authHeader) {
        clientOptions.global = { headers: { Authorization: authHeader } };
      }

      const supabase = createClient(supabaseUrl, supabaseKey, clientOptions);

      const { error: rpcErr } = await supabase.rpc('record_feedback_severity', {
        p_feedback_id: feedbackId || null,
        p_issue_id: issueId || null,
        p_severity: severity,
        p_confidence: confidence,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });

      if (rpcErr) {
        console.warn('[SeverityServer] RPC error, attempting direct upsert:', rpcErr.message);
        if (feedbackId) {
          await supabase.from('feedback_severity').upsert({
            feedback_id: feedbackId,
            severity,
            confidence,
            model_provider: modelProvider,
            status: 'completed'
          }, { onConflict: 'feedback_id' });
        } else if (issueId) {
          await supabase.from('feedback_severity').upsert({
            issue_id: issueId,
            severity,
            confidence,
            model_provider: modelProvider,
            status: 'completed'
          }, { onConflict: 'issue_id' });
        }
      }
    } catch (dbErr) {
      console.error('[SeverityServer] Error saving severity result:', dbErr);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      severity,
      confidence,
      model: modelProvider
    }
  };
}
