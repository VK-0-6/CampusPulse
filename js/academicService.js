/**
 * Student Feedback & Community Improvement System
 * Academic Catalog Service (js/academicService.js)
 * Manages fetching departments, clean semesters, and subjects
 */

import { supabase, isSupabaseConfigured } from './supabase.js';

/**
 * Fetch all available semesters (cleaned & deduplicated to Semesters 1 through 8)
 * @returns {Promise<Array<{id: string, semester_number: number, academic_year: string}>>}
 */
export async function getSemesters() {
  if (!isSupabaseConfigured) {
    console.warn('[AcademicService] Supabase not configured. Returning fallback semesters.');
    return [];
  }

  const { data, error } = await supabase
    .from('semesters')
    .select('id, semester_number, academic_year')
    .order('semester_number', { ascending: true });

  if (error) {
    console.error('[AcademicService] Error fetching semesters:', error.message);
    throw error;
  }

  // Deduplicate by semester_number so each number (1-8) has exactly one option
  const seenNumbers = new Set();
  const cleanSemesters = [];

  for (const s of data || []) {
    if (!seenNumbers.has(s.semester_number) && s.semester_number >= 1 && s.semester_number <= 8) {
      seenNumbers.add(s.semester_number);
      cleanSemesters.push(s);
    }
  }

  return cleanSemesters;
}

/**
 * Fetch subjects filtered by semester
 * @param {string} semesterId - UUID of the selected semester
 * @returns {Promise<Array<{id: string, name: string, code: string, department_id: string}>>}
 */
export async function getSubjectsBySemester(semesterId) {
  if (!isSupabaseConfigured || !semesterId) {
    return [];
  }

  const { data, error } = await supabase
    .from('subjects')
    .select('id, name, code, semester_id')
    .eq('semester_id', semesterId)
    .order('code', { ascending: true });

  if (error) {
    console.error('[AcademicService] Error fetching subjects by semester:', error.message);
    throw error;
  }

  return data || [];
}

/**
 * Create a new subject for a semester or retrieve it if it already exists
 * @param {Object} params
 * @param {string} params.name - Subject Name (e.g. "Operating Systems")
 * @param {string} params.code - Subject Code (e.g. "CS402")
 * @param {string} params.semesterId - UUID of the semester
 * @returns {Promise<Object>} The created or existing subject
 */
export async function getOrCreateSubject({ name, code, semesterId }) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured.');
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Please enter a valid subject name.');
  }

  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new Error('Please enter a valid subject code.');
  }

  if (!semesterId) {
    throw new Error('Please select a valid semester.');
  }

  const trimmedName = name.trim();
  const normalizedCode = code.trim().toUpperCase();

  // 1. Check if this subject code already exists for this semester
  const { data: existing, error: checkError } = await supabase
    .from('subjects')
    .select('id, name, code, semester_id')
    .eq('semester_id', semesterId)
    .ilike('code', normalizedCode)
    .maybeSingle();

  if (checkError) {
    console.warn('[AcademicService] Check existing subject notice:', checkError.message);
  }

  if (existing) {
    console.info('[AcademicService] Found existing subject for semester:', existing.name, existing.code);
    return existing;
  }

  // 2. Insert new subject
  const { data: newSubject, error: insertError } = await supabase
    .from('subjects')
    .insert({
      name: trimmedName,
      code: normalizedCode,
      semester_id: semesterId
    })
    .select('id, name, code, semester_id')
    .single();

  if (insertError) {
    // If unique constraint collision occurs in parallel, fetch the existing subject
    const { data: retryExisting } = await supabase
      .from('subjects')
      .select('id, name, code, semester_id')
      .eq('semester_id', semesterId)
      .ilike('code', normalizedCode)
      .maybeSingle();

    if (retryExisting) return retryExisting;

    console.error('[AcademicService] Error inserting subject:', insertError.message);
    throw insertError;
  }

  return newSubject;
}

/**
 * Fetch all academic departments
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getDepartments() {
  if (!isSupabaseConfigured) return [];

  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .order('name', { ascending: true });

  if (error) {
    console.error('[AcademicService] Error fetching departments:', error.message);
    throw error;
  }

  return data || [];
}
