/**
 * Priority Scoring & Early Warning Intelligence Service (Phase 7)
 * Deterministic, Explainable, Zero-AI Analytical Engine
 * 
 * Strict Zero-PII: Operates purely on counts, severities, and timestamps.
 * No student identities or PII are processed or stored.
 */

import { supabase } from './supabase.js';
import { evaluateRecurrence } from './recurrenceService.js';

// ==============================================================================
// 1. Centralized Priority Parameters & Weights
// ==============================================================================
export const PRIORITY_WEIGHTS = {
  severity: 0.35,
  impact: 0.30,
  recurrence: 0.20,
  recency: 0.15
};

export const SEVERITY_SCORES = {
  low: 25.00,
  medium: 60.00,
  high: 100.00
};

export const IMPACT_THRESHOLDS = [
  { minReports: 20, score: 100.00 },
  { minReports: 10, score: 80.00 },
  { minReports: 5, score: 60.00 },
  { minReports: 3, score: 40.00 },
  { minReports: 1, score: 20.00 },
  { minReports: 0, score: 0.00 }
];

export const RECENCY_THRESHOLDS = [
  { maxDays: 3.0, score: 100.00 },
  { maxDays: 7.0, score: 80.00 },
  { maxDays: 14.0, score: 60.00 },
  { maxDays: 30.0, score: 40.00 },
  { maxDays: Infinity, score: 20.00 }
];

export const PRIORITY_LEVELS = [
  { minScore: 70.0, level: 'High' },
  { minScore: 40.0, level: 'Medium' },
  { minScore: 0.0, level: 'Low' }
];

// ==============================================================================
// 2. Centralized Early Warning Parameters & Weights
// ==============================================================================
export const EARLY_WARNING_WEIGHTS = {
  growth: 0.45,
  recentVolume: 0.25,
  recurrence: 0.20,
  newness: 0.10
};

export const MIN_EARLY_WARNING_REPORTS = 2;
export const MIN_EARLY_WARNING_AGE_DAYS = 2.0;

export const RECENT_VOLUME_THRESHOLDS = [
  { minCount: 5, score: 100.00 },
  { minCount: 3, score: 75.00 },
  { minCount: 2, score: 50.00 },
  { minCount: 1, score: 25.00 },
  { minCount: 0, score: 0.00 }
];

export const NEWNESS_THRESHOLDS = [
  { maxAgeDays: 3.0, score: 100.00 },
  { maxAgeDays: 7.0, score: 80.00 },
  { maxAgeDays: 14.0, score: 60.00 },
  { maxAgeDays: 30.0, score: 40.00 },
  { maxAgeDays: Infinity, score: 20.00 }
];

export const EARLY_WARNING_LEVELS = [
  { minScore: 75.0, level: 'Alert' },
  { minScore: 50.0, level: 'Emerging' },
  { minScore: 30.0, level: 'Watch' },
  { minScore: 0.0, level: 'Normal' }
];

// ==============================================================================
// 3. Pure Deterministic Helper Functions
// ==============================================================================

/**
 * Maps severity string to numerical severity score
 * @param {string} severity - 'low' | 'medium' | 'high'
 * @returns {number}
 */
export function getSeverityScore(severity) {
  if (!severity) return SEVERITY_SCORES.low;
  const s = String(severity).toLowerCase().trim();
  return SEVERITY_SCORES[s] ?? SEVERITY_SCORES.low;
}

/**
 * Determines highest severity in a list of severities
 * @param {Array<string>} severities
 * @returns {string} 'low' | 'medium' | 'high'
 */
export function getHighestSeverity(severities = []) {
  const norm = severities.map(s => (s ? String(s).toLowerCase().trim() : 'low'));
  if (norm.includes('high')) return 'high';
  if (norm.includes('medium')) return 'medium';
  return 'low';
}

/**
 * Calculates report impact score from report count
 * @param {number} count
 * @returns {number}
 */
export function getImpactScore(count) {
  for (const t of IMPACT_THRESHOLDS) {
    if (count >= t.minReports) return t.score;
  }
  return 0.00;
}

/**
 * Calculates recency score from days since latest report
 * @param {number} daysSinceLatest
 * @returns {number}
 */
export function getRecencyScore(daysSinceLatest) {
  if (daysSinceLatest < 0 || isNaN(daysSinceLatest)) return 100.00;
  for (const t of RECENCY_THRESHOLDS) {
    if (daysSinceLatest <= t.maxDays) return t.score;
  }
  return 20.00;
}

/**
 * Maps priority score to categorical level
 * @param {number} score
 * @returns {string} 'Low' | 'Medium' | 'High'
 */
export function mapPriorityLevel(score) {
  for (const l of PRIORITY_LEVELS) {
    if (score >= l.minScore) return l.level;
  }
  return 'Low';
}

/**
 * Calculates growth score and growth rate safely
 * @param {number} recentCount
 * @param {number} previousCount
 * @returns {{ growthScore: number, growthRate: number }}
 */
export function getGrowthScoreAndRate(recentCount, previousCount) {
  let growthRate = 0.00;
  let growthScore = 0.00;

  if (previousCount > 0) {
    growthRate = Number(((recentCount - previousCount) / previousCount).toFixed(2));
    if (growthRate <= 0) {
      growthScore = 0.00;
    } else if (growthRate <= 0.50) {
      growthScore = 40.00;
    } else if (growthRate <= 1.00) {
      growthScore = 70.00;
    } else {
      growthScore = 100.00;
    }
  } else {
    // previousCount === 0 safe division handling
    if (recentCount === 0) {
      growthRate = 0.00;
      growthScore = 0.00;
    } else if (recentCount === 1) {
      growthRate = 1.00;
      growthScore = 40.00;
    } else if (recentCount === 2) {
      growthRate = 2.00;
      growthScore = 70.00;
    } else {
      growthRate = 3.00;
      growthScore = 100.00;
    }
  }

  return { growthScore, growthRate };
}

/**
 * Calculates recent volume score from recent 7-day count
 * @param {number} count
 * @returns {number}
 */
export function getRecentVolumeScore(count) {
  for (const t of RECENT_VOLUME_THRESHOLDS) {
    if (count >= t.minCount) return t.score;
  }
  return 0.00;
}

/**
 * Calculates newness score from group age in days
 * @param {number} groupAgeDays
 * @returns {number}
 */
export function getNewnessScore(groupAgeDays) {
  if (groupAgeDays < 0 || isNaN(groupAgeDays)) return 100.00;
  for (const t of NEWNESS_THRESHOLDS) {
    if (groupAgeDays <= t.maxAgeDays) return t.score;
  }
  return 20.00;
}

/**
 * Maps early warning score to categorical level
 * @param {number} score
 * @returns {string} 'Normal' | 'Watch' | 'Emerging' | 'Alert'
 */
export function mapEarlyWarningLevel(score) {
  for (const l of EARLY_WARNING_LEVELS) {
    if (score >= l.minScore) return l.level;
  }
  return 'Normal';
}

// ==============================================================================
// 4. Core Calculators
// ==============================================================================

/**
 * Pure deterministic Priority Score calculator
 * @param {Object} params
 * @param {string} [params.severity='low']
 * @param {number} [params.reportCount=1]
 * @param {boolean} [params.isRecurring=false]
 * @param {number} [params.daysSinceLatest=0]
 * @returns {Object} Priority metrics, factor scores, and level
 */
export function calculatePriorityScore({
  severity = 'low',
  reportCount = 1,
  isRecurring = false,
  daysSinceLatest = 0
}) {
  if (reportCount <= 0) {
    return {
      priority_score: 0.00,
      priority_level: 'Low',
      severity_score: 0.00,
      impact_score: 0.00,
      recurrence_score: 0.00,
      recency_score: 0.00,
      max_severity: 'low',
      report_count: 0,
      days_since_latest: 0.00
    };
  }

  const maxSeverity = String(severity).toLowerCase().trim();
  const severityScore = getSeverityScore(maxSeverity);
  const impactScore = getImpactScore(reportCount);
  const recurrenceScore = isRecurring ? 100.00 : 0.00;
  const recencyScore = getRecencyScore(daysSinceLatest);

  const rawScore = (severityScore * PRIORITY_WEIGHTS.severity) +
                   (impactScore * PRIORITY_WEIGHTS.impact) +
                   (recurrenceScore * PRIORITY_WEIGHTS.recurrence) +
                   (recencyScore * PRIORITY_WEIGHTS.recency);

  const boundedScore = Math.max(0.00, Math.min(100.00, rawScore));
  const priorityScore = Number(boundedScore.toFixed(2));
  const priorityLevel = mapPriorityLevel(priorityScore);

  return {
    priority_score: priorityScore,
    priority_level: priorityLevel,
    severity_score: severityScore,
    impact_score: impactScore,
    recurrence_score: recurrenceScore,
    recency_score: recencyScore,
    max_severity: maxSeverity,
    report_count: reportCount,
    days_since_latest: Number(Number(daysSinceLatest).toFixed(2))
  };
}

/**
 * Pure deterministic Early Warning Score calculator
 * @param {Object} params
 * @param {number} params.recentCount
 * @param {number} params.previousCount
 * @param {boolean} [params.isRecurring=false]
 * @param {number} [params.groupAgeDays=0]
 * @param {number} [params.totalReports=0]
 * @returns {Object} Early Warning metrics, factor scores, and level
 */
export function calculateEarlyWarningScore({
  recentCount = 0,
  previousCount = 0,
  isRecurring = false,
  groupAgeDays = 0,
  totalReports = 0
}) {
  // Minimum-Data Safeguards
  if (totalReports < MIN_EARLY_WARNING_REPORTS || groupAgeDays < MIN_EARLY_WARNING_AGE_DAYS) {
    return {
      early_warning_score: null,
      warning_level: 'Insufficient Data',
      has_sufficient_data: false,
      growth_score: 0.00,
      recent_volume_score: 0.00,
      recurrence_score: 0.00,
      newness_score: 0.00,
      recent_7_day_count: recentCount,
      previous_7_day_count: previousCount,
      growth_rate: 0.00,
      group_age_days: Number(Number(groupAgeDays).toFixed(2))
    };
  }

  const { growthScore, growthRate } = getGrowthScoreAndRate(recentCount, previousCount);
  const recentVolumeScore = getRecentVolumeScore(recentCount);
  const recurrenceScore = isRecurring ? 100.00 : 0.00;
  const newnessScore = getNewnessScore(groupAgeDays);

  const rawScore = (growthScore * EARLY_WARNING_WEIGHTS.growth) +
                   (recentVolumeScore * EARLY_WARNING_WEIGHTS.recentVolume) +
                   (recurrenceScore * EARLY_WARNING_WEIGHTS.recurrence) +
                   (newnessScore * EARLY_WARNING_WEIGHTS.newness);

  const boundedScore = Math.max(0.00, Math.min(100.00, rawScore));
  const earlyWarningScore = Number(boundedScore.toFixed(2));
  const warningLevel = mapEarlyWarningLevel(earlyWarningScore);

  return {
    early_warning_score: earlyWarningScore,
    warning_level: warningLevel,
    has_sufficient_data: true,
    growth_score: growthScore,
    recent_volume_score: recentVolumeScore,
    recurrence_score: recurrenceScore,
    newness_score: newnessScore,
    recent_7_day_count: recentCount,
    previous_7_day_count: previousCount,
    growth_rate: growthRate,
    group_age_days: Number(Number(groupAgeDays).toFixed(2))
  };
}

/**
 * Pure evaluator that computes Priority and Early Warning from an array of reports
 * @param {Array<Object>} reports - Reports belonging to the Issue Group
 * @param {Object} [options]
 * @param {Date|string|number} [options.referenceDate] - Reference timestamp (default: now)
 * @param {boolean} [options.isRecurring] - Optional recurrence override
 * @returns {{ priority: Object, early_warning: Object, recurrence: Object }}
 */
export function evaluateGroupAnalytics(reports = [], options = {}) {
  const refTime = options.referenceDate ? new Date(options.referenceDate).getTime() : Date.now();
  const validReports = (reports || []).filter(r => r && (r.created_at || r.createdAt));
  const totalReports = validReports.length;

  // Recurrence evaluation
  let recurrence = evaluateRecurrence(validReports);
  if (typeof options.isRecurring === 'boolean') {
    recurrence.is_recurring = options.isRecurring;
  }

  if (totalReports === 0) {
    return {
      priority: calculatePriorityScore({ reportCount: 0 }),
      early_warning: calculateEarlyWarningScore({ totalReports: 0 }),
      recurrence
    };
  }

  // Severities
  const severities = validReports.map(r => r.severity || r.predicted_severity || 'low');
  const maxSeverity = getHighestSeverity(severities);

  // Timestamps
  const timestamps = validReports.map(r => new Date(r.created_at || r.createdAt).getTime()).sort((a, b) => a - b);
  const firstTimestamp = timestamps[0];
  const latestTimestamp = timestamps[timestamps.length - 1];

  const daysSinceLatest = Math.max(0, (refTime - latestTimestamp) / (1000 * 60 * 60 * 24));
  const groupAgeDays = Math.max(0, (refTime - firstTimestamp) / (1000 * 60 * 60 * 24));

  // 7-day windows
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const sevenDaysAgo = refTime - (7 * MS_PER_DAY);
  const fourteenDaysAgo = refTime - (14 * MS_PER_DAY);

  let recentCount = 0;
  let previousCount = 0;

  for (const t of timestamps) {
    if (t >= sevenDaysAgo && t <= refTime) {
      recentCount++;
    } else if (t >= fourteenDaysAgo && t < sevenDaysAgo) {
      previousCount++;
    }
  }

  const priority = calculatePriorityScore({
    severity: maxSeverity,
    reportCount: totalReports,
    isRecurring: recurrence.is_recurring,
    daysSinceLatest
  });

  const early_warning = calculateEarlyWarningScore({
    recentCount,
    previousCount,
    isRecurring: recurrence.is_recurring,
    groupAgeDays,
    totalReports
  });

  return { priority, early_warning, recurrence };
}

// ==============================================================================
// 5. Database RPC & Remote Client Methods
// ==============================================================================

/**
 * Invokes the database RPC to calculate and record Priority and Early Warning atomically
 * @param {string} groupId - UUID of the Issue Group
 * @returns {Promise<Object|null>}
 */
export async function calculateGroupAnalyticsRPC(groupId) {
  if (!groupId) return null;

  try {
    const { data, error } = await supabase.rpc('calculate_group_analytics', {
      p_group_id: groupId
    });

    if (error) {
      console.warn('[PriorityWarningService] calculate_group_analytics RPC error:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.warn('[PriorityWarningService] Failed to calculate group analytics:', err.message);
    return null;
  }
}

/**
 * Fetches the current Priority record for an Issue Group (HOD only)
 * @param {string} groupId - UUID of the Issue Group
 * @returns {Promise<Object|null>}
 */
export async function getGroupPriority(groupId) {
  if (!groupId) return null;

  const { data, error } = await supabase
    .from('issue_group_priority')
    .select('*')
    .eq('issue_group_id', groupId)
    .single();

  if (error) {
    console.warn('[PriorityWarningService] Could not fetch priority:', error.message);
    return null;
  }

  return data;
}

/**
 * Fetches the current Early Warning record for an Issue Group (HOD only)
 * @param {string} groupId - UUID of the Issue Group
 * @returns {Promise<Object|null>}
 */
export async function getGroupEarlyWarning(groupId) {
  if (!groupId) return null;

  const { data, error } = await supabase
    .from('issue_group_early_warning')
    .select('*')
    .eq('issue_group_id', groupId)
    .single();

  if (error) {
    console.warn('[PriorityWarningService] Could not fetch early warning:', error.message);
    return null;
  }

  return data;
}
