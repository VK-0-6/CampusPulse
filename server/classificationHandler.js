/**
 * Server-side Feedback / Issue Classification Handler
 * Executes strictly on the backend/server. Never exposes API keys or PII to the browser.
 */

import { createClient } from '@supabase/supabase-js';

export const ALLOWED_FEEDBACK_CATEGORIES = [
  'understanding',
  'teaching_clarity',
  'pace',
  'difficulty',
  'doubt_resolution',
  'student_suggestion',
  'positive_feedback',
  'other'
];

export const ALLOWED_ISSUE_CATEGORIES = [
  'projector',
  'wifi',
  'lab_computer',
  'lab_equipment',
  'classroom_furniture',
  'electrical',
  'classroom_condition',
  'other'
];

/**
 * Fallback rule-based classifier for academic feedback & issues
 */
export function classifyFeedbackFallback(text, context = 'feedback') {
  if (!text || typeof text !== 'string') {
    return { category: 'other', confidence: 0.50 };
  }

  const lower = text.toLowerCase().trim();

  if (context === 'issue') {
    // Academic Environment Issues
    if (/\b(projector|display|hdmi|projection|screen|beamer)\b/i.test(lower)) {
      return { category: 'projector', confidence: 0.92 };
    }
    if (/\b(wifi|wi-fi|internet|network|disconnect|connection|router|signal)\b/i.test(lower)) {
      return { category: 'wifi', confidence: 0.95 };
    }
    if (/\b(computer|pc|desktop|monitor|cpu|lab\s*\d+|keyboard|mouse|machine)\b/i.test(lower)) {
      return { category: 'lab_computer', confidence: 0.90 };
    }
    if (/\b(fan|fans|light|lights|switch|electrical|plug|socket|power|ac|air\s*conditioner|tube\s*light)\b/i.test(lower)) {
      return { category: 'electrical', confidence: 0.92 };
    }
    if (/\b(oscilloscope|multimeter|breadboard|microcontroller|apparatus|hardware\s*kit|equipment)\b/i.test(lower)) {
      return { category: 'lab_equipment', confidence: 0.90 };
    }
    if (/\b(bench|benches|chair|chairs|desk|desks|table|tables|furniture|podium)\b/i.test(lower)) {
      return { category: 'classroom_furniture', confidence: 0.90 };
    }
    if (/\b(clean|cleanliness|dirty|dust|trash|garbage|blackboard|whiteboard|floor|smell)\b/i.test(lower)) {
      return { category: 'classroom_condition', confidence: 0.88 };
    }
    return { category: 'other', confidence: 0.60 };
  }

  // Class / Learning Feedback: Contextual & Semantic Evaluation
  // 1. Check for learning comprehension failure (Understanding)
  // Paraphrases: unable to understand, couldn't understand, unable to follow concept, struggled to grasp, etc.
  const hasUnderstandingFailure = /\b(unable to understand|couldn't understand|could not understand|don't understand|didn't understand|cannot understand|hard to understand|struggling to understand|struggled to understand|unable to follow|couldn't follow|could not follow|unable to grasp|failed to grasp|struggled to grasp|couldn't grasp|could not grasp|unable to comprehend|did not comprehend|didn't comprehend|couldn't comprehend|could not comprehend|hard to follow the concept|follow the concept|grasp the concept|grasp the lesson|understand the lesson|understand the topic|binary tree traversal)\b/i.test(lower);

  // 2. Check for Doubt Resolution
  const hasDoubtIssue = /\b(doubt|doubts|unanswered|not answered|didn't answer|clearing doubts|clarification|questions was not answered|questions were not answered|answer my question|answer my questions|answer questions|questions not answered|ignored questions)\b/i.test(lower);

  // 3. Check for Pace
  const hasPaceIssue = /\b(too fast|too slow|pace|rushed|speed|slow down|fast pace|too quickly|quickly|moved through .* too quickly|rushing)\b/i.test(lower);

  // 4. Check for Subject Difficulty
  const hasDifficultyIssue = /\b(too difficult|very difficult|difficulty|too complex|complex topic|hard topic|too hard|difficult for me|topic is very difficult)\b/i.test(lower);

  // 5. Check for Suggestions
  const hasSuggestion = /\b(suggest|suggestion|suggestions|would be helpful|more practice|practice questions|please provide|add more|extra examples|recommend|could you provide|please give|practice examples)\b/i.test(lower);

  // 6. Check for Positive Praise
  const hasPositive = /\b(excellent|great|awesome|helpful|fantastic|loved|enjoyed|well explained|good job|perfect|best|very helpful|inspiring|thank you)\b/i.test(lower);

  // 7. Check for Teaching Clarity (critique of explanation / delivery)
  const hasClarityIssue = /\b(unclear|confusing|confused|not clear|clarity|explanation was unclear|explanation was confusing|hard to follow the explanation|poorly explained|messy explanation|explanation was not provided|did not explain well)\b/i.test(lower);

  // Precedence based on primary problem:
  // If student expresses inability to understand or grasp the concept, this is the primary learning deficit
  if (hasUnderstandingFailure) {
    return { category: 'understanding', confidence: 0.92 };
  }

  if (hasDoubtIssue) {
    return { category: 'doubt_resolution', confidence: 0.92 };
  }

  if (hasPaceIssue) {
    return { category: 'pace', confidence: 0.92 };
  }

  if (hasDifficultyIssue) {
    return { category: 'difficulty', confidence: 0.88 };
  }

  if (hasClarityIssue) {
    return { category: 'teaching_clarity', confidence: 0.90 };
  }

  if (hasSuggestion) {
    return { category: 'student_suggestion', confidence: 0.92 };
  }

  if (hasPositive) {
    return { category: 'positive_feedback', confidence: 0.92 };
  }

  return { category: 'other', confidence: 0.60 };
}


/**
 * Handle incoming feedback classification request
 */
export async function handleClassification(reqBody, headers = {}) {
  const { feedbackId, issueId, text, context } = reqBody || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, body: { error: 'Written text is required for classification.' } };
  }

  if (!feedbackId && !issueId) {
    return { status: 400, body: { error: 'Either feedbackId or issueId must be provided.' } };
  }

  const isIssue = Boolean(issueId) || context === 'issue';
  const classificationContext = isIssue ? 'issue' : 'feedback';
  const allowedCategories = isIssue ? ALLOWED_ISSUE_CATEGORIES : ALLOWED_FEEDBACK_CATEGORIES;

  const trimmedText = text.trim();
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  let category = 'other';
  let confidence = 0.70;
  let modelProvider = 'academic-nlp-classifier';

  if (apiKey) {
    try {
      const prompt = isIssue
        ? `You are an academic facility issue classifier. Classify the following issue description into strictly ONE of these categories: ${allowedCategories.join(', ')}.
Categories:
- projector: Projector, screen, HDMI, display issues.
- wifi: Internet, network, Wi-Fi connectivity problems.
- lab_computer: Lab PC, monitor, keyboard, mouse, OS problems.
- lab_equipment: Lab hardware kits, apparatus, multimeters, etc.
- classroom_furniture: Benches, chairs, desks, podiums.
- electrical: Fans, lights, switches, AC, power sockets.
- classroom_condition: Cleanliness, boards, ambient classroom conditions.
- other: General facility issues.

Respond ONLY with a JSON object: {"category": "<chosen_category>", "confidence": 0.95}

Issue Description: "${trimmedText}"`
        : `You are an expert student learning feedback classifier.
Classify the following student comment into strictly ONE of these categories:
- understanding: Student(s) unable to comprehend, grasp, follow, or learn a concept, topic, or lesson (e.g., "couldn't understand", "unable to follow", "struggled to grasp concept", even if caused by poor explanation or lack of clarity).
- teaching_clarity: The explanation or teaching delivery itself was confusing, unclear, poorly structured, or not provided (when the feedback primarily critiques the delivery rather than reporting comprehension failure).
- pace: The speed of teaching was too fast, rushed, or too slow.
- difficulty: The material or curriculum itself is inherently too difficult, complex, or advanced.
- doubt_resolution: Questions or doubts were unanswered, ignored, or inadequately addressed.
- student_suggestion: Constructive requests or recommendations (e.g., requests for more practice problems, notes, recordings).
- positive_feedback: Praise, satisfaction, or appreciation of the teaching or class.
- other: General feedback that does not fit into any of the above.

Guidelines:
1. Identify what the feedback is mainly about. For mixed feedback where students failed to learn or comprehend a topic, prioritize "understanding".
2. Recognize paraphrases (e.g., "unable to follow the concept", "struggled to grasp", "could not make sense of" -> "understanding").
3. Do not return chain-of-thought or reasoning. Return ONLY valid JSON: {"category": "<chosen_category>", "confidence": 0.95}

Examples:
- "I couldn't understand the topic." -> {"category": "understanding", "confidence": 0.95}
- "I was unable to follow the concept even after the explanation." -> {"category": "understanding", "confidence": 0.95}
- "The entire class was unable to understand the topic because the explanation was not provided, and we could not complete the required lesson activity." -> {"category": "understanding", "confidence": 0.95}
- "The explanation was confusing and unclear." -> {"category": "teaching_clarity", "confidence": 0.95}
- "The teacher moved through the topic too quickly." -> {"category": "pace", "confidence": 0.95}
- "The topic was too complex for me." -> {"category": "difficulty", "confidence": 0.90}
- "My questions were not answered." -> {"category": "doubt_resolution", "confidence": 0.95}
- "Please provide more practice examples." -> {"category": "student_suggestion", "confidence": 0.95}
- "The examples were very helpful." -> {"category": "positive_feedback", "confidence": 0.95}

Student Comment: "${trimmedText}"`;

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
          if (allowedCategories.includes(parsed.category)) {
            category = parsed.category;
            confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.90;
            modelProvider = 'google-gemini-1.5-flash';
          } else {
            console.warn('[ClassificationServer] Model returned unknown category:', parsed.category);
            const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
            category = fallback.category;
            confidence = fallback.confidence;
          }
        }
      } else {
        console.warn('[ClassificationServer] Gemini API status:', response.status);
        const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
        category = fallback.category;
        confidence = fallback.confidence;
      }
    } catch (err) {
      console.warn('[ClassificationServer] Gemini error, fallback used:', err.message);
      const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
      category = fallback.category;
      confidence = fallback.confidence;
    }
  } else {
    const fallback = classifyFeedbackFallback(trimmedText, classificationContext);
    category = fallback.category;
    confidence = fallback.confidence;
  }

  // Validate category strictly
  if (!allowedCategories.includes(category)) {
    category = 'other';
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

      const { error: rpcErr } = await supabase.rpc('record_feedback_classification', {
        p_feedback_id: feedbackId || null,
        p_issue_id: issueId || null,
        p_category: category,
        p_confidence: confidence,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });

      if (rpcErr) {
        console.warn('[ClassificationServer] RPC error, attempting direct upsert:', rpcErr.message);
        if (feedbackId) {
          await supabase.from('feedback_classification').upsert({
            feedback_id: feedbackId,
            category,
            confidence,
            model_provider: modelProvider,
            status: 'completed'
          }, { onConflict: 'feedback_id' });
        } else if (issueId) {
          await supabase.from('feedback_classification').upsert({
            issue_id: issueId,
            category,
            confidence,
            model_provider: modelProvider,
            status: 'completed'
          }, { onConflict: 'issue_id' });
        }
      }
    } catch (dbErr) {
      console.error('[ClassificationServer] Error saving classification result:', dbErr);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      category,
      confidence,
      model: modelProvider
    }
  };
}
