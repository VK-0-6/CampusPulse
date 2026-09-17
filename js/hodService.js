/**
 * HOD Intelligence Dashboard Service (Phase 8)
 * Connects departmental administration to multi-phase analytical outputs.
 * 
 * Strict Privacy & Zero-PII:
 * - Operates only on aggregated issue groups and anonymized reports.
 * - Anonymous reports remain completely anonymous ("Student: Anonymous").
 * - Internal student IDs and roll numbers are NEVER exposed.
 */

import { supabase } from './supabase.js';

// ==============================================================================
// 1. Constants & Category Dictionaries
// ==============================================================================
export const DEPARTMENT_CATEGORIES = [
  'projector',
  'wifi',
  'lab_computer',
  'lab_equipment',
  'classroom_furniture',
  'electrical',
  'classroom_condition',
  'other'
];

export const CATEGORY_LABELS = {
  projector: 'Projector & AV',
  wifi: 'Wi-Fi & Internet',
  lab_computer: 'Lab Computers',
  lab_equipment: 'Lab Equipment',
  classroom_furniture: 'Furniture & Desks',
  electrical: 'Electrical & Fans',
  classroom_condition: 'Room Condition',
  other: 'Other Facility'
};

export const GROUP_STATUSES = ['open', 'resolved', 'closed'];

export const PRIORITY_LEVELS = ['High', 'Medium', 'Low'];

export const EARLY_WARNING_LEVELS = ['Alert', 'Emerging', 'Watch', 'Normal', 'Insufficient Data'];

// ==============================================================================
// 2. Data Normalizer (Null-safe & structure-agnostic)
// ==============================================================================

/**
 * Normalizes an issue group and its nested analytical records safely
 * @param {Object} rawGroup - Raw record from RPC or direct table join
 * @returns {Object} Normalized issue group
 */
export function normalizeGroup(rawGroup) {
  if (!rawGroup || typeof rawGroup !== 'object') return null;

  // Extract priority
  let priority = null;
  if (rawGroup.priority && typeof rawGroup.priority === 'object') {
    priority = rawGroup.priority;
  } else if (Array.isArray(rawGroup.issue_group_priority) && rawGroup.issue_group_priority.length > 0) {
    priority = rawGroup.issue_group_priority[0];
  } else if (rawGroup.issue_group_priority && typeof rawGroup.issue_group_priority === 'object') {
    priority = rawGroup.issue_group_priority;
  }

  // Extract early warning
  let early_warning = null;
  if (rawGroup.early_warning && typeof rawGroup.early_warning === 'object') {
    early_warning = rawGroup.early_warning;
  } else if (Array.isArray(rawGroup.issue_group_early_warning) && rawGroup.issue_group_early_warning.length > 0) {
    early_warning = rawGroup.issue_group_early_warning[0];
  } else if (rawGroup.issue_group_early_warning && typeof rawGroup.issue_group_early_warning === 'object') {
    early_warning = rawGroup.issue_group_early_warning;
  }

  // Extract recurrence
  let recurrence = null;
  if (rawGroup.recurrence && typeof rawGroup.recurrence === 'object') {
    recurrence = rawGroup.recurrence;
  } else if (Array.isArray(rawGroup.issue_group_recurrence) && rawGroup.issue_group_recurrence.length > 0) {
    recurrence = rawGroup.issue_group_recurrence[0];
  } else if (rawGroup.issue_group_recurrence && typeof rawGroup.issue_group_recurrence === 'object') {
    recurrence = rawGroup.issue_group_recurrence;
  }

  // Extract member reports
  let reports = [];
  if (Array.isArray(rawGroup.reports)) {
    reports = rawGroup.reports;
  } else if (Array.isArray(rawGroup.issue_group_members)) {
    reports = rawGroup.issue_group_members
      .map(m => m.department_issues || m)
      .filter(Boolean);
  }

  return {
    id: rawGroup.id,
    department_id: rawGroup.department_id || null,
    category: rawGroup.category || 'other',
    title: rawGroup.title || 'Untitled Issue Group',
    summary: rawGroup.summary || '',
    location: rawGroup.location || '',
    status: rawGroup.status || 'open',
    issue_count: rawGroup.issue_count || reports.length || 0,
    created_at: rawGroup.created_at,
    updated_at: rawGroup.updated_at,
    priority,
    early_warning,
    recurrence,
    reports
  };
}

// ==============================================================================
// 3. Database Fetch & RPC Methods
// ==============================================================================

/**
 * Fetches all issue groups and intelligence for the HOD dashboard
 * @returns {Promise<{ success: boolean, groups: Array<Object>, error?: string }>}
 */
export async function fetchHODDashboardData() {
  try {
    // 1. Preferred approach: Atomic consolidated RPC
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_hod_dashboard_data');

    if (!rpcError && rpcData && Array.isArray(rpcData.groups)) {
      const normalized = rpcData.groups.map(normalizeGroup).filter(Boolean);
      return {
        success: true,
        groups: normalized,
        departmentId: rpcData.department_id || null,
        departmentName: rpcData.department_name || null
      };
    }

    if (rpcError) {
      console.warn('[HODService] get_hod_dashboard_data RPC error, falling back to direct table join:', rpcError.message);
    }

    // 2. Fallback approach: Direct PostgREST multi-table join under RLS
    // Retrieve HOD department info
    let hodDeptId = null;
    let hodDeptName = null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('department_id, departments:department_id(name)')
          .eq('id', user.id)
          .maybeSingle();
        hodDeptId = profile?.department_id || null;
        hodDeptName = profile?.departments?.name || null;
      }
    } catch (_) {}

    let query = supabase
      .from('issue_groups')
      .select(`
        id,
        department_id,
        category,
        title,
        summary,
        location,
        status,
        issue_count,
        created_at,
        updated_at,
        issue_group_priority (*),
        issue_group_early_warning (*),
        issue_group_recurrence (*),
        issue_group_members (
          id,
          issue_id,
          created_at,
          department_issues (
            id,
            category,
            location,
            description,
            severity,
            is_anonymous,
            status,
            created_at
          )
        )
      `)
      .order('created_at', { ascending: false });

    if (hodDeptId) {
      query = query.eq('department_id', hodDeptId);
    }

    const { data: joinData, error: joinError } = await query;

    if (joinError) {
      console.error('[HODService] Direct table join error:', joinError.message);
      return { success: false, groups: [], error: joinError.message };
    }

    const normalized = (joinData || []).map(normalizeGroup).filter(Boolean);
    return {
      success: true,
      groups: normalized,
      departmentId: hodDeptId,
      departmentName: hodDeptName
    };
  } catch (err) {
    console.error('[HODService] Unexpected exception fetching dashboard data:', err);
    return { success: false, groups: [], error: err.message };
  }
}

/**
 * Updates an issue group's status (HOD only)
 * @param {string} groupId - UUID of the issue group
 * @param {string} newStatus - 'open' | 'resolved' | 'closed'
 * @returns {Promise<{ success: boolean, data?: Object, error?: string }>}
 */
export async function updateIssueGroupStatus(groupId, newStatus) {
  if (!groupId) return { success: false, error: 'Group ID is required.' };

  const validStatus = String(newStatus).toLowerCase().trim();
  if (!GROUP_STATUSES.includes(validStatus)) {
    return { success: false, error: `Invalid status. Must be one of: ${GROUP_STATUSES.join(', ')}` };
  }

  try {
    // 1. Try secure RPC
    const { data: rpcData, error: rpcError } = await supabase.rpc('update_issue_group_status', {
      p_group_id: groupId,
      p_status: validStatus
    });

    if (!rpcError && rpcData) {
      return { success: true, data: rpcData };
    }

    if (rpcError) {
      console.warn('[HODService] update_issue_group_status RPC error, attempting direct table update:', rpcError.message);
    }

    // 2. Direct table update fallback under RLS
    const { data: tableData, error: tableError } = await supabase
      .from('issue_groups')
      .update({ status: validStatus, updated_at: new Date().toISOString() })
      .eq('id', groupId)
      .select('*')
      .single();

    if (tableError) {
      return { success: false, error: tableError.message };
    }

    return { success: true, data: tableData };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ==============================================================================
// 4. Analytics & Metric Aggregation
// ==============================================================================

/**
 * Computes top-level summary metrics across issue groups
 * @param {Array<Object>} groups
 * @returns {Object} Summary counts
 */
export function computeSummaryCounts(groups = []) {
  let openIssues = 0;
  let highPriority = 0;
  let recurringIssues = 0;
  let emergingAlert = 0;
  let resolvedIssues = 0;

  for (const g of groups || []) {
    if (!g) continue;

    const status = (g.status || '').toLowerCase();
    if (status === 'open') {
      openIssues++;
    } else if (status === 'resolved') {
      resolvedIssues++;
    }

    // High priority
    const priorityLevel = (g.priority?.priority_level || '').toLowerCase();
    if (priorityLevel === 'high') {
      highPriority++;
    }

    // Recurring
    if (g.recurrence?.is_recurring === true) {
      recurringIssues++;
    }

    // Emerging or Alert early warning
    const warningLevel = (g.early_warning?.warning_level || '').toLowerCase();
    if (warningLevel === 'emerging' || warningLevel === 'alert') {
      emergingAlert++;
    }
  }

  return {
    openIssues,
    highPriority,
    recurringIssues,
    emergingAlert,
    resolvedIssues,
    totalGroups: (groups || []).length
  };
}

/**
 * Filters and orders open groups by priority_score DESC
 * @param {Array<Object>} groups
 * @returns {Array<Object>}
 */
export function getPriorityIssues(groups = []) {
  return (groups || [])
    .filter(g => (g?.status || '').toLowerCase() === 'open')
    .sort((a, b) => {
      const scoreA = typeof a?.priority?.priority_score === 'number' ? a.priority.priority_score : -1;
      const scoreB = typeof b?.priority?.priority_score === 'number' ? b.priority.priority_score : -1;
      return scoreB - scoreA;
    });
}

/**
 * Filters groups with warning level in Alert, Emerging, or Watch (excludes Normal and Insufficient Data)
 * Ordered by early_warning_score DESC
 * @param {Array<Object>} groups
 * @returns {Array<Object>}
 */
export function getEarlyWarningIssues(groups = []) {
  const allowedLevels = ['alert', 'emerging', 'watch'];
  return (groups || [])
    .filter(g => {
      const level = (g?.early_warning?.warning_level || '').toLowerCase();
      return allowedLevels.includes(level);
    })
    .sort((a, b) => {
      const scoreA = typeof a?.early_warning?.early_warning_score === 'number' ? a.early_warning.early_warning_score : -1;
      const scoreB = typeof b?.early_warning?.early_warning_score === 'number' ? b.early_warning.early_warning_score : -1;
      return scoreB - scoreA;
    });
}

/**
 * Filters groups that are recurring (is_recurring === true)
 * @param {Array<Object>} groups
 * @returns {Array<Object>}
 */
export function getRecurringIssues(groups = []) {
  return (groups || [])
    .filter(g => g?.recurrence?.is_recurring === true)
    .sort((a, b) => {
      const countA = a?.recurrence?.report_count ?? a?.reports?.length ?? 0;
      const countB = b?.recurrence?.report_count ?? b?.reports?.length ?? 0;
      return countB - countA;
    });
}

/**
 * Multi-criteria filter and search across all issue groups
 * @param {Array<Object>} groups
 * @param {Object} filters
 * @param {string} [filters.search='']
 * @param {string} [filters.status='all']
 * @param {string} [filters.priority='all']
 * @param {string} [filters.warning='all']
 * @param {string} [filters.category='all']
 * @returns {Array<Object>}
 */
export function filterIssueGroups(groups = [], {
  search = '',
  status = 'all',
  priority = 'all',
  warning = 'all',
  category = 'all'
} = {}) {
  const q = String(search || '').toLowerCase().trim();
  const statFilter = String(status || 'all').toLowerCase();
  const prioFilter = String(priority || 'all').toLowerCase();
  const warnFilter = String(warning || 'all').toLowerCase();
  const catFilter = String(category || 'all').toLowerCase();

  return (groups || []).filter(g => {
    if (!g) return false;

    // Search query: title, summary, location
    if (q) {
      const t = (g.title || '').toLowerCase();
      const s = (g.summary || '').toLowerCase();
      const l = (g.location || '').toLowerCase();
      if (!t.includes(q) && !s.includes(q) && !l.includes(q)) {
        return false;
      }
    }

    // Status filter
    if (statFilter !== 'all') {
      if ((g.status || '').toLowerCase() !== statFilter) return false;
    }

    // Priority filter
    if (prioFilter !== 'all') {
      const pLevel = (g.priority?.priority_level || '').toLowerCase();
      if (pLevel !== prioFilter) return false;
    }

    // Early warning filter
    if (warnFilter !== 'all') {
      const wLevel = (g.early_warning?.warning_level || '').toLowerCase();
      if (wLevel !== warnFilter) return false;
    }

    // Category filter
    if (catFilter !== 'all') {
      if ((g.category || '').toLowerCase() !== catFilter) return false;
    }

    return true;
  });
}

/**
 * Builds chronological date-bucketed timeline from a group's reports
 * @param {Array<Object>} reports
 * @returns {Array<{ date: string, dateLabel: string, count: number, reports: Array<Object> }>}
 */
export function buildReportTimeline(reports = []) {
  const map = new Map();

  for (const r of reports || []) {
    if (!r) continue;
    const rawDate = r.created_at || r.createdAt;
    if (!rawDate) continue;

    const d = new Date(rawDate);
    if (isNaN(d.getTime())) continue;

    const dateKey = d.toISOString().split('T')[0]; // YYYY-MM-DD
    if (!map.has(dateKey)) {
      map.set(dateKey, {
        date: dateKey,
        dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
        count: 0,
        reports: []
      });
    }

    const bucket = map.get(dateKey);
    bucket.count++;
    bucket.reports.push(r);
  }

  // Sort chronologically ascending
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ==============================================================================
// 5. Formatting & Presentation Helpers
// ==============================================================================

/**
 * Returns human-readable label for category
 * @param {string} cat
 * @returns {string}
 */
export function formatCategory(cat) {
  return CATEGORY_LABELS[cat] || (cat ? cat.replace(/_/g, ' ') : 'Other');
}

/**
 * Generates badge CSS classes and label for priority level
 * @param {string} [level='Low']
 * @param {number} [score=0]
 * @returns {{ cssClass: string, label: string }}
 */
export function formatPriorityBadge(level, score) {
  const l = (level || 'Low').toLowerCase();
  const s = typeof score === 'number' ? Math.round(score) : null;
  const scoreText = s !== null ? ` — ${s}` : '';

  if (l === 'high') {
    return { cssClass: 'badge-priority-high', label: `HIGH${scoreText}` };
  }
  if (l === 'medium') {
    return { cssClass: 'badge-priority-medium', label: `MEDIUM${scoreText}` };
  }
  return { cssClass: 'badge-priority-low', label: `LOW${scoreText}` };
}

/**
 * Generates badge CSS classes and label for early warning level
 * @param {string} [level='Normal']
 * @param {number} [score=null]
 * @returns {{ cssClass: string, label: string }}
 */
export function formatWarningBadge(level, score) {
  const l = (level || 'Normal').toLowerCase();
  const s = typeof score === 'number' ? Math.round(score) : null;

  if (l === 'alert') {
    return { cssClass: 'badge-warning-alert', label: `ALERT${s !== null ? ' — ' + s : ''}` };
  }
  if (l === 'emerging') {
    return { cssClass: 'badge-warning-emerging', label: `EMERGING${s !== null ? ' — ' + s : ''}` };
  }
  if (l === 'watch') {
    return { cssClass: 'badge-warning-watch', label: `WATCH${s !== null ? ' — ' + s : ''}` };
  }
  if (l === 'insufficient data') {
    return { cssClass: 'badge-warning-insufficient', label: 'INSUFFICIENT DATA' };
  }
  return { cssClass: 'badge-warning-normal', label: `NORMAL${s !== null ? ' — ' + s : ''}` };
}

/**
 * Returns badge styling for issue group status
 * @param {string} status
 * @returns {{ cssClass: string, label: string }}
 */
export function formatStatusBadge(status) {
  const s = (status || 'open').toLowerCase();
  if (s === 'resolved') {
    return { cssClass: 'badge-status-resolved', label: 'Resolved' };
  }
  if (s === 'closed') {
    return { cssClass: 'badge-status-closed', label: 'Closed' };
  }
  return { cssClass: 'badge-status-open', label: 'Open' };
}

/**
 * Strictly protects student identity in reports
 * @param {boolean} isAnonymous
 * @returns {string}
 */
export function formatStudentIdentity(isAnonymous) {
  if (isAnonymous === true) {
    return 'Student: Anonymous';
  }
  return 'Student: Verified Student (Protected)';
}
