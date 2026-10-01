/**
 * Department Issue Group Service (Phase 6.3)
 * Manages aggregation of duplicate student reports into logical Issue Groups.
 * 
 * Strict Zero-PII: No student names, emails, or roll numbers are processed, sent, or stored.
 */

import { supabase } from './supabase.js';
import { calculateGroupRecurrence } from './recurrenceService.js';
import { calculateGroupAnalyticsRPC } from './priorityWarningService.js';

/**
 * Checks if two location strings are physically compatible
 * E.g. "Lab 2" and "Lab 2" -> true
 * "Lab 1" and "Lab 5" -> false
 */
export function areLocationsCompatible(locA, locB) {
  const a = (locA || '').trim().toLowerCase();
  const b = (locB || '').trim().toLowerCase();

  if (!a || !b) return true; // Generic/unspecified location matches
  if (a === b) return true;

  // Extract room or lab tokens
  const matchA = a.match(/\b(room|lab|hall|block)\s*([a-z0-9-]+)/i);
  const matchB = b.match(/\b(room|lab|hall|block)\s*([a-z0-9-]+)/i);

  if (matchA && matchB) {
    const typeA = matchA[1].toLowerCase();
    const typeB = matchB[1].toLowerCase();
    const numA = matchA[2].toLowerCase();
    const numB = matchB[2].toLowerCase();

    if (typeA === typeB && numA !== numB) {
      return false; // Clearly different rooms or labs
    }
  }

  return a.includes(b) || b.includes(a);
}

/**
 * Generates an AI-assisted concise title and summary for an issue group
 * @param {Object} params
 * @param {string} params.category
 * @param {string} [params.location]
 * @param {Array<string>} params.descriptions
 * @returns {Promise<Object>} { title, summary, model }
 */
export async function generateGroupTitleAndSummary({ category, location, descriptions = [] }) {
  const payload = {
    category: category || 'other',
    location: location || '',
    descriptions: Array.isArray(descriptions) ? descriptions : [descriptions].filter(Boolean)
  };

  try {
    const response = await fetch('/api/generate-group-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      return {
        title: data.title || 'Academic Infrastructure Issue',
        summary: data.summary || 'Multiple reports submitted.',
        model: data.model || 'server-engine'
      };
    }
  } catch (err) {
    console.warn('[GroupService] Local API failed, trying Edge Function:', err.message);
  }

  // Edge Function attempt
  try {
    const { data: edgeData, error: edgeErr } = await supabase.functions.invoke('generate-group-summary', {
      body: payload
    });

    if (!edgeErr && edgeData) {
      return {
        title: edgeData.title || 'Academic Infrastructure Issue',
        summary: edgeData.summary || 'Multiple reports submitted.',
        model: edgeData.model || 'edge-engine'
      };
    }
  } catch (edgeErr) {
    console.warn('[GroupService] Edge Function unreachable:', edgeErr.message);
  }

  // Local fallback
  const locPrefix = location ? `${location} ` : '';
  const title = `${locPrefix}${category === 'wifi' ? 'Wi-Fi Connectivity' : 'Infrastructure Issue'}`.trim();
  const summary = `Multiple reports describe issues requiring attention${location ? ' in ' + location : ''}.`;

  return { title, summary, model: 'client-fallback' };
}

/**
 * Creates a new issue group in Supabase
 * @param {Object} params
 * @returns {Promise<Object>} Created group record
 */
export async function createGroup({
  departmentId,
  category,
  title,
  summary,
  location,
  initialIssueId
}) {
  let resolvedDeptId = departmentId || null;

  if (initialIssueId) {
    try {
      const { data: issueRecord } = await supabase
        .from('department_issues')
        .select('department_id')
        .eq('id', initialIssueId)
        .maybeSingle();

      if (issueRecord?.department_id) {
        if (resolvedDeptId && resolvedDeptId !== issueRecord.department_id) {
          throw new Error('Cross-department grouping rejected: initial issue department does not match target group department.');
        }
        resolvedDeptId = issueRecord.department_id;
      }
    } catch (ex) {
      if (ex.message?.includes('Cross-department')) throw ex;
    }
  }

  if (!resolvedDeptId) {
    throw new Error('departmentId is strictly required to create an issue group.');
  }

  const { data, error } = await supabase.rpc('create_issue_group', {
    p_department_id: resolvedDeptId,
    p_category: category,
    p_title: title,
    p_summary: summary || null,
    p_location: location || null,
    p_initial_issue_id: initialIssueId || null
  });

  if (error) {
    if (error.message?.includes('Cross-department')) {
      throw error;
    }
    console.warn('[GroupService] create_issue_group RPC error:', error.message);
    // Direct table insert fallback
    const { data: directGroup, error: directErr } = await supabase
      .from('issue_groups')
      .insert([
        {
          department_id: resolvedDeptId,
          category,
          title,
          summary: summary || null,
          location: location || null,
          status: 'open',
          issue_count: initialIssueId ? 1 : 0
        }
      ])
      .select('*')
      .single();

    if (directErr) {
      throw directErr;
    }

    if (initialIssueId && directGroup) {
      await supabase
        .from('issue_group_members')
        .insert([{ issue_group_id: directGroup.id, issue_id: initialIssueId }]);
    }

    return directGroup;
  }

  return data;
}

/**
 * Adds an issue as a member of an existing group
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.issueId
 * @returns {Promise<Object>}
 */
export async function addMemberToGroup({ groupId, issueId }) {
  if (!groupId || !issueId) return null;

  // Pre-validate department consistency before adding member
  try {
    const { data: grp } = await supabase.from('issue_groups').select('department_id').eq('id', groupId).maybeSingle();
    const { data: iss } = await supabase.from('department_issues').select('department_id').eq('id', issueId).maybeSingle();
    if (iss && !iss.department_id) {
      throw new Error(`Issue ${issueId} has no assigned department.`);
    }
    if (grp && !grp.department_id) {
      throw new Error(`Issue group ${groupId} has no assigned department.`);
    }
    if (grp?.department_id && iss?.department_id && grp.department_id !== iss.department_id) {
      throw new Error('Cross-department grouping rejected: issue department does not match group department.');
    }
  } catch (ex) {
    if (ex.message?.includes('Cross-department') || ex.message?.includes('no assigned department')) throw ex;
  }

  const { data, error } = await supabase.rpc('add_issue_to_group', {
    p_group_id: groupId,
    p_issue_id: issueId
  });

  if (error) {
    if (error.message?.includes('Cross-department')) throw error;
    console.warn('[GroupService] add_issue_to_group RPC error, attempting direct insert:', error.message);
    await supabase
      .from('issue_group_members')
      .upsert({ issue_group_id: groupId, issue_id: issueId }, { onConflict: 'issue_group_id,issue_id' });
  }

  // Phase 6.4 & Phase 7: Recalculate recurrence then Priority & Early Warning analytics
  calculateGroupRecurrence(groupId)
    .catch(recErr => {
      console.warn('[GroupService] Recurrence calculation failed:', recErr.message);
    })
    .finally(() => {
      calculateGroupAnalyticsRPC(groupId).catch(anErr => {
        console.warn('[GroupService] Analytics calculation failed:', anErr.message);
      });
    });

  return data;
}

/**
 * Fetches the active (status = 'open') group for a given issue ID
 * @param {string} issueId
 * @returns {Promise<Object|null>}
 */
export async function getActiveGroupForIssue(issueId) {
  if (!issueId) return null;

  const { data, error } = await supabase.rpc('get_issue_group_for_issue', {
    p_issue_id: issueId
  });

  if (!error && data) {
    return data;
  }

  // Fallback query via RLS
  const { data: members, error: memErr } = await supabase
    .from('issue_group_members')
    .select(`
      issue_groups (
        id, department_id, category, title, summary, location, status, issue_count
      )
    `)
    .eq('issue_id', issueId)
    .limit(1);

  if (!memErr && members?.[0]?.issue_groups && members[0].issue_groups.status === 'open') {
    return members[0].issue_groups;
  }

  return null;
}

/**
 * Handles grouping when two issues are confirmed duplicates (Phase 6.3)
 * Reuses existing group or creates a new one containing both.
 * @param {Object} params
 * @param {Object} params.newIssue - Newly submitted issue
 * @param {Object} params.duplicateCandidate - Existing candidate confirmed as duplicate
 * @returns {Promise<Object|null>} The assigned issue group
 */
export async function attachOrCreateGroupOnDuplicate({ newIssue, duplicateCandidate }) {
  if (!newIssue?.id || !duplicateCandidate?.id) return null;

  // 0. Strict Department Boundary Check: Cross-department issues must NEVER be grouped
  const deptA = newIssue.departmentId || newIssue.department_id;
  let deptB = duplicateCandidate.departmentId || duplicateCandidate.department_id;

  // Defensive fallback only if deptB is missing on duplicateCandidate object (avoids DB query in normal path)
  if (!deptB && duplicateCandidate.id) {
    try {
      const { data: cRow } = await supabase
        .from('department_issues')
        .select('department_id')
        .eq('id', duplicateCandidate.id)
        .maybeSingle();
      deptB = cRow?.department_id || null;
    } catch (_) {}
  }

  if (!deptA || !deptB || deptA !== deptB) {
    return null;
  }

  // 1. Verify category match
  if (newIssue.category && duplicateCandidate.category && newIssue.category !== duplicateCandidate.category) {
    return null; // Different category -> separate groups
  }

  // 2. Verify location compatibility
  if (!areLocationsCompatible(newIssue.location, duplicateCandidate.location)) {
    return null; // Clearly distinct physical locations -> separate groups
  }

  try {
    // 3. Check if duplicateCandidate is already in an open group
    const candidateGroup = await getActiveGroupForIssue(duplicateCandidate.id);
    if (candidateGroup && candidateGroup.status === 'open') {
      await addMemberToGroup({ groupId: candidateGroup.id, issueId: newIssue.id });
      return candidateGroup;
    }

    // 4. Check if newIssue is already in an open group
    const newIssueGroup = await getActiveGroupForIssue(newIssue.id);
    if (newIssueGroup && newIssueGroup.status === 'open') {
      await addMemberToGroup({ groupId: newIssueGroup.id, issueId: duplicateCandidate.id });
      return newIssueGroup;
    }

    // 5. Neither is in an open group: create a new group containing both
    const loc = newIssue.location || duplicateCandidate.location || '';
    const descs = [newIssue.description, duplicateCandidate.description].filter(Boolean);

    const { title, summary } = await generateGroupTitleAndSummary({
      category: newIssue.category || duplicateCandidate.category,
      location: loc,
      descriptions: descs
    });

    const resolvedDeptId = deptA || deptB || null;

    const newGroup = await createGroup({
      departmentId: resolvedDeptId,
      category: newIssue.category || duplicateCandidate.category || 'other',
      title,
      summary,
      location: loc,
      initialIssueId: duplicateCandidate.id
    });

    if (newGroup?.id) {
      await addMemberToGroup({ groupId: newGroup.id, issueId: newIssue.id });
    }

    return newGroup;
  } catch (err) {
    console.warn('[GroupService] Failed to group duplicate issues:', err.message);
    return null;
  }
}

/**
 * Ensures a standalone group exists for an issue that has no duplicates
 * @param {Object} issue
 * @returns {Promise<Object|null>}
 */
export async function ensureStandaloneGroup(issue) {
  if (!issue?.id) return null;

  try {
    const existing = await getActiveGroupForIssue(issue.id);
    if (existing) return existing;

    const { title, summary } = await generateGroupTitleAndSummary({
      category: issue.category,
      location: issue.location,
      descriptions: [issue.description]
    });

    const createdGroup = await createGroup({
      departmentId: issue.department_id || issue.departmentId || null,
      category: issue.category || 'other',
      title,
      summary,
      location: issue.location || '',
      initialIssueId: issue.id
    });

    if (createdGroup?.id) {
      calculateGroupRecurrence(createdGroup.id)
        .catch(recErr => {
          console.warn('[GroupService] Recurrence calculation failed:', recErr.message);
        })
        .finally(() => {
          calculateGroupAnalyticsRPC(createdGroup.id).catch(anErr => {
            console.warn('[GroupService] Analytics calculation failed:', anErr.message);
          });
        });
    }

    return createdGroup;
  } catch (err) {
    console.warn('[GroupService] Failed to create standalone group:', err.message);
    return null;
  }
}
