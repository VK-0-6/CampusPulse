/**
 * Server-side Sentiment Analysis Handler
 * Executes strictly on the backend/server. Never exposes API keys or PII to the browser.
 */

import { createClient } from '@supabase/supabase-js';

// Fallback rule-based sentiment classifier for academic feedback
export function analyzeSentimentFallback(text) {
  if (!text || typeof text !== 'string') {
    return { sentiment: 'neutral', confidence: 0.70 };
  }

  const lower = text.toLowerCase();

  const positiveWords = [
    'good', 'great', 'excellent', 'helpful', 'clear', 'understood', 'best',
    'easy', 'interesting', 'effective', 'well', 'engaging', 'enjoyed', 'nice',
    'fantastic', 'interactive', 'smooth', 'appreciate', 'thank', 'improved',
    'useful', 'awesome', 'inspiring', 'positive', 'solid'
  ];

  const negativeWords = [
    'bad', 'poor', 'confusing', 'confused', 'difficult', 'hard', 'unclear',
    'fast', 'slow', 'boring', 'worst', 'issue', 'problem', 'broken', 'not working',
    'struggled', 'struggle', 'disorganized', 'lacking', 'frustrated', 'terrible',
    'useless', 'unhelpful', 'negative', 'poorly'
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

  // Negation detection (e.g. "not helpful", "not clear", "never understood", "hard to follow")
  const negationMatches = lower.match(/\b(not|never|no|hardly|barely)\s+(helpful|clear|good|easy|understood|useful|interactive)/gi);
  if (negationMatches) {
    positiveScore -= negationMatches.length * 1.5;
    negativeScore += negationMatches.length * 1.5;
  }

  const difficultyFastMatches = lower.match(/\b(too fast|too hard|too difficult|cannot understand|didn't understand|did not understand)\b/gi);
  if (difficultyFastMatches) {
    negativeScore += difficultyFastMatches.length * 2.0;
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

/**
 * Handle incoming sentiment analysis request
 */
export async function handleSentimentAnalysis(reqBody, headers = {}) {
  const { feedbackId, issueId, text } = reqBody || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, body: { error: 'Written text is required for sentiment analysis.' } };
  }

  if (!feedbackId && !issueId) {
    return { status: 400, body: { error: 'Either feedbackId or issueId must be provided.' } };
  }

  const trimmedText = text.trim();
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  let sentiment = 'neutral';
  let confidence = 0.70;
  let modelProvider = 'academic-nlp-engine';

  if (apiKey) {
    try {
      const prompt = `You are a student feedback sentiment analyzer. Analyze the sentiment of the following academic feedback comment. 
Categorize the sentiment strictly as one of: "positive", "neutral", "negative". 
Also provide a confidence score from 0.0 to 1.0. 
Respond ONLY with a JSON object: {"sentiment": "positive"|"neutral"|"negative", "confidence": 0.95}

Comment: "${trimmedText}"`;

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
          if (['positive', 'neutral', 'negative'].includes(parsed.sentiment)) {
            sentiment = parsed.sentiment;
            confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.90;
            modelProvider = 'google-gemini-1.5-flash';
          }
        }
      } else {
        console.warn('[SentimentServer] Gemini API status:', response.status);
        const fallback = analyzeSentimentFallback(trimmedText);
        sentiment = fallback.sentiment;
        confidence = fallback.confidence;
      }
    } catch (err) {
      console.warn('[SentimentServer] Gemini invocation error, fallback used:', err.message);
      const fallback = analyzeSentimentFallback(trimmedText);
      sentiment = fallback.sentiment;
      confidence = fallback.confidence;
    }
  } else {
    const fallback = analyzeSentimentFallback(trimmedText);
    sentiment = fallback.sentiment;
    confidence = fallback.confidence;
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

      // Attempt to invoke the RPC function
      const { error: rpcErr } = await supabase.rpc('record_feedback_sentiment', {
        p_feedback_id: feedbackId || null,
        p_issue_id: issueId || null,
        p_sentiment: sentiment,
        p_confidence: confidence,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });

      if (rpcErr) {
        console.warn('[SentimentServer] RPC error, attempting direct upsert:', rpcErr.message);
        // Direct upsert fallback
        if (feedbackId) {
          await supabase.from('feedback_sentiment_analysis').upsert({
            feedback_id: feedbackId,
            sentiment,
            confidence,
            model_provider: modelProvider,
            status: 'completed'
          }, { onConflict: 'feedback_id' });
        } else if (issueId) {
          await supabase.from('feedback_sentiment_analysis').upsert({
            issue_id: issueId,
            sentiment,
            confidence,
            model_provider: modelProvider,
            status: 'completed'
          }, { onConflict: 'issue_id' });
        }
      }
    } catch (dbErr) {
      console.error('[SentimentServer] Error saving sentiment result to database:', dbErr);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      sentiment,
      confidence,
      model: modelProvider
    }
  };
}
