/**
 * Server-side Department Issue Similarity Detection Handler (Phase 6.1)
 * Executes strictly on backend/server. Never exposes API keys or PII to client.
 */

import { createClient } from '@supabase/supabase-js';

export const SIMILARITY_THRESHOLD = 0.75;
export const ALLOWED_RELATIONSHIPS = ['similar', 'not_similar'];

/**
 * Normalizes text for comparison
 */
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9s]/g, ' ')
    .replace(/s+/g, ' ')
    .trim();
}

/**
 * Extracts normalized location tokens (e.g. "lab 2", "room 204")
 */
function extractLocation(locStr, descStr) {
  const combined = (locStr + ' ' + descStr).toLowerCase();
  const roomMatch = combined.match(/\b(room|lab|hall|block|auditorium)\s*([a-z0-9-]+)/i);
  if (roomMatch) {
    return (roomMatch[1] + ' ' + roomMatch[2]).toLowerCase();
  }
  if (/\b(computer lab|comp lab)\b/i.test(combined)) return 'computer lab';
  if (/\b(lab)\b/i.test(combined)) return 'lab';
  return (locStr || '').toLowerCase().trim();
}

/**
 * Fallback rule-based similarity analyzer
 */
export function analyzeSimilarityFallback(issueA, issueB) {
  const descA = typeof issueA === 'string' ? issueA : (issueA?.description || '');
  const descB = typeof issueB === 'string' ? issueB : (issueB?.description || '');

  if (!descA.trim() || !descB.trim()) {
    return { similar: false, similarity_score: 0.00 };
  }

  const catA = (typeof issueA === 'object' && issueA?.category ? issueA.category : '').toLowerCase();
  const catB = (typeof issueB === 'object' && issueB?.category ? issueB.category : '').toLowerCase();

  const rawLocA = (typeof issueA === 'object' && issueA?.location ? issueA.location : '');
  const rawLocB = (typeof issueB === 'object' && issueB?.location ? issueB.location : '');

  const normDescA = normalizeText(descA);
  const normDescB = normalizeText(descB);

  // 1. Cross-category incompatibility check
  // E.g. projector vs classroom chairs, or lab computers vs electrical lights
  const isChairsA = /\b(chair|chairs|bench|furniture|desk)\b/i.test(descA) || catA === 'classroom_furniture';
  const isChairsB = /\b(chair|chairs|bench|furniture|desk)\b/i.test(descB) || catB === 'classroom_furniture';
  const isProjectorA = /\b(projector|display|projection|screen)\b/i.test(descA) || catA === 'projector';
  const isProjectorB = /\b(projector|display|projection|screen)\b/i.test(descB) || catB === 'projector';
  const isComputerA = /\b(computer|computers|pc|pcs|desktop)\b/i.test(descA) || catA === 'lab_computer';
  const isComputerB = /\b(computer|computers|pc|pcs|desktop)\b/i.test(descB) || catB === 'lab_computer';
  const isLightsA = /\b(light|lights|fan|fans|bulb|electrical)\b/i.test(descA) || catA === 'electrical';
  const isLightsB = /\b(light|lights|fan|fans|bulb|electrical)\b/i.test(descB) || catB === 'electrical';
  const isWifiA = /\b(wifi|wi fi|internet|network|connection)\b/i.test(descA) || catA === 'wifi';
  const isWifiB = /\b(wifi|wi fi|internet|network|connection)\b/i.test(descB) || catB === 'wifi';

  if ((isProjectorA && isChairsB) || (isChairsA && isProjectorB)) {
    return { similar: false, similarity_score: 0.10 };
  }
  if ((isComputerA && isLightsB) || (isLightsA && isComputerB)) {
    return { similar: false, similarity_score: 0.10 };
  }
  if ((isWifiA && isChairsB) || (isChairsA && isWifiB)) {
    return { similar: false, similarity_score: 0.05 };
  }

  // 2. Specific defect concept checks within same domain
  // A. Wi-Fi / Internet: Disconnection vs Slowness
  if (isWifiA && isWifiB) {
    const isDisconnectA = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|drops repeatedly|keeps dropping|cuts out|lost connection)\b/i.test(descA);
    const isDisconnectB = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|drops repeatedly|keeps dropping|cuts out|lost connection)\b/i.test(descB);

    const isSlowA = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descA);
    const isSlowB = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descB);

    // One is disconnect and one is slow -> distinct problems, NOT similar
    if ((isDisconnectA && isSlowB) || (isSlowA && isDisconnectB)) {
      return { similar: false, similarity_score: 0.55 };
    }

    // Both are disconnect/unstable -> highly similar
    if (isDisconnectA && isDisconnectB) {
      return { similar: true, similarity_score: 0.90 };
    }

    // Both are slow -> highly similar
    if (isSlowA && isSlowB) {
      return { similar: true, similarity_score: 0.88 };
    }
  }

  // B. Projector / Display: Blank / no display vs other
  if (isProjectorA && isProjectorB) {
    const isBlankA = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen|flicker|flickering|stops displaying|turns off|malfunction|malfunctioning|not working)\b/i.test(descA);
    const isBlankB = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen|flicker|flickering|stops displaying|turns off|malfunction|malfunctioning|not working)\b/i.test(descB);

    if (isBlankA && isBlankB) {
      // Check location match if available
      const locA = extractLocation(rawLocA, descA);
      const locB = extractLocation(rawLocB, descB);
      if (locA && locB && locA !== locB && !locA.includes(locB) && !locB.includes(locA)) {
        return { similar: false, similarity_score: 0.35 };
      }
      return { similar: true, similarity_score: 0.93 };
    }
  }

  // C. Lab Computers: Power failure / not turning on vs other
  if (isComputerA && isComputerB) {
    const isPowerA = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power)\b/i.test(descA);
    const isPowerB = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power)\b/i.test(descB);

    if (isPowerA && isPowerB) {
      return { similar: true, similarity_score: 0.91 };
    }
  }

  // Generic Jaccard word similarity on significant tokens
  const stopWords = new Set(['the', 'is', 'in', 'on', 'at', 'and', 'a', 'an', 'to', 'for', 'of', 'during', 'we', 'are', 'was', 'this', 'that']);
  const tokensA = normDescA.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
  const tokensB = normDescB.split(' ').filter(w => w.length > 2 && !stopWords.has(w));

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? (intersection / union) : 0;

  const score = Number(Math.min(1.0, Math.max(0.0, jaccard * 1.1)).toFixed(2));
  return {
    similar: score >= SIMILARITY_THRESHOLD,
    similarity_score: score
  };
}

/**
 * Handle incoming issue similarity analysis request
 */
export async function handleSimilarityAnalysis(reqBody, headers = {}) {
  const { issueIdA, issueIdB, issueA, issueB } = reqBody || {};

  // Extract descriptions
  const descA = (typeof issueA === 'object' ? issueA?.description : issueA) || reqBody?.descriptionA;
  const descB = (typeof issueB === 'object' ? issueB?.description : issueB) || reqBody?.descriptionB;

  if (!descA || typeof descA !== 'string' || !descA.trim()) {
    return { status: 400, body: { error: 'Description for Issue A is required.' } };
  }
  if (!descB || typeof descB !== 'string' || !descB.trim()) {
    return { status: 400, body: { error: 'Description for Issue B is required.' } };
  }

  // Prevent self comparison when IDs are provided
  if (issueIdA && issueIdB && issueIdA === issueIdB) {
    return { status: 400, body: { error: 'Cannot compare an issue with itself.' } };
  }

  const trimmedDescA = descA.trim();
  const trimmedDescB = descB.trim();
  const catA = (typeof issueA === 'object' ? issueA?.category : null) || reqBody?.categoryA || 'other';
  const catB = (typeof issueB === 'object' ? issueB?.category : null) || reqBody?.categoryB || 'other';
  const locA = (typeof issueA === 'object' ? issueA?.location : null) || reqBody?.locationA || '';
  const locB = (typeof issueB === 'object' ? issueB?.location : null) || reqBody?.locationB || '';

  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  let isSimilar = false;
  let similarityScore = 0.50;
  let modelProvider = 'academic-similarity-engine';

  if (apiKey) {
    try {
      const prompt = `You are an academic infrastructure issue similarity analyzer.
Compare two reported department issues and determine if they are semantically similar enough that they describe the SAME underlying physical problem.

Evaluation Criteria:
1. Category & Defect: Do they report the exact same defect (e.g. Wi-Fi dropping vs Wi-Fi dropping)?
   Important: Disconnection vs slowness are different problems (not similar).
2. Location: Do they describe the same room, lab, or area? Completely different rooms are not the same physical problem.
3. Specific Problem: Focus on the actual physical defect rather than superficial word overlap.

Threshold: Consider "similar: true" only if the issues clearly report the same defect in the same environment.

Respond ONLY with a JSON object:
{"similar": true, "similarity_score": 0.91}
or:
{"similar": false, "similarity_score": 0.32}

Issue A:
Category: "${catA}"
Location: "${locA}"
Description: "${trimmedDescA}"

Issue B:
Category: "${catB}"
Location: "${locB}"
Description: "${trimmedDescB}"`;

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
          if (typeof parsed.similar === 'boolean' && typeof parsed.similarity_score === 'number' && parsed.similarity_score >= 0 && parsed.similarity_score <= 1) {
            isSimilar = parsed.similar && parsed.similarity_score >= SIMILARITY_THRESHOLD;
            similarityScore = parsed.similarity_score;
            modelProvider = 'google-gemini-1.5-flash';
          } else {
            console.warn('[SimilarityServer] Malformed model output, using fallback:', parsed);
            const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
            isSimilar = fallback.similar;
            similarityScore = fallback.similarity_score;
          }
        }
      } else {
        console.warn('[SimilarityServer] Gemini API status:', response.status);
        const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
        isSimilar = fallback.similar;
        similarityScore = fallback.similarity_score;
      }
    } catch (err) {
      console.warn('[SimilarityServer] Gemini error, fallback used:', err.message);
      const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
      isSimilar = fallback.similar;
      similarityScore = fallback.similarity_score;
    }
  } else {
    const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
    isSimilar = fallback.similar;
    similarityScore = fallback.similarity_score;
  }

  // Enforce relationship classification
  const relationship = isSimilar ? 'similar' : 'not_similar';

  // Persist into Supabase if both issue IDs are provided
  const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://ebenxdbvtgmfbszplkyt.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (issueIdA && issueIdB && supabaseUrl && supabaseKey) {
    try {
      const clientOptions = {};
      const authHeader = headers['authorization'] || headers['Authorization'];
      if (authHeader) {
        clientOptions.global = { headers: { Authorization: authHeader } };
      }
      const supabase = createClient(supabaseUrl, supabaseKey, clientOptions);

      // Call canonical RPC function
      const { error: rpcErr } = await supabase.rpc('record_issue_similarity', {
        p_issue_id_1: issueIdA,
        p_issue_id_2: issueIdB,
        p_similarity_score: similarityScore,
        p_relationship: relationship,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });

      if (rpcErr) {
        console.warn('[SimilarityServer] RPC error, attempting canonical direct upsert:', rpcErr.message);
        const [canonicalA, canonicalB] = issueIdA < issueIdB ? [issueIdA, issueIdB] : [issueIdB, issueIdA];
        await supabase.from('issue_similarity_analysis').upsert({
          issue_id_a: canonicalA,
          issue_id_b: canonicalB,
          similarity_score: similarityScore,
          relationship,
          model_provider: modelProvider,
          status: 'completed'
        }, { onConflict: 'issue_id_a,issue_id_b' });
      }
    } catch (dbErr) {
      console.warn('[SimilarityServer] Supabase persistence error:', dbErr.message);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      similar: isSimilar,
      similarity_score: similarityScore,
      relationship,
      model: modelProvider
    }
  };
}
