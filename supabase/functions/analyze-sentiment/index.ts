// Supabase Edge Function: analyze-sentiment
// Analyzes written student feedback or issue text for sentiment (Positive, Neutral, Negative)
// NO PII (student names, emails, roll numbers) is processed or accepted.
// API Keys are kept strictly on the server in Deno environment variables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Fallback rule-based sentiment classifier for academic feedback
function analyzeSentimentFallback(text: string): { sentiment: 'positive' | 'neutral' | 'negative'; confidence: number } {
  const lower = text.toLowerCase();

  const positiveWords = [
    'good', 'great', 'excellent', 'helpful', 'clear', 'understood', 'best',
    'easy', 'interesting', 'effective', 'well', 'engaging', 'enjoyed', 'nice',
    'fantastic', 'interactive', 'smooth', 'appreciate', 'thank', 'improved'
  ];

  const negativeWords = [
    'bad', 'poor', 'confusing', 'confused', 'difficult', 'hard', 'unclear',
    'fast', 'slow', 'boring', 'worst', 'issue', 'problem', 'broken', 'not working',
    'struggled', 'struggle', 'disorganized', 'lacking', 'frustrated', 'terrible'
  ];

  let positiveScore = 0;
  let negativeScore = 0;

  for (const word of positiveWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = lower.match(regex);
    if (matches) positiveScore += matches.length;
  }

  for (const word of negativeWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = lower.match(regex);
    if (matches) negativeScore += matches.length;
  }

  // Negation detection (e.g. "not helpful", "not clear")
  const negationMatches = lower.match(/\b(not|never|no|hardly|barely)\s+(helpful|clear|good|easy|understood)/gi);
  if (negationMatches) {
    positiveScore -= negationMatches.length * 1.5;
    negativeScore += negationMatches.length * 1.5;
  }

  if (positiveScore > negativeScore) {
    const conf = Math.min(0.95, 0.65 + (positiveScore - negativeScore) * 0.1);
    return { sentiment: 'positive', confidence: parseFloat(conf.toFixed(2)) };
  } else if (negativeScore > positiveScore) {
    const conf = Math.min(0.95, 0.65 + (negativeScore - positiveScore) * 0.1);
    return { sentiment: 'negative', confidence: parseFloat(conf.toFixed(2)) };
  } else {
    return { sentiment: 'neutral', confidence: 0.70 };
  }
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { feedbackId, issueId, text } = await req.json();

    if (!text || typeof text !== 'string' || !text.trim()) {
      return new Response(
        JSON.stringify({ error: "Written text is required for sentiment analysis." }),
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
    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';
    let confidence = 0.70;
    let modelProvider = 'academic-nlp-engine';

    // If Gemini API key is configured, invoke Gemini
    if (apiKey) {
      try {
        const prompt = `You are a student feedback sentiment analyzer. Analyze the sentiment of the following academic feedback comment. 
Categorize the sentiment strictly as one of: "positive", "neutral", "negative". 
Also provide a confidence score from 0.0 to 1.0. 
Respond ONLY with a JSON object: {"sentiment": "positive"|"neutral"|"negative", "confidence": 0.95}

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
            if (['positive', 'neutral', 'negative'].includes(parsed.sentiment)) {
              sentiment = parsed.sentiment;
              confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.90;
              modelProvider = 'google-gemini-1.5-flash';
            }
          }
        } else {
          console.warn("Gemini API call returned status:", geminiRes.status);
          const fallback = analyzeSentimentFallback(trimmedText);
          sentiment = fallback.sentiment;
          confidence = fallback.confidence;
        }
      } catch (geminiErr) {
        console.warn("Gemini API invocation error, using fallback analyzer:", geminiErr);
        const fallback = analyzeSentimentFallback(trimmedText);
        sentiment = fallback.sentiment;
        confidence = fallback.confidence;
      }
    } else {
      const fallback = analyzeSentimentFallback(trimmedText);
      sentiment = fallback.sentiment;
      confidence = fallback.confidence;
    }

    // Save result to Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.rpc('record_feedback_sentiment', {
        p_feedback_id: feedbackId || null,
        p_issue_id: issueId || null,
        p_sentiment: sentiment,
        p_confidence: confidence,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        sentiment,
        confidence,
        model: modelProvider
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Sentiment analysis error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Failed to analyze sentiment." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
