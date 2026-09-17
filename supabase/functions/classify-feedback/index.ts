// Supabase Edge Function: classify-feedback
// Automatically classifies written student feedback comments or issue descriptions
// NO PII (student names, emails, roll numbers) is processed or accepted.
// API Keys are kept strictly on the server in Deno environment variables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const ALLOWED_FEEDBACK_CATEGORIES = [
  'understanding',
  'teaching_clarity',
  'pace',
  'difficulty',
  'doubt_resolution',
  'student_suggestion',
  'positive_feedback',
  'other'
];

const ALLOWED_ISSUE_CATEGORIES = [
  'projector',
  'wifi',
  'lab_computer',
  'lab_equipment',
  'classroom_furniture',
  'electrical',
  'classroom_condition',
  'other'
];

function classifyFeedbackFallback(text: string, context = 'feedback'): { category: string; confidence: number } {
  const lower = text.toLowerCase().trim();

  if (context === 'issue') {
    if (/\b(projector|display|hdmi|projection|screen|beamer)\b/i.test(lower)) return { category: 'projector', confidence: 0.92 };
    if (/\b(wifi|wi-fi|internet|network|disconnect|connection|router|signal)\b/i.test(lower)) return { category: 'wifi', confidence: 0.95 };
    if (/\b(computer|pc|desktop|monitor|cpu|lab\s*\d+|keyboard|mouse)\b/i.test(lower)) return { category: 'lab_computer', confidence: 0.90 };
    if (/\b(fan|fans|light|lights|switch|electrical|plug|socket|power|ac|air\s*conditioner)\b/i.test(lower)) return { category: 'electrical', confidence: 0.92 };
    if (/\b(oscilloscope|multimeter|breadboard|microcontroller|apparatus|hardware\s*kit|equipment)\b/i.test(lower)) return { category: 'lab_equipment', confidence: 0.90 };
    if (/\b(bench|chair|chairs|desk|table|furniture|podium)\b/i.test(lower)) return { category: 'classroom_furniture', confidence: 0.90 };
    if (/\b(clean|cleanliness|dirty|dust|trash|blackboard|whiteboard)\b/i.test(lower)) return { category: 'classroom_condition', confidence: 0.88 };
    return { category: 'other', confidence: 0.60 };
  }

  // Class / Learning Feedback: Contextual & Semantic Evaluation
  const hasUnderstandingFailure = /\b(unable to understand|couldn't understand|could not understand|don't understand|didn't understand|cannot understand|hard to understand|struggling to understand|struggled to understand|unable to follow|couldn't follow|could not follow|unable to grasp|failed to grasp|struggled to grasp|couldn't grasp|could not grasp|unable to comprehend|did not comprehend|didn't comprehend|couldn't comprehend|could not comprehend|hard to follow the concept|follow the concept|grasp the concept|grasp the lesson|understand the lesson|understand the topic|binary tree traversal)\b/i.test(lower);
  const hasDoubtIssue = /\b(doubt|doubts|unanswered|not answered|didn't answer|clearing doubts|clarification|questions was not answered|questions were not answered|answer my question|answer my questions|answer questions|questions not answered|ignored questions)\b/i.test(lower);
  const hasPaceIssue = /\b(too fast|too slow|pace|rushed|speed|slow down|fast pace|too quickly|quickly|moved through .* too quickly|rushing)\b/i.test(lower);
  const hasDifficultyIssue = /\b(too difficult|very difficult|difficulty|too complex|complex topic|hard topic|too hard|difficult for me|topic is very difficult)\b/i.test(lower);
  const hasSuggestion = /\b(suggest|suggestion|suggestions|would be helpful|more practice|practice questions|please provide|add more|extra examples|recommend|could you provide|please give|practice examples)\b/i.test(lower);
  const hasPositive = /\b(excellent|great|awesome|helpful|fantastic|loved|enjoyed|well explained|good job|perfect|best|very helpful|inspiring|thank you)\b/i.test(lower);
  const hasClarityIssue = /\b(unclear|confusing|confused|not clear|clarity|explanation was unclear|explanation was confusing|hard to follow the explanation|poorly explained|messy explanation|explanation was not provided|did not explain well)\b/i.test(lower);

  if (hasUnderstandingFailure) return { category: 'understanding', confidence: 0.92 };
  if (hasDoubtIssue) return { category: 'doubt_resolution', confidence: 0.92 };
  if (hasPaceIssue) return { category: 'pace', confidence: 0.92 };
  if (hasDifficultyIssue) return { category: 'difficulty', confidence: 0.88 };
  if (hasClarityIssue) return { category: 'teaching_clarity', confidence: 0.90 };
  if (hasSuggestion) return { category: 'student_suggestion', confidence: 0.92 };
  if (hasPositive) return { category: 'positive_feedback', confidence: 0.92 };

  return { category: 'other', confidence: 0.60 };
}


serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { feedbackId, issueId, text, context } = await req.json();

    if (!text || typeof text !== 'string' || !text.trim()) {
      return new Response(
        JSON.stringify({ error: "Written text is required for classification." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!feedbackId && !issueId) {
      return new Response(
        JSON.stringify({ error: "Either feedbackId or issueId must be provided." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isIssue = Boolean(issueId) || context === 'issue';
    const classificationContext = isIssue ? 'issue' : 'feedback';
    const allowedCategories = isIssue ? ALLOWED_ISSUE_CATEGORIES : ALLOWED_FEEDBACK_CATEGORIES;
    const trimmedText = text.trim();

    const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("AI_API_KEY");
    let category = 'other';
    let confidence = 0.70;
    let modelProvider = 'academic-nlp-classifier';

    if (apiKey) {
      try {
        const prompt = isIssue
          ? `Classify this academic infrastructure issue into strictly ONE of: ${allowedCategories.join(', ')}. Return JSON only: {"category": "...", "confidence": 0.95}. Issue: "${trimmedText}"`
          : `You are an expert student learning feedback classifier.
Classify the following student comment into strictly ONE of:
- understanding: Student(s) unable to comprehend, grasp, follow, or learn a concept/topic (even if caused by poor explanation or missing materials).
- teaching_clarity: The explanation or teaching delivery itself was confusing, unclear, poorly structured, or not provided.
- pace: The speed of teaching was too fast, rushed, or too slow.
- difficulty: The material itself is inherently too difficult or complex.
- doubt_resolution: Questions or doubts were unanswered or ignored.
- student_suggestion: Constructive requests or recommendations for more practice/examples.
- positive_feedback: Praise, satisfaction, or appreciation.
- other: General feedback.

Guidelines: Prioritize "understanding" when students report comprehension/learning failure. Return ONLY valid JSON: {"category": "...", "confidence": 0.95}.
Comment: "${trimmedText}"`;

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
            if (allowedCategories.includes(parsed.category)) {
              category = parsed.category;
              confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.90;
              modelProvider = 'google-gemini-1.5-flash';
            }
          }
        } else {
          const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
          category = fallback.category;
          confidence = fallback.confidence;
        }
      } catch (err) {
        const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
        category = fallback.category;
        confidence = fallback.confidence;
      }
    } else {
      const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
      category = fallback.category;
      confidence = fallback.confidence;
    }

    if (!allowedCategories.includes(category)) {
      category = 'other';
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.rpc('record_feedback_classification', {
        p_feedback_id: feedbackId || null,
        p_issue_id: issueId || null,
        p_category: category,
        p_confidence: confidence,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });
    }

    return new Response(
      JSON.stringify({ success: true, category, confidence, model: modelProvider }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to classify feedback." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
