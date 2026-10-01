/**
 * Server-side Department Issue Relationship Handler (Phase 6.2)
 * Determines whether two similar department issues are "duplicate" or "related".
 * Executes strictly on backend/server. Never exposes API keys or PII to client.
 */

import { createClient } from '@supabase/supabase-js';

export const ALLOWED_RELATIONSHIPS = ['duplicate', 'related', 'not_similar'];

/**
 * Normalizes text for comparison
 */
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts normalized location tokens (e.g. "lab 2", "room 204")
 */
function extractLocation(locStr, descStr) {
  const combined = ((locStr || '') + ' ' + (descStr || '')).toLowerCase();
  const roomMatch = combined.match(/\b(room|lab|hall|block|auditorium)\s*([a-z0-9-]+)/i);
  if (roomMatch) {
    return (roomMatch[1] + ' ' + roomMatch[2]).toLowerCase();
  }
  if (/\b(computer lab|comp lab)\b/i.test(combined)) return 'computer lab';
  if (/\b(lab)\b/i.test(combined)) return 'lab';
  return (locStr || '').toLowerCase().trim();
}

/**
 * Fallback rule-based relationship classifier
 * Distinguishes duplicate (same underlying defect) from related (same domain, different defect)
 */
export function classifyRelationshipFallback(issueA, issueB, options = {}) {
  const descA = typeof issueA === 'string' ? issueA : (issueA?.description || '');
  const descB = typeof issueB === 'string' ? issueB : (issueB?.description || '');

  if (!descA.trim() || !descB.trim()) {
    return { relationship: 'not_similar', confidence: 0.00 };
  }

  const catA = (typeof issueA === 'object' && issueA?.category ? issueA.category : '').toLowerCase();
  const catB = (typeof issueB === 'object' && issueB?.category ? issueB.category : '').toLowerCase();

  const rawLocA = typeof issueA === 'object' && issueA?.location ? issueA.location : '';
  const rawLocB = typeof issueB === 'object' && issueB?.location ? issueB.location : '';

  const normDescA = normalizeText(descA);
  const normDescB = normalizeText(descB);

  // 1. Cross-category / Incompatible topics check
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
    return { relationship: 'not_similar', confidence: 0.95 };
  }
  if ((isComputerA && isLightsB) || (isLightsA && isComputerB)) {
    return { relationship: 'not_similar', confidence: 0.95 };
  }
  if ((isWifiA && isChairsB) || (isChairsA && isWifiB)) {
    return { relationship: 'not_similar', confidence: 0.95 };
  }
  if ((isWifiA && isProjectorB) || (isProjectorA && isWifiB)) {
    return { relationship: 'not_similar', confidence: 0.95 };
  }

  // 2. Specific defect analysis within same domain

  // A. Wi-Fi / Internet
  if (isWifiA && isWifiB) {
    const isDisconnectA = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|keeps dropping|cuts out|lost connection)\b/i.test(descA);
    const isDisconnectB = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|keeps dropping|cuts out|lost connection)\b/i.test(descB);

    const isSlowA = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descA);
    const isSlowB = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descB);

    // Both describe disconnection/drops -> DUPLICATE
    if (isDisconnectA && isDisconnectB) {
      return { relationship: 'duplicate', confidence: 0.91 };
    }

    // Both describe slowness/bandwidth -> DUPLICATE
    if (isSlowA && isSlowB) {
      return { relationship: 'duplicate', confidence: 0.89 };
    }

    // One is disconnect and one is slow -> RELATED (same network facility, different defect)
    if ((isDisconnectA && isSlowB) || (isSlowA && isDisconnectB)) {
      return { relationship: 'related', confidence: 0.85 };
    }
  }

  // B. Projector / Display
  if (isProjectorA && isProjectorB) {
    const isBlankA = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen|no display|stops displaying|turns off|malfunction|malfunctioning|not working|not working properly)\b/i.test(descA);
    const isBlankB = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen|no display|stops displaying|turns off|malfunction|malfunctioning|not working|not working properly)\b/i.test(descB);

    const isDimA = /\b(dim|very dim|flickering|flicker|blurry|unclear|color distorted|dark)\b/i.test(descA);
    const isDimB = /\b(dim|very dim|flickering|flicker|blurry|unclear|color distorted|dark)\b/i.test(descB);

    // Location check
    const locA = extractLocation(rawLocA, descA);
    const locB = extractLocation(rawLocB, descB);
    const diffLocation = locA && locB && locA !== locB && !locA.includes(locB) && !locB.includes(locA);

    if (diffLocation) {
      return { relationship: 'not_similar', confidence: 0.85 };
    }

    // Both blank / no signal -> DUPLICATE
    if (isBlankA && isBlankB) {
      return { relationship: 'duplicate', confidence: 0.93 };
    }

    // Both dim / quality issue -> DUPLICATE
    if (isDimA && isDimB) {
      return { relationship: 'duplicate', confidence: 0.90 };
    }

    // One blank and one dim -> RELATED (same projector hardware, different symptom)
    if ((isBlankA && isDimB) || (isDimA && isBlankB)) {
      return { relationship: 'related', confidence: 0.86 };
    }
  }

  // C. Lab Computers
  if (isComputerA && isComputerB) {
    const isPowerA = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power|will not power on|does not start)\b/i.test(descA);
    const isPowerB = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power|will not power on|does not start)\b/i.test(descB);

    const isPeripheralA = /\b(keyboard|mouse|faulty keyboard|keyboards|monitor|cable)\b/i.test(descA);
    const isPeripheralB = /\b(keyboard|mouse|faulty keyboard|keyboards|monitor|cable)\b/i.test(descB);

    // Both power/boot failure -> DUPLICATE
    if (isPowerA && isPowerB) {
      return { relationship: 'duplicate', confidence: 0.92 };
    }

    // One power failure, one peripheral -> RELATED (same lab workstation, different defect)
    if ((isPowerA && isPeripheralB) || (isPeripheralA && isPowerB)) {
      return { relationship: 'related', confidence: 0.85 };
    }

    // Both peripheral -> DUPLICATE if same peripheral, RELATED if different
    if (isPeripheralA && isPeripheralB) {
      const isKeyboardA = /\bkeyboard\b/i.test(descA);
      const isKeyboardB = /\bkeyboard\b/i.test(descB);
      if (isKeyboardA === isKeyboardB) {
        return { relationship: 'duplicate', confidence: 0.88 };
      }
      return { relationship: 'related', confidence: 0.82 };
    }
  }

  // Default fallback if categories match
  if (catA && catB && catA === catB && catA !== 'other') {
    return { relationship: 'related', confidence: 0.75 };
  }

  return { relationship: 'not_similar', confidence: 0.80 };
}

/**
 * Handle incoming issue relationship analysis request
 */
export async function handleRelationshipAnalysis(reqBody, headers = {}) {
  const {
    issueIdA,
    issueIdB,
    issueA,
    issueB,
    similarityAnalysisId,
    similarityScore,
    isSimilar,
    phase61Similar
  } = reqBody || {};

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

  // 1. Pipeline Check: If Phase 6.1 explicitly said not similar, short-circuit
  if (isSimilar === false || phase61Similar === false) {
    return {
      status: 200,
      body: {
        success: true,
        relationship: 'not_similar',
        confidence: 0.95,
        model: 'similarity-pipeline-shortcircuit'
      }
    };
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  let relationship = 'related';
  let confidence = 0.80;
  let modelProvider = 'academic-relationship-engine';

  if (apiKey) {
    try {
      const prompt = `You are an academic infrastructure issue relationship analyzer.
Analyze two reported department issues that are in the same domain, and determine their exact relationship:
1. "duplicate": Both describe essentially the SAME underlying physical defect/problem in the same facility, just phrased in different words.
   Example: "Wi-Fi keeps disconnecting" vs "Internet connection repeatedly drops" -> duplicate
   Example: "Projector shows no display" vs "Projector has a blank screen" -> duplicate
   Example: "Lab computer will not power on" vs "The lab PC does not start" -> duplicate
2. "related": Both belong to the same facility or system, but describe DIFFERENT underlying defects or symptoms.
   Example: "Wi-Fi keeps disconnecting" vs "Wi-Fi is extremely slow" -> related
   Example: "Projector is blank" vs "Projector image is very dim" -> related
   Example: "Lab computers will not power on" vs "Lab computers have faulty keyboards" -> related
3. "not_similar": Completely different problems or different facilities.

Respond ONLY with a JSON object:
{"relationship": "duplicate", "confidence": 0.91}
or:
{"relationship": "related", "confidence": 0.82}
or:
{"relationship": "not_similar", "confidence": 0.96}

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
          if (
            ALLOWED_RELATIONSHIPS.includes(parsed.relationship) &&
            typeof parsed.confidence === 'number' &&
            parsed.confidence >= 0 &&
            parsed.confidence <= 1
          ) {
            relationship = parsed.relationship;
            confidence = parsed.confidence;
            modelProvider = 'google-gemini-1.5-flash';
          } else {
            console.warn('[RelationshipServer] Malformed model output, using fallback:', parsed);
            const fallback = classifyRelationshipFallback(
              { category: catA, location: locA, description: trimmedDescA },
              { category: catB, location: locB, description: trimmedDescB }
            );
            relationship = fallback.relationship;
            confidence = fallback.confidence;
          }
        }
      } else {
        console.warn('[RelationshipServer] Gemini API status:', response.status);
        const fallback = classifyRelationshipFallback(
          { category: catA, location: locA, description: trimmedDescA },
          { category: catB, location: locB, description: trimmedDescB }
        );
        relationship = fallback.relationship;
        confidence = fallback.confidence;
      }
    } catch (err) {
      console.warn('[RelationshipServer] Gemini error, fallback used:', err.message);
      const fallback = classifyRelationshipFallback(
        { category: catA, location: locA, description: trimmedDescA },
        { category: catB, location: locB, description: trimmedDescB }
      );
      relationship = fallback.relationship;
      confidence = fallback.confidence;
    }
  } else {
    const fallback = classifyRelationshipFallback(
      { category: catA, location: locA, description: trimmedDescA },
      { category: catB, location: locB, description: trimmedDescB }
    );
    relationship = fallback.relationship;
    confidence = fallback.confidence;
  }

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
      const { error: rpcErr } = await supabase.rpc('record_issue_relationship', {
        p_issue_id_1: issueIdA,
        p_issue_id_2: issueIdB,
        p_relationship: relationship,
        p_confidence: confidence,
        p_similarity_analysis_id: similarityAnalysisId || null,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });

      if (rpcErr) {
        console.warn('[RelationshipServer] RPC error, attempting canonical direct upsert:', rpcErr.message);
        const [canonicalA, canonicalB] = issueIdA < issueIdB ? [issueIdA, issueIdB] : [issueIdB, issueIdA];
        await supabase.from('issue_relationship_analysis').upsert({
          issue_id_a: canonicalA,
          issue_id_b: canonicalB,
          similarity_analysis_id: similarityAnalysisId || null,
          relationship,
          confidence,
          model_provider: modelProvider,
          status: 'completed'
        }, { onConflict: 'issue_id_a,issue_id_b' });
      }
    } catch (dbErr) {
      console.warn('[RelationshipServer] Supabase persistence error:', dbErr.message);
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      relationship,
      confidence,
      model: modelProvider
    }
  };
}
