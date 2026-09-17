// Supabase Edge Function: analyze-relationship
// Classifies whether two similar department issues are duplicate or related (Phase 6.2)
// NO PII (student names, emails, roll numbers) is processed or accepted.
// API Keys are kept strictly on the server in Deno environment variables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const ALLOWED_RELATIONSHIPS = ['duplicate', 'related', 'not_similar'];

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLocation(locStr: string, descStr: string): string {
  const combined = ((locStr || '') + ' ' + (descStr || '')).toLowerCase();
  const roomMatch = combined.match(/\b(room|lab|hall|block|auditorium)\s*([a-z0-9-]+)/i);
  if (roomMatch) {
    return (roomMatch[1] + ' ' + roomMatch[2]).toLowerCase();
  }
  if (/\b(computer lab|comp lab)\b/i.test(combined)) return 'computer lab';
  if (/\b(lab)\b/i.test(combined)) return 'lab';
  return (locStr || '').toLowerCase().trim();
}

function classifyRelationshipFallback(issueA: any, issueB: any): { relationship: string; confidence: number } {
  const descA = typeof issueA === 'string' ? issueA : (issueA?.description || '');
  const descB = typeof issueB === 'string' ? issueB : (issueB?.description || '');

  if (!descA.trim() || !descB.trim()) {
    return { relationship: 'not_similar', confidence: 0.00 };
  }

  const catA = (typeof issueA === 'object' && issueA?.category ? issueA.category : '').toLowerCase();
  const catB = (typeof issueB === 'object' && issueB?.category ? issueB.category : '').toLowerCase();

  const rawLocA = typeof issueA === 'object' && issueA?.location ? issueA.location : '';
  const rawLocB = typeof issueB === 'object' && issueB?.location ? issueB.location : '';

  // Cross-category / incompatible checks
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

  if ((isProjectorA && isChairsB) || (isChairsA && isProjectorB)) return { relationship: 'not_similar', confidence: 0.95 };
  if ((isComputerA && isLightsB) || (isLightsA && isComputerB)) return { relationship: 'not_similar', confidence: 0.95 };
  if ((isWifiA && isChairsB) || (isChairsA && isWifiB)) return { relationship: 'not_similar', confidence: 0.95 };
  if ((isWifiA && isProjectorB) || (isProjectorA && isWifiB)) return { relationship: 'not_similar', confidence: 0.95 };

  // Wi-Fi
  if (isWifiA && isWifiB) {
    const isDisconnectA = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|keeps dropping|cuts out|lost connection)\b/i.test(descA);
    const isDisconnectB = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|keeps dropping|cuts out|lost connection)\b/i.test(descB);

    const isSlowA = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descA);
    const isSlowB = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descB);

    if (isDisconnectA && isDisconnectB) return { relationship: 'duplicate', confidence: 0.91 };
    if (isSlowA && isSlowB) return { relationship: 'duplicate', confidence: 0.89 };
    if ((isDisconnectA && isSlowB) || (isSlowA && isDisconnectB)) return { relationship: 'related', confidence: 0.85 };
  }

  // Projector
  if (isProjectorA && isProjectorB) {
    const isBlankA = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen|no display)\b/i.test(descA);
    const isBlankB = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen|no display)\b/i.test(descB);

    const isDimA = /\b(dim|very dim|flickering|flicker|blurry|unclear|color distorted|dark)\b/i.test(descA);
    const isDimB = /\b(dim|very dim|flickering|flicker|blurry|unclear|color distorted|dark)\b/i.test(descB);

    const locA = extractLocation(rawLocA, descA);
    const locB = extractLocation(rawLocB, descB);
    if (locA && locB && locA !== locB && !locA.includes(locB) && !locB.includes(locA)) {
      return { relationship: 'not_similar', confidence: 0.85 };
    }

    if (isBlankA && isBlankB) return { relationship: 'duplicate', confidence: 0.93 };
    if (isDimA && isDimB) return { relationship: 'duplicate', confidence: 0.90 };
    if ((isBlankA && isDimB) || (isDimA && isBlankB)) return { relationship: 'related', confidence: 0.86 };
  }

  // Computer
  if (isComputerA && isComputerB) {
    const isPowerA = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power|will not power on|does not start)\b/i.test(descA);
    const isPowerB = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power|will not power on|does not start)\b/i.test(descB);

    const isPeripheralA = /\b(keyboard|mouse|faulty keyboard|keyboards|monitor|cable)\b/i.test(descA);
    const isPeripheralB = /\b(keyboard|mouse|faulty keyboard|keyboards|monitor|cable)\b/i.test(descB);

    if (isPowerA && isPowerB) return { relationship: 'duplicate', confidence: 0.92 };
    if ((isPowerA && isPeripheralB) || (isPeripheralA && isPowerB)) return { relationship: 'related', confidence: 0.85 };
    if (isPeripheralA && isPeripheralB) {
      const isKeyboardA = /\bkeyboard\b/i.test(descA);
      const isKeyboardB = /\bkeyboard\b/i.test(descB);
      if (isKeyboardA === isKeyboardB) return { relationship: 'duplicate', confidence: 0.88 };
      return { relationship: 'related', confidence: 0.82 };
    }
  }

  if (catA && catB && catA === catB && catA !== 'other') {
    return { relationship: 'related', confidence: 0.75 };
  }

  return { relationship: 'not_similar', confidence: 0.80 };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      issueIdA,
      issueIdB,
      issueA,
      issueB,
      similarityAnalysisId,
      similarityScore,
      isSimilar,
      phase61Similar
    } = await req.json();

    const descA = (typeof issueA === 'object' ? issueA?.description : issueA);
    const descB = (typeof issueB === 'object' ? issueB?.description : issueB);

    if (!descA || typeof descA !== 'string' || !descA.trim()) {
      return new Response(
        JSON.stringify({ error: "Description for Issue A is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!descB || typeof descB !== 'string' || !descB.trim()) {
      return new Response(
        JSON.stringify({ error: "Description for Issue B is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (issueIdA && issueIdB && issueIdA === issueIdB) {
      return new Response(
        JSON.stringify({ error: "Cannot compare an issue with itself." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Pipeline Check: If Phase 6.1 explicitly said not similar, short-circuit immediately
    if (isSimilar === false || phase61Similar === false) {
      return new Response(
        JSON.stringify({
          success: true,
          relationship: "not_similar",
          confidence: 0.95,
          model: "similarity-pipeline-shortcircuit"
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const trimmedDescA = descA.trim();
    const trimmedDescB = descB.trim();
    const catA = (typeof issueA === 'object' ? issueA?.category : '') || 'other';
    const catB = (typeof issueB === 'object' ? issueB?.category : '') || 'other';
    const locA = (typeof issueA === 'object' ? issueA?.location : '') || '';
    const locB = (typeof issueB === 'object' ? issueB?.location : '') || '';

    const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("AI_API_KEY");
    let relationship = 'related';
    let confidence = 0.80;
    let modelProvider = 'academic-relationship-engine';

    if (apiKey) {
      try {
        const prompt = `You are an academic infrastructure issue relationship analyzer.
Analyze two reported department issues and determine their exact relationship:
1. "duplicate": Both describe essentially the SAME underlying physical defect in the same facility, just phrased differently.
2. "related": Both belong to the same facility or system, but describe DIFFERENT underlying defects or symptoms.
3. "not_similar": Completely different problems or facilities.

Respond ONLY with JSON:
{"relationship": "duplicate" | "related" | "not_similar", "confidence": 0.85}

Issue A:
Category: "${catA}"
Location: "${locA}"
Description: "${trimmedDescA}"

Issue B:
Category: "${catB}"
Location: "${locB}"
Description: "${trimmedDescB}"`;

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
              const fallback = classifyRelationshipFallback(
                { category: catA, location: locA, description: trimmedDescA },
                { category: catB, location: locB, description: trimmedDescB }
              );
              relationship = fallback.relationship;
              confidence = fallback.confidence;
            }
          }
        } else {
          const fallback = classifyRelationshipFallback(
            { category: catA, location: locA, description: trimmedDescA },
            { category: catB, location: locB, description: trimmedDescB }
          );
          relationship = fallback.relationship;
          confidence = fallback.confidence;
        }
      } catch (err) {
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

    if (issueIdA && issueIdB && supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.rpc('record_issue_relationship', {
        p_issue_id_1: issueIdA,
        p_issue_id_2: issueIdB,
        p_relationship: relationship,
        p_confidence: confidence,
        p_similarity_analysis_id: similarityAnalysisId || null,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        relationship,
        confidence,
        model: modelProvider
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to analyze relationship." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
