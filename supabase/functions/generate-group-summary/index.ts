// Supabase Edge Function: generate-group-summary
// Generates concise, objective titles and summaries for department issue groups (Phase 6.3)
// NO PII (student names, emails, roll numbers) is processed or stored.
// API Keys are kept strictly on the server in Deno environment variables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const CATEGORY_TITLES: Record<string, string> = {
  wifi: 'Wi-Fi Connectivity',
  projector: 'Projector Display',
  lab_computer: 'Lab Computer System',
  lab_equipment: 'Lab Equipment',
  classroom_furniture: 'Classroom Furniture',
  electrical: 'Electrical / Power',
  classroom_condition: 'Classroom Environment',
  other: 'Academic Infrastructure'
};

function cleanLocation(loc: string): string {
  if (!loc) return '';
  return loc.trim().replace(/^in\s+/i, '').trim();
}

function generateGroupTitleSummaryFallback({ category, location, descriptions = [] }: any) {
  const catKey = (category || 'other').toLowerCase();
  const catTitle = CATEGORY_TITLES[catKey] || 'Infrastructure Issue';
  const loc = cleanLocation(location);

  const titlePrefix = loc ? `${loc} ` : '';
  const title = `${titlePrefix}${catTitle}`.trim().slice(0, 100);

  const combinedDesc = (descriptions || []).join(' ').toLowerCase();
  let defectNote = 'issues requiring attention';

  if (catKey === 'wifi') {
    if (/disconnect|drop|unstable/i.test(combinedDesc)) {
      defectNote = 'intermittent disconnections and dropped network connections';
    } else if (/slow|speed|bandwidth/i.test(combinedDesc)) {
      defectNote = 'slow network performance and low bandwidth';
    }
  } else if (catKey === 'projector') {
    if (/blank|no display|no signal/i.test(combinedDesc)) {
      defectNote = 'a completely blank screen or no display signal';
    } else if (/dim|flicker|blur/i.test(combinedDesc)) {
      defectNote = 'dim projection or distorted display quality';
    }
  } else if (catKey === 'lab_computer') {
    if (/not turning on|power|boot|dead/i.test(combinedDesc)) {
      defectNote = 'workstations failing to power on or boot up';
    } else if (/keyboard|mouse/i.test(combinedDesc)) {
      defectNote = 'faulty keyboard or mouse peripherals';
    }
  }

  const locNote = loc ? ` in ${loc}` : '';
  const summary = `Multiple reports indicate ${defectNote}${locNote}.`.slice(0, 300);

  return { title, summary, model: 'academic-grouping-engine' };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { category, location, descriptions } = await req.json();

    const cleanLoc = cleanLocation(location);
    const descs = Array.isArray(descriptions) ? descriptions : [descriptions].filter(Boolean);

    if (!descs.length && !category) {
      return new Response(
        JSON.stringify({ error: "Category and at least one description are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("AI_API_KEY");
    let title = '';
    let summary = '';
    let modelProvider = 'academic-grouping-engine';

    if (apiKey) {
      try {
        const prompt = `You are an academic infrastructure problem summarizer.
Generate a concise, professional issue group TITLE (max 60 characters) and SUMMARY (max 200 characters) for an aggregated group of reported student issues.

Rules:
1. Focus strictly on the physical defect and facility.
2. NEVER include student names, IDs, roll numbers, or personal pronouns.
3. Keep the title short, e.g. "Lab 2 Wi-Fi Connectivity" or "Room 101 Projector Display".
4. Keep the summary objective, e.g. "Multiple reports describe recurring network disconnections during lab sessions."

Respond ONLY with JSON:
{"title": "...", "summary": "..."}

Category: "${category || 'other'}"
Location: "${cleanLoc}"
Sample Descriptions:
${descs.slice(0, 5).map((d: string, i: number) => `${i + 1}. "${(d || '').trim()}"`).join('\n')}`;

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
          const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (raw) {
            const parsed = JSON.parse(raw);
            if (
              parsed.title &&
              typeof parsed.title === 'string' &&
              parsed.summary &&
              typeof parsed.summary === 'string'
            ) {
              title = parsed.title.trim().slice(0, 100);
              summary = parsed.summary.trim().slice(0, 300);
              modelProvider = 'google-gemini-1.5-flash';
            }
          }
        }
      } catch (err) {
        console.warn("[EdgeFunction] Gemini error, using fallback:", err);
      }
    }

    if (!title || !summary) {
      const fallback = generateGroupTitleSummaryFallback({ category, location: cleanLoc, descriptions: descs });
      title = fallback.title;
      summary = fallback.summary;
      modelProvider = fallback.model;
    }

    return new Response(
      JSON.stringify({ success: true, title, summary, model: modelProvider }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to generate group summary." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
