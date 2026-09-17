/**
 * Issue Relationship Service (Phase 6.2)
 * Classifies whether two similar department issues are "duplicate" or "related".
 * 
 * Strict Zero-PII: No student names, emails, or roll numbers are processed or sent.
 */

import { supabase } from './supabase.js';

export const ALLOWED_RELATIONSHIPS = ['duplicate', 'related', 'not_similar'];

/**
 * Classify the relationship between two department issues
 * @param {Object} params
 * @param {string} [params.issueIdA] - UUID of issue A
 * @param {string} [params.issueIdB] - UUID of issue B
 * @param {Object|string} params.issueA - Issue A object or description string
 * @param {Object|string} params.issueB - Issue B object or description string
 * @param {string} [params.similarityAnalysisId] - Optional UUID of Phase 6.1 similarity analysis
 * @param {number} [params.similarityScore] - Optional similarity score from Phase 6.1
 * @param {boolean} [params.isSimilar] - Whether Phase 6.1 found them similar
 * @param {boolean} [params.phase61Similar] - Explicit Phase 6.1 similarity flag
 * @returns {Promise<Object>} Relationship result { relationship, confidence, model }
 */
export async function classifyIssueRelationship({
  issueIdA,
  issueIdB,
  issueA,
  issueB,
  similarityAnalysisId,
  similarityScore,
  isSimilar,
  phase61Similar
}) {
  const descA = typeof issueA === 'object' ? (issueA?.description || '') : (issueA || '');
  const descB = typeof issueB === 'object' ? (issueB?.description || '') : (issueB || '');

  if (!descA.trim() || !descB.trim()) {
    throw new Error('Both issue descriptions are required for relationship classification.');
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

  // If Phase 6.1 explicitly found them not similar, short-circuit
  if (isSimilar === false || phase61Similar === false) {
    return {
      relationship: 'not_similar',
      confidence: 0.95,
      model: 'pipeline-shortcircuit'
    };
  }

  // Cross-department isolation short-circuit: issues from different departments can never be duplicate or related
  const deptA = typeof issueA === 'object' ? (issueA?.department_id || issueA?.departmentId) : null;
  const deptB = typeof issueB === 'object' ? (issueB?.department_id || issueB?.departmentId) : null;
  if (deptA && deptB && deptA !== deptB) {
    return {
      relationship: 'not_similar',
      confidence: 1.0,
      model: 'department-mismatch-shortcircuit'
    };
  }

  // Strip all PII: only transmit category, location, and description
  const payload = {
    issueIdA: canonicalIdA,
    issueIdB: canonicalIdB,
    similarityAnalysisId,
    similarityScore,
    isSimilar,
    phase61Similar,
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

    const response = await fetch('/api/analyze-relationship', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      return {
        relationship: data.relationship || 'related',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.80,
        model: data.model || 'server-engine'
      };
    }
  } catch (err) {
    console.warn('[RelationshipService] Local API failed, attempting Edge Function:', err.message);
  }

  // Edge Function attempt
  try {
    const { data: edgeData, error: edgeErr } = await supabase.functions.invoke('analyze-relationship', {
      body: payload
    });

    if (!edgeErr && edgeData) {
      return {
        relationship: edgeData.relationship || 'related',
        confidence: typeof edgeData.confidence === 'number' ? edgeData.confidence : 0.80,
        model: edgeData.model || 'edge-engine'
      };
    }
  } catch (edgeErr) {
    console.warn('[RelationshipService] Edge Function unreachable:', edgeErr.message);
  }

  // Client-side fallback
  return {
    relationship: 'related',
    confidence: 0.75,
    model: 'client-fallback'
  };
}

/**
 * Fetch recorded relationship analyses for an issue
 * @param {string} issueId - UUID of the issue
 * @returns {Promise<Array>} List of relationship records
 */
export async function getIssueRelationships(issueId) {
  if (!issueId) return [];

  const { data, error } = await supabase
    .from('issue_relationship_analysis')
    .select(`
      id,
      issue_id_a,
      issue_id_b,
      similarity_analysis_id,
      relationship,
      confidence,
      analyzed_at
    `)
    .or(`issue_id_a.eq.${issueId},issue_id_b.eq.${issueId}`)
    .order('confidence', { ascending: false });

  if (error) {
    console.warn('[RelationshipService] Could not fetch relationships:', error.message);
    return [];
  }

  return data || [];
}
