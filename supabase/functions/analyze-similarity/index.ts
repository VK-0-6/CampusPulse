// Supabase Edge Function: analyze-similarity
// Compares two department issues for semantic similarity (Phase 6.1)
// NO PII (student names, emails, roll numbers) is processed or accepted.
// API Keys are kept strictly on the server in Deno environment variables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const SIMILARITY_THRESHOLD = 0.75;

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLocation(locStr: string, descStr: string): string {
  const combined = (locStr + ' ' + descStr).toLowerCase();
  const roomMatch = combined.match(/\b(room|lab|hall|block|auditorium)\s*([a-z0-9-]+)/i);
  if (roomMatch) {
    return (roomMatch[1] + ' ' + roomMatch[2]).toLowerCase();
  }
  if (/\b(computer lab|comp lab)\b/i.test(combined)) return 'computer lab';
  if (/\b(lab)\b/i.test(combined)) return 'lab';
  return (locStr || '').toLowerCase().trim();
}

function analyzeSimilarityFallback(issueA: any, issueB: any): { similar: boolean; similarity_score: number } {
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

  // Incompatibility checks
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

  if ((isProjectorA && isChairsB) || (isChairsA && isProjectorB)) return { similar: false, similarity_score: 0.10 };
  if ((isComputerA && isLightsB) || (isLightsA && isComputerB)) return { similar: false, similarity_score: 0.10 };
  if ((isWifiA && isChairsB) || (isChairsA && isWifiB)) return { similar: false, similarity_score: 0.05 };

  // Wi-Fi
  if (isWifiA && isWifiB) {
    const isDisconnectA = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|drops repeatedly|keeps dropping|cuts out|lost connection)\b/i.test(descA);
    const isDisconnectB = /\b(disconnect|disconnects|disconnecting|drops|drop|dropping|repeatedly|unstable|drops repeatedly|keeps dropping|cuts out|lost connection)\b/i.test(descB);
    const isSlowA = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descA);
    const isSlowB = /\b(slow|extremely slow|very slow|speed|bandwidth|buffering|latency|lag|sluggish)\b/i.test(descB);

    if ((isDisconnectA && isSlowB) || (isSlowA && isDisconnectB)) return { similar: false, similarity_score: 0.55 };
    if (isDisconnectA && isDisconnectB) return { similar: true, similarity_score: 0.90 };
    if (isSlowA && isSlowB) return { similar: true, similarity_score: 0.88 };
  }

  // Projector
  if (isProjectorA && isProjectorB) {
    const isBlankA = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen)\b/i.test(descA);
    const isBlankB = /\b(not displaying|blank|black screen|no signal|does not display anything|completely blank|won t display|nothing on screen)\b/i.test(descB);
    if (isBlankA && isBlankB) {
      const locA = extractLocation(rawLocA, descA);
      const locB = extractLocation(rawLocB, descB);
      if (locA && locB && locA !== locB && !locA.includes(locB) && !locB.includes(locA)) {
        return { similar: false, similarity_score: 0.35 };
      }
      return { similar: true, similarity_score: 0.93 };
    }
  }

  // Computer
  if (isComputerA && isComputerB) {
    const isPowerA = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power)\b/i.test(descA);
    const isPowerB = /\b(not turning on|won t power up|won t turn on|cannot turn on|power up|not booting|dead|no power)\b/i.test(descB);
    if (isPowerA && isPowerB) return { similar: true, similarity_score: 0.91 };
  }

  // Token Jaccard
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
  return { similar: score >= SIMILARITY_THRESHOLD, similarity_score: score };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { issueIdA, issueIdB, issueA, issueB } = await req.json();

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

    const trimmedDescA = descA.trim();
    const trimmedDescB = descB.trim();
    const catA = (typeof issueA === 'object' ? issueA?.category : '') || 'other';
    const catB = (typeof issueB === 'object' ? issueB?.category : '') || 'other';
    const locA = (typeof issueA === 'object' ? issueA?.location : '') || '';
    const locB = (typeof issueB === 'object' ? issueB?.location : '') || '';

    const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("AI_API_KEY");
    let isSimilar = false;
    let similarityScore = 0.50;
    let modelProvider = 'academic-similarity-engine';

    if (apiKey) {
      try {
        const prompt = `You are an academic infrastructure issue similarity analyzer.
Compare two reported department issues and determine if they describe the SAME underlying physical problem.
Respond ONLY with JSON: {"similar": true|false, "similarity_score": 0.85}

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
            if (typeof parsed.similar === 'boolean' && typeof parsed.similarity_score === 'number' && parsed.similarity_score >= 0 && parsed.similarity_score <= 1) {
              isSimilar = parsed.similar && parsed.similarity_score >= SIMILARITY_THRESHOLD;
              similarityScore = parsed.similarity_score;
              modelProvider = 'google-gemini-1.5-flash';
            } else {
              const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
              isSimilar = fallback.similar;
              similarityScore = fallback.similarity_score;
            }
          }
        } else {
          const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
          isSimilar = fallback.similar;
          similarityScore = fallback.similarity_score;
        }
      } catch (err) {
        const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
        isSimilar = fallback.similar;
        similarityScore = fallback.similarity_score;
      }
    } else {
      const fallback = analyzeSimilarityFallback({ category: catA, location: locA, description: trimmedDescA }, { category: catB, location: locB, description: trimmedDescB });
      isSimilar = fallback.similar;
      similarityScore = fallback.similarity_score;
    }

    const relationship = isSimilar ? 'similar' : 'not_similar';

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

    if (issueIdA && issueIdB && supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.rpc('record_issue_similarity', {
        p_issue_id_1: issueIdA,
        p_issue_id_2: issueIdB,
        p_similarity_score: similarityScore,
        p_relationship: relationship,
        p_model_provider: modelProvider,
        p_status: 'completed'
      });
    }

    return new Response(
      JSON.stringify({ success: true, similar: isSimilar, similarity_score: similarityScore, relationship, model: modelProvider }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to analyze similarity." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
