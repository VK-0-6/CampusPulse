/**
 * Issue Similarity Service (Phase 6.1)
 * Compares pairs of department infrastructure issues to detect if they
 * describe the same underlying problem.
 * 
 * Strict Zero-PII: No student names, emails, or roll numbers are processed or sent.
 */

import { supabase } from './supabase.js';

export const SIMILARITY_THRESHOLD = 0.75;
export const ALLOWED_RELATIONSHIPS = ['similar', 'not_similar'];

/**
 * Compare two department issues for semantic similarity
 * @param {Object} params
 * @param {string} [params.issueIdA] - Optional UUID of issue A
 * @param {string} [params.issueIdB] - Optional UUID of issue B
 * @param {Object|string} params.issueA - Issue A object or description string
 * @param {Object|string} params.issueB - Issue B object or description string
 * @returns {Promise<Object>} Comparison result { similar, similarity_score, relationship }
 */
export async function compareIssues({ issueIdA, issueIdB, issueA, issueB }) {
  const descA = typeof issueA === 'object' ? (issueA?.description || '') : (issueA || '');
  const descB = typeof issueB === 'object' ? (issueB?.description || '') : (issueB || '');

  if (!descA.trim() || !descB.trim()) {
    throw new Error('Both issue descriptions are required for similarity comparison.');
  }

  if (issueIdA && issueIdB && issueIdA === issueIdB) {
    throw new Error('Cannot compare an issue with itself.');
  }

  // Canonical ordering for IDs if provided
  let canonicalIdA = issueIdA;
  let canonicalIdB = issueIdB;
  if (issueIdA && issueIdB && issueIdA > issueIdB) {
    canonicalIdA = issueIdB;
    canonicalIdB = issueIdA;
  }

  // Strip all PII: only transmit category, location, and description
  const payload = {
    issueIdA: canonicalIdA,
    issueIdB: canonicalIdB,
    issueA: typeof issueA === 'object' ? {
      category: issueA.category || 'other',
      location: issueA.location || '',
      description: issueA.description || ''
    } : { category: 'other', location: '', description: issueA },
    issueB: typeof issueB === 'object' ? {
      category: issueB.category || 'other',
      location: issueB.location || '',
      description: issueB.description || ''
    } : { category: 'other', location: '', description: issueB }
  };

  try {
    const session = (await supabase.auth.getSession())?.data?.session;
    const headers = { 'Content-Type': 'application/json' };
    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch('/api/analyze-similarity', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      return {
        similar: Boolean(data.similar),
        similarity_score: typeof data.similarity_score === 'number' ? data.similarity_score : 0.50,
        relationship: data.relationship || (data.similar ? 'similar' : 'not_similar'),
        model: data.model || 'server-engine'
      };
    }
  } catch (err) {
    console.warn('[SimilarityService] Local API failed, attempting Edge Function:', err.message);
  }

  // Fallback / Edge Function attempt
  try {
    const { data: edgeData, error: edgeErr } = await supabase.functions.invoke('analyze-similarity', {
      body: payload
    });

    if (!edgeErr && edgeData) {
      return {
        similar: Boolean(edgeData.similar),
        similarity_score: typeof edgeData.similarity_score === 'number' ? edgeData.similarity_score : 0.50,
        relationship: edgeData.relationship || (edgeData.similar ? 'similar' : 'not_similar'),
        model: edgeData.model || 'edge-engine'
      };
    }
  } catch (edgeErr) {
    console.warn('[SimilarityService] Edge Function unreachable:', edgeErr.message);
  }

  // Safe client-side fallback simulation if network/server is unavailable
  return {
    similar: false,
    similarity_score: 0.50,
    relationship: 'not_similar',
    model: 'client-fallback'
  };
}

/**
 * Fetch recorded similarity analyses for an issue
 * @param {string} issueId - UUID of the issue
 * @returns {Promise<Array>} List of similar issues
 */
export async function getIssueSimilarities(issueId) {
  if (!issueId) return [];

  const { data, error } = await supabase
    .from('issue_similarity_analysis')
    .select(`
      id,
      issue_id_a,
      issue_id_b,
      similarity_score,
      relationship,
      analyzed_at
    `)
    .or(`issue_id_a.eq.${issueId},issue_id_b.eq.${issueId}`)
    .eq('relationship', 'similar')
    .order('similarity_score', { ascending: false });

  if (error) {
    console.warn('[SimilarityService] Could not fetch similarities:', error.message);
    return [];
  }

  return data || [];
}
