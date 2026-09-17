/**
 * Department Issue Service
 * Handles academic environment and infrastructure issue reporting (Part B)
 */

import { supabase } from './supabase.js';
import { analyzeIssueDescription } from './sentimentService.js';
import { classifyIssueDescription } from './classificationService.js';
import { predictIssueSeverity } from './severityService.js';
import { compareIssues } from './similarityService.js';
import { classifyIssueRelationship } from './relationshipService.js';
import { attachOrCreateGroupOnDuplicate } from './groupService.js';


export const ISSUE_CATEGORIES = {
  projector: 'Projector Issue',
  wifi: 'Wi-Fi / Internet Problem',
  lab_computer: 'Lab Computer Problem',
  lab_equipment: 'Lab Equipment Problem',
  classroom_furniture: 'Classroom Furniture Issue',
  electrical: 'Electrical / Power Issue',
  classroom_condition: 'Classroom Condition / Cleanliness',
  other: 'Other Academic Infrastructure Issue'
};

export const ISSUE_SEVERITIES = ['low', 'medium', 'high'];

/**
 * Report a new academic environment / infrastructure issue
 * @param {Object} params
 * @param {string} params.studentId - UUID of the reporting student
 * @param {string} [params.departmentId] - Optional UUID of department
 * @param {string} params.category - One of the valid categories
 * @param {string} params.location - Classroom/Lab/Building location
 * @param {string} params.description - Detailed description of the problem
 * @param {string} [params.severity='medium'] - 'low' | 'medium' | 'high'
 * @param {boolean} [params.isAnonymous=false] - Whether the report is confidential to recipient
 * @returns {Promise<Object>} Created issue record
 */
export async function reportDepartmentIssue({
  studentId,
  departmentId,
  category,
  location,
  description,
  severity = 'medium',
  isAnonymous = false
}) {
  if (!studentId) throw new Error('Student ID is required.');

  if (!category || !ISSUE_CATEGORIES[category]) {
    throw new Error('Please select a valid issue category.');
  }

  const trimmedLocation = (location || '').trim();
  if (!trimmedLocation) {
    throw new Error('Please specify the location (e.g., Room 302, CSE Lab 1).');
  }

  const trimmedDesc = (description || '').trim();
  if (!trimmedDesc) {
    throw new Error('Please provide a description of the issue.');
  }

  const normalizedSeverity = (severity || 'medium').toLowerCase();
  if (!ISSUE_SEVERITIES.includes(normalizedSeverity)) {
    throw new Error('Please select a valid severity level (Low, Medium, High).');
  }

  const { data, error } = await supabase
    .from('department_issues')
    .insert([
      {
        student_id: studentId,
        department_id: departmentId || null,
        category,
        location: trimmedLocation,
        description: trimmedDesc,
        severity: normalizedSeverity,
        is_anonymous: Boolean(isAnonymous),
        status: 'open'
      }
    ])
    .select(`
      id,
      department_id,
      category,
      location,
      description,
      severity,
      is_anonymous,
      status,
      created_at,
      departments (
        name
      )
    `)
    .single();

  if (error) {
    console.error('[DepartmentIssueService] Error reporting issue:', error);
    throw new Error(error.message || 'Failed to submit issue report.');
  }

  // Phase 5: Trigger asynchronous sentiment analysis, classification & severity prediction
  if (trimmedDesc && data?.id) {
    analyzeIssueDescription({ issueId: data.id, text: trimmedDesc }).catch(err => {
      console.warn('[DepartmentIssueService] Background sentiment analysis error:', err);
    });
    classifyIssueDescription({ issueId: data.id, text: trimmedDesc }).catch(err => {
      console.warn('[DepartmentIssueService] Background classification error:', err);
    });
    predictIssueSeverity({ issueId: data.id, text: trimmedDesc }).catch(err => {
      console.warn('[DepartmentIssueService] Background severity prediction error:', err);
    });

    // Phase 6.1: Trigger asynchronous and non-blocking candidate similarity analysis
    triggerSimilarityForIssue({
      id: data.id,
      category: data.category,
      location: data.location,
      description: data.description,
      departmentId: data.department_id || departmentId
    }).catch(err => {
      console.warn('[DepartmentIssueService] Background similarity analysis error:', err);
    });
  }

  return {
    id: data.id,
    departmentId: data.department_id,
    category: data.category,
    categoryLabel: ISSUE_CATEGORIES[data.category] || data.category,
    location: data.location,
    description: data.description,
    severity: data.severity,
    isAnonymous: data.is_anonymous,
    status: data.status,
    createdAt: data.created_at,
    departmentName: data.departments?.name || 'General Campus'
  };
}

/**
 * Fetch all issues reported by the current student
 * @param {string} studentId - UUID of student
 * @returns {Promise<Array>}
 */
export async function getStudentReportedIssues(studentId) {
  if (!studentId) return [];

  const { data, error } = await supabase
    .from('department_issues')
    .select(`
      id,
      category,
      location,
      description,
      severity,
      is_anonymous,
      status,
      created_at,
      departments (
        name
      )
    `)
    .eq('student_id', studentId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[DepartmentIssueService] Error fetching student issues:', error);
    throw new Error(error.message || 'Failed to fetch reported issues.');
  }

  return (data || []).map(item => ({
    id: item.id,
    category: item.category,
    categoryLabel: ISSUE_CATEGORIES[item.category] || item.category,
    location: item.location,
    description: item.description,
    severity: item.severity,
    isAnonymous: item.is_anonymous,
    status: item.status,
    createdAt: item.created_at,
    departmentName: item.departments?.name || 'General'
  }));
}

/**
 * Asynchronously selects reasonable candidate issues and runs similarity comparison (Phase 6.1)
 * @param {Object} newIssue
 * @param {string} newIssue.id - UUID of newly submitted issue
 * @param {string} newIssue.category - Issue category
 * @param {string} [newIssue.location] - Issue location
 * @param {string} newIssue.description - Issue description
 * @param {string} [newIssue.departmentId] - Optional department UUID
 * @returns {Promise<Array>} Comparison results
 */
export async function triggerSimilarityForIssue(newIssue) {
  if (!newIssue?.id || !newIssue?.description) return [];

  try {
    let candidates = [];

    let deptId = newIssue.departmentId || newIssue.department_id || null;

    // Guarantee departmentId: if not provided, resolve it from the issue record in database
    if (!deptId) {
      try {
        const { data: issueRow } = await supabase
          .from('department_issues')
          .select('department_id')
          .eq('id', newIssue.id)
          .maybeSingle();
        deptId = issueRow?.department_id || null;
      } catch (_) {}
    }

    // Halt immediately if departmentId cannot be resolved (no cross-department leakage allowed)
    if (!deptId) {
      console.warn('[DepartmentIssueService] Cannot trigger similarity: department_id is required.');
      return [];
    }

    // Attempt 1: Fetch via canonical RPC get_similarity_candidates (strictly scoped to deptId)
    const { data: rpcCandidates, error: rpcErr } = await supabase.rpc('get_similarity_candidates', {
      p_issue_id: newIssue.id,
      p_category: newIssue.category || null,
      p_department_id: deptId,
      p_limit: 10
    });

    if (!rpcErr && Array.isArray(rpcCandidates) && rpcCandidates.length > 0) {
      candidates = rpcCandidates;
    } else {
      // Attempt 2: Direct query under student's RLS session for same category/dept open issues
      let query = supabase
        .from('department_issues')
        .select('id, category, location, description, status, created_at, department_id')
        .neq('id', newIssue.id)
        .eq('status', 'open')
        .eq('department_id', deptId)
        .order('created_at', { ascending: false })
        .limit(10);

      if (newIssue.category) {
        query = query.eq('category', newIssue.category);
      }

      const { data: directCandidates, error: directErr } = await query;
      if (!directErr && Array.isArray(directCandidates)) {
        candidates = directCandidates;
      }
    }

    if (!candidates || candidates.length === 0) {
      return [];
    }

    // Compare new issue against each reasonable candidate
    const comparisonPromises = candidates.map(async candidate => {
      try {
        const simResult = await compareIssues({
          issueIdA: newIssue.id,
          issueIdB: candidate.id,
          issueA: {
            category: newIssue.category,
            location: newIssue.location || '',
            description: newIssue.description
          },
          issueB: {
            category: candidate.category,
            location: candidate.location || '',
            description: candidate.description
          }
        });

        // Phase 6.2: If issues are similar, chain duplicate vs related classification asynchronously
        if (simResult && simResult.similar) {
          classifyIssueRelationship({
            issueIdA: newIssue.id,
            issueIdB: candidate.id,
            issueA: {
              category: newIssue.category,
              location: newIssue.location || '',
              description: newIssue.description
            },
            issueB: {
              category: candidate.category,
              location: candidate.location || '',
              description: candidate.description
            },
            similarityScore: simResult.similarity_score,
            isSimilar: true
          }).then(relResult => {
            // Phase 6.3: If confirmed as duplicate, group issues asynchronously
            if (relResult && relResult.relationship === 'duplicate') {
              attachOrCreateGroupOnDuplicate({
                newIssue: {
                  id: newIssue.id,
                  category: newIssue.category,
                  location: newIssue.location || '',
                  description: newIssue.description,
                  departmentId: newIssue.departmentId || newIssue.department_id
                },
                duplicateCandidate: candidate
              }).catch(groupErr => {
                console.warn(`[DepartmentIssueService] Grouping failed for candidate ${candidate.id}:`, groupErr.message);
              });
            }
          }).catch(relErr => {
            console.warn(`[DepartmentIssueService] Relationship analysis failed for candidate ${candidate.id}:`, relErr.message);
          });
        }

        return simResult;
      } catch (err) {
        console.warn(`[DepartmentIssueService] Similarity check failed for candidate ${candidate.id}:`, err.message);
        return null;
      }
    });

    return await Promise.all(comparisonPromises);
  } catch (err) {
    console.warn('[DepartmentIssueService] Background similarity trigger failed:', err.message);
    return [];
  }
}

