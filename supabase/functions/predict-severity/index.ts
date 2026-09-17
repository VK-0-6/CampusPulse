// Supabase Edge Function: predict-severity
// Automatically predicts severity (low, medium, high) for written student feedback comments or issue descriptions
// NO PII (student names, emails, roll numbers) is processed or accepted.
// API Keys are kept strictly on the server in Deno environment variables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const ALLOWED_SEVERITIES = ['low', 'medium', 'high'];

function predictSeverityFallback(text: string, context = 'feedback'): { severity: 'low' | 'medium' | 'high'; confidence: number } {
  const lower = text.toLowerCase().trim();

  // 1. High-impact indicators
  const isWidespread = /\b(entire class|whole class|all students|most students|everyone in class|nobody|no one in class|every student)\b/i.test(lower);
  const isCompletionBlocked =
    /\b(could not complete|couldn't complete|cannot complete|can't complete|unable to complete|unable to perform|incomplete)\b.*\b(required|activity|practical|lab|assignment|lesson activity|class activity|experiment)\b/i.test(lower) ||
    /\b(required (activity|lesson|practical|lab|assignment|work))\b.*\b(could not be completed|cannot be completed|incomplete|prevented|blocked)\b/i.test(lower) ||
    (/\bcannot complete\b/i.test(lower) && /\bpractical\b/i.test(lower)) ||
    (/\bcould not complete\b/i.test(lower) && /\b(activity|practical|lesson)\b/i.test(lower));
  const isLearningBreakdown = /\b(unable to understand|could not understand|couldn't understand|struggled to understand|cannot understand|unable to follow|couldn't follow|failed to grasp|did not learn|could not learn)\b/i.test(lower);
  const isCriticalInfraFailure =
    /\b(none of the computers|all computers not working|none of the lab computers|cannot conduct class|cancelled class|canceled class|severe outage|completely unusable)\b/i.test(lower) ||
    (/\bnone of the\b/i.test(lower) && /\b(working|usable|functional)\b/i.test(lower));

  if (
    isCriticalInfraFailure ||
    isCompletionBlocked ||
    (isWidespread && isLearningBreakdown) ||
    (isWidespread && /\b(could not|couldn't|cannot|unable to|failed to)\b/i.test(lower))
  ) {
    return { severity: 'high', confidence: 0.92 };
  }

  // 2. Low-impact indicators
  const isMinorOrSuggestion = /\b(small suggestion|suggestion for the next class|would be helpful|helpful to have|suggest adding|suggestion|suggestions|minor|slightly dim|slightly unclear|a bit unclear|small improvement|more examples|more practice examples|could be a little|cosmetic)\b/i.test(lower);
  const isPacingIssue = /\b(too fast|too slow|too quickly|fast pace|slow down|rushed)\b/i.test(lower);
  const isNoticeableLearningIssue = isLearningBreakdown || /\b(confusing|confused|hard to follow|struggling to follow|cannot follow|unanswered|questions were not answered|difficult for me|difficulty|too complex)\b/i.test(lower);
  const isNoticeableInfraIssue = /\b(disconnecting|keeps disconnecting|disconnecting during class|frequent disconnection|not working properly)\b/i.test(lower);

  if (isMinorOrSuggestion && !isPacingIssue && !isNoticeableLearningIssue) {
    return { severity: 'low', confidence: 0.88 };
  }

  // 3. Medium-impact indicators
  if (isPacingIssue || isNoticeableLearningIssue || isNoticeableInfraIssue) {
    return { severity: 'medium', confidence: 0.85 };
  }

  return { severity: 'low', confidence: 0.70 };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { feedbackId, issueId, text, context } = await req.json();

    if (!text || typeof text !== 'string' || !text.trim()) {
      return new Response(
        JSON.stringify({ error: "Written text is required for severity prediction." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!feedbackId && !issueId) {
      return new Response(
        JSON.stringify({ error: "Either feedbackId or issueId must be provided." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const trimmedText = text.trim();
    const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("AI_API_KEY");
    let severity: 'low' | 'medium' | 'high' = 'low';
    let confidence = 0.75;
    let modelProvider = 'academic-severity-engine';

    if (apiKey) {
      try {
        const prompt = `You are an academic feedback severity analyzer.
Evaluate the severity of the problem reported in the feedback based strictly on ACADEMIC IMPACT, SCOPE, and CONSEQUENCES:
- low: Minor issue, small suggestion, minor inconvenience, or slight imperfection that does not disrupt academic progress (e.g., suggestions for examples, slightly dim projector, minor clarity tweak).
- medium: Noticeable problem affecting an individual or small group's understanding, pacing, or normal learning experience, but without widespread academic failure or stoppage of required work (e.g., student couldn't understand a topic, Wi-Fi disconnecting, explanation was a little fast).
- high: Serious disruption that significantly affects learning or academic activity, widespread impact (entire class, most students), or failure to complete required academic work/practicals (e.g., entire class unable to understand, unable to complete required activity, lab computers completely down).

Guidelines: Prioritize "high" for widespread impact or blocked completion of required activities. Return ONLY valid JSON: {"severity": "low"|"medium"|"high", "confidence": 0.88}.
Text: "${trimmedText}"`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json" }
            })
          }
        );

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const rawResponseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawResponseText) {
            const parsed = JSON.parse(rawResponseText);
            if (ALLOWED_SEVERITIES.includes(parsed.severity)) {
              severity = parsed.severity;
              confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.85;
              modelProvider = 'google-gemini-1.5-flash';
            }
          }
        } else {
          const fallback = predictSeverityFallback(trimmedText, context);
          severity = fallback.severity;
          confidence = fallback.confidence;
        }
      } catch (err) {
        const fallback = predictSeverityFallback(trimmedText, context);
        severity = fallback.severity;
        confidence = fallback.confidence;
      }
    } else {
      const fallback = predictSeverityFallback(trimmedText, context);
      severity = fallback.severity;
      confidence = fallback.confidence;
    }

    if (!ALLOWED_SEVERITIES.includes(severity)) {
      severity = 'low';
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.rpc('record_feedback_severity', {
        p_feedback_id: feedbackId || null,
        p_issue_id: issueId || null,
        p_severity: severity,
        p_confidence: confidence,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });
    }

    return new Response(
      JSON.stringify({ success: true, severity, confidence, model: modelProvider }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to predict severity." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
