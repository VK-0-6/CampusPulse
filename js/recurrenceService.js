/**
 * Recurring Issue Detection Service (Phase 6.4)
 * Deterministically evaluates whether an Issue Group is recurring over time.
 * 
 * Strict Zero-PII: Operates solely on timestamps and counts. No student identities
 * are processed or stored.
 */

import { supabase } from './supabase.js';

// Centralized recurrence parameters
export const MIN_RECURRING_REPORTS = 3;
export const MIN_RECURRING_DATES = 2;
export const RECURRENCE_WINDOW_DAYS = 30;

/**
 * Pure deterministic recurrence evaluator for a collection of issue reports
 * @param {Array<Object>} reports - Array of report objects with created_at timestamps
 * @param {Object} [options]
 * @param {number} [options.minReports=3]
 * @param {number} [options.minDates=2]
 * @param {number} [options.windowDays=30]
 * @returns {Object} Recurrence metrics and classification
 */
export function evaluateRecurrence(reports = [], options = {}) {
  const minReports = options.minReports ?? MIN_RECURRING_REPORTS;
  const minDates = options.minDates ?? MIN_RECURRING_DATES;
  const windowDays = options.windowDays ?? RECURRENCE_WINDOW_DAYS;

  const validReports = (reports || []).filter(r => r && (r.created_at || r.createdAt));
  const reportCount = validReports.length;

  if (reportCount === 0) {
    return {
      is_recurring: false,
      report_count: 0,
      distinct_report_dates: 0,
      first_report_at: null,
      latest_report_at: null,
      time_span_days: 0.00,
      recurrence_rate: 0.00
    };
  }

  // Parse timestamps and collect distinct calendar dates (UTC)
  const timestamps = [];
  const dateSet = new Set();

  for (const r of validReports) {
    const rawDate = r.created_at || r.createdAt;
    const dateObj = new Date(rawDate);
    if (!isNaN(dateObj.getTime())) {
      timestamps.push(dateObj.getTime());
      const dateStr = dateObj.toISOString().split('T')[0];
      dateSet.add(dateStr);
    }
  }

  timestamps.sort((a, b) => a - b);
  const firstTimestamp = timestamps[0];
  const latestTimestamp = timestamps[timestamps.length - 1];

  const firstReportAt = new Date(firstTimestamp).toISOString();
  const latestReportAt = new Date(latestTimestamp).toISOString();
  const distinctReportDates = dateSet.size;

  // Time span in days
  const timeSpanDays = Number(((latestTimestamp - firstTimestamp) / (1000 * 60 * 60 * 24)).toFixed(2));

  // Recurrence Rule:
  // 1. Report count >= MIN_RECURRING_REPORTS (3)
  // 2. Distinct calendar dates >= MIN_RECURRING_DATES (2)
  // 3. Time span within RECURRENCE_WINDOW_DAYS (30)
  const isRecurring = Boolean(
    reportCount >= minReports &&
    distinctReportDates >= minDates &&
    timeSpanDays <= windowDays
  );

  // Recurrence rate (reports per week)
  let recurrenceRate = reportCount;
  if (timeSpanDays > 0) {
    recurrenceRate = Number((reportCount / (timeSpanDays / 7.0)).toFixed(2));
  }

  return {
    is_recurring: isRecurring,
    report_count: reportCount,
    distinct_report_dates: distinctReportDates,
    first_report_at: firstReportAt,
    latest_report_at: latestReportAt,
    time_span_days: timeSpanDays,
    recurrence_rate: recurrenceRate
  };
}

/**
 * Invokes the database RPC to calculate and record recurrence for an Issue Group
 * @param {string} groupId - UUID of the Issue Group
 * @param {Object} [options]
 * @returns {Promise<Object|null>}
 */
export async function calculateGroupRecurrence(groupId, options = {}) {
  if (!groupId) return null;

  try {
    const { data, error } = await supabase.rpc('calculate_group_recurrence', {
      p_group_id: groupId,
      p_window_days: options.windowDays || RECURRENCE_WINDOW_DAYS,
      p_min_reports: options.minReports || MIN_RECURRING_REPORTS,
      p_min_dates: options.minDates || MIN_RECURRING_DATES
    });

    if (error) {
      console.warn('[RecurrenceService] calculate_group_recurrence RPC error:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.warn('[RecurrenceService] Failed to calculate recurrence:', err.message);
    return null;
  }
}

/**
 * Fetches the recurrence record for an Issue Group (HOD/admin utility)
 * @param {string} groupId - UUID of the Issue Group
 * @returns {Promise<Object|null>}
 */
export async function getGroupRecurrence(groupId) {
  if (!groupId) return null;

  const { data, error } = await supabase
    .from('issue_group_recurrence')
    .select('*')
    .eq('issue_group_id', groupId)
    .single();

  if (error) {
    console.warn('[RecurrenceService] Could not fetch recurrence:', error.message);
    return null;
  }

  return data;
}
