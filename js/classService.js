/**
 * Student Feedback & Community Improvement System
 * Class Management Service (js/classService.js)
 * Code generation, class creation, enrollment, and roster fetching
 */

import { supabase, isSupabaseConfigured } from './supabase.js';

// Safe uppercase alphanumeric character set omitting ambiguous characters (0, O, 1, I)
const CODE_CHARACTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Generates a random 6-character uppercase alphanumeric class code
 * @returns {string} 6-character code (e.g. "K7P4XZ")
 */
export function generateClassCode() {
  let result = '';
  const charLength = CODE_CHARACTERS.length;
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * charLength);
    result += CODE_CHARACTERS.charAt(randomIndex);
  }
  return result;
}

/**
 * Normalizes and validates a user-entered class code
 * @param {string} code 
 * @returns {string} normalized 6-character uppercase code
 */
export function normalizeClassCode(code) {
  if (!code || typeof code !== 'string') return '';
  return code.trim().toUpperCase();
}

/**
 * Creates a new class for a faculty member
 * Enforces rule: Only ONE active class per faculty for the same subject/semester
 * @param {Object} params
 * @param {string} params.subjectId - UUID of the subject
 * @param {string} params.facultyId - UUID of the faculty profile
 * @returns {Promise<Object>} Created class details
 */
export async function createClass({ subjectId, facultyId, departmentId }) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Please supply valid credentials in .env.');
  }

  if (!subjectId) throw new Error('Please select a valid subject.');
  if (!facultyId) throw new Error('Faculty user ID is required.');

  let resolvedDeptId = departmentId || null;
  if (!resolvedDeptId) {
    try {
      const { data: facultyProfile } = await supabase
        .from('profiles')
        .select('department_id')
        .eq('id', facultyId)
        .maybeSingle();
      resolvedDeptId = facultyProfile?.department_id || null;
    } catch (_) {}
  }

  // 1. Check if faculty already has an active class for this subject
  const { data: existingActive, error: checkActiveError } = await supabase
    .from('classes')
    .select(`
      id,
      class_code,
      subjects (
        name,
        code,
        semesters (
          semester_number
        )
      )
    `)
    .eq('faculty_id', facultyId)
    .eq('subject_id', subjectId)
    .eq('is_active', true)
    .maybeSingle();

  if (checkActiveError) {
    console.warn('[ClassService] Active class check notice:', checkActiveError.message);
  }

  if (existingActive) {
    const subName = existingActive.subjects?.name || 'this subject';
    const semNum = existingActive.subjects?.semesters?.semester_number;
    const semText = semNum ? ` in Semester ${semNum}` : '';
    throw new Error(`You already have an active class for ${subName}${semText} (Class Code: ${existingActive.class_code}).`);
  }

  // 2. Generate a unique 6-character code with retry logic
  let classCode = '';
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 5) {
    attempts++;
    const candidate = generateClassCode();
    const { data: existing } = await supabase
      .from('classes')
      .select('id')
      .eq('class_code', candidate)
      .maybeSingle();

    if (!existing) {
      classCode = candidate;
      isUnique = true;
    }
  }

  if (!classCode) {
    throw new Error('Could not generate a unique class code. Please try again.');
  }

  // 3. Insert class into database
  const { data: insertedClass, error: insertError } = await supabase
    .from('classes')
    .insert({
      subject_id: subjectId,
      faculty_id: facultyId,
      department_id: resolvedDeptId,
      class_code: classCode,
      is_active: true
    })
    .select(`
      id,
      department_id,
      class_code,
      is_active,
      created_at,
      subjects (
        id,
        name,
        code,
        semesters (
          id,
          semester_number,
          academic_year
        )
      )
    `)
    .single();

  if (insertError) {
    if (insertError.code === '23505' || (insertError.message && insertError.message.includes('uq_idx_classes_active_faculty_subject'))) {
      throw new Error('You already have an active class for this subject in this semester.');
    }
    console.error('[ClassService] Error inserting class:', insertError.message);
    throw insertError;
  }

  return insertedClass;
}

/**
 * Fetches all classes created by a specific faculty member
 * @param {string} facultyId - UUID of the faculty profile
 * @returns {Promise<Array>} List of classes with enrolled count
 */
export async function getFacultyClasses(facultyId) {
  if (!isSupabaseConfigured || !facultyId) return [];

  const { data, error } = await supabase
    .from('classes')
    .select(`
      id,
      class_code,
      is_active,
      created_at,
      subjects (
        id,
        name,
        code,
        semesters (
          id,
          semester_number,
          academic_year
        )
      ),
      class_members ( count ),
      class_feedback_sessions ( count )
    `)
    .eq('faculty_id', facultyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[ClassService] Error fetching faculty classes:', error.message);
    throw error;
  }

  // Transform counts from [{ count: N }] to number
  return (data || []).map(cls => ({
    ...cls,
    enrolledCount: cls.class_members?.[0]?.count ?? (Array.isArray(cls.class_members) ? cls.class_members.length : 0),
    sessionCount: cls.class_feedback_sessions?.[0]?.count ?? (Array.isArray(cls.class_feedback_sessions) ? cls.class_feedback_sessions.length : 0)
  }));
}

/**
 * Fetches list of enrolled students for a given class
 * @param {string} classId - UUID of the class
 * @returns {Promise<Array>} List of student enrollments
 */
export async function getClassEnrolledStudents(classId) {
  if (!isSupabaseConfigured || !classId) return [];

  const { data, error } = await supabase
    .from('class_members')
    .select(`
      id,
      joined_at,
      profiles:student_id (
        id,
        full_name,
        email,
        roll_number
      )
    `)
    .eq('class_id', classId)
    .order('joined_at', { ascending: false });

  if (error) {
    console.error('[ClassService] Error fetching enrolled students:', error.message);
    throw error;
  }

  return data || [];
}

/**
 * Toggle active/inactive status of a class
 * Enforces rule: Cannot activate a class if another active class already exists for that subject
 * @param {string} classId - UUID of the class
 * @param {boolean} isActive - new status
 * @returns {Promise<boolean>}
 */
export async function toggleClassStatus(classId, isActive) {
  if (!isSupabaseConfigured) return false;

  // If activating, verify no other active class exists for the same faculty and subject
  if (isActive) {
    const { data: currentCls } = await supabase
      .from('classes')
      .select(`
        faculty_id,
        subject_id,
        subjects (
          name,
          semesters (
            semester_number
          )
        )
      `)
      .eq('id', classId)
      .single();

    if (currentCls) {
      const { data: duplicateActive } = await supabase
        .from('classes')
        .select('id, class_code')
        .eq('faculty_id', currentCls.faculty_id)
        .eq('subject_id', currentCls.subject_id)
        .eq('is_active', true)
        .neq('id', classId)
        .maybeSingle();

      if (duplicateActive) {
        const subName = currentCls.subjects?.name || 'this subject';
        const semNum = currentCls.subjects?.semesters?.semester_number;
        const semText = semNum ? ` in Semester ${semNum}` : '';
        throw new Error(`Cannot activate: You already have an active class for ${subName}${semText} (Class Code: ${duplicateActive.class_code}). Only one active class is permitted per subject.`);
      }
    }
  }

  const { error } = await supabase
    .from('classes')
    .update({ is_active: isActive })
    .eq('id', classId);

  if (error) {
    if (error.code === '23505' || (error.message && error.message.includes('uq_idx_classes_active_faculty_subject'))) {
      throw new Error('You already have an active class for this subject in this semester.');
    }
    console.error('[ClassService] Error updating class status:', error.message);
    throw error;
  }

  return true;
}

/**
 * Join a class using its 6-character code
 * @param {Object} params
 * @param {string} params.classCode - 6-character code
 * @param {string} params.studentId - UUID of the student profile
 * @returns {Promise<Object>} Joined class summary
 */
export async function joinClassByCode({ classCode, studentId }) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Please supply valid credentials in .env.');
  }

  const normalizedCode = normalizeClassCode(classCode);

  if (!normalizedCode || normalizedCode.length !== 6) {
    throw new Error('Invalid class code. Must contain exactly 6 characters.');
  }

  if (!studentId) {
    throw new Error('Student identifier is required.');
  }

  // 1. Locate the class by code
  // Try secure RPC find_class_by_code first to safely check active/inactive status
  let targetClass = null;

  try {
    const { data: rpcRows, error: rpcError } = await supabase
      .rpc('find_class_by_code', { p_code: normalizedCode });

    if (!rpcError && Array.isArray(rpcRows) && rpcRows.length > 0) {
      targetClass = {
        id: rpcRows[0].id,
        class_code: rpcRows[0].class_code,
        is_active: rpcRows[0].is_active,
        subjects: {
          name: rpcRows[0].subject_name,
          code: rpcRows[0].subject_code
        }
      };
    }
  } catch (rpcErr) {
    console.warn('[ClassService] RPC lookup notice, falling back:', rpcErr);
  }

  // Fallback to direct query if RPC is not available
  if (!targetClass) {
    const { data: directClass, error: lookupError } = await supabase
      .from('classes')
      .select(`
        id,
        department_id,
        class_code,
        is_active,
        subjects (
          id,
          name,
          code
        )
      `)
      .eq('class_code', normalizedCode)
      .maybeSingle();

    if (lookupError) {
      console.error('[ClassService] Lookup error:', lookupError.message);
      throw lookupError;
    }
    targetClass = directClass;
  }

  if (!targetClass) {
    throw new Error('Class not found. Please check the 6-character code and try again.');
  }

  if (!targetClass.is_active) {
    throw new Error('This class is no longer active.');
  }

  // Verify student belongs to the same department as the class
  if (targetClass.department_id) {
    const { data: studentProfile } = await supabase
      .from('profiles')
      .select('department_id')
      .eq('id', studentId)
      .maybeSingle();

    if (studentProfile?.department_id && studentProfile.department_id !== targetClass.department_id) {
      throw new Error('Students can only enroll in classes within their department.');
    }
  }

  // 2. Check if student is already enrolled
  const { data: existingEnrollment, error: checkError } = await supabase
    .from('class_members')
    .select('id')
    .eq('class_id', targetClass.id)
    .eq('student_id', studentId)
    .maybeSingle();

  if (checkError) {
    console.error('[ClassService] Enrollment check error:', checkError.message);
    throw checkError;
  }

  if (existingEnrollment) {
    throw new Error('You are already enrolled in this class.');
  }

  // 3. Register enrollment
  const { error: joinError } = await supabase
    .from('class_members')
    .insert({
      class_id: targetClass.id,
      student_id: studentId
    });

  if (joinError) {
    const errText = (joinError.message || '').toLowerCase();
    if (errText.includes('policy') || errText.includes('department') || errText.includes('row-level security')) {
      throw new Error('Students can only enroll in classes within their department.');
    }
    console.error('[ClassService] Join error:', joinError.message);
    throw joinError;
  }

  return {
    success: true,
    classId: targetClass.id,
    classCode: targetClass.class_code,
    subjectName: targetClass.subjects?.name || 'Class',
    subjectCode: targetClass.subjects?.code || ''
  };
}

/**
 * Fetch all classes a student is enrolled in
 * @param {string} studentId - UUID of the student
 * @returns {Promise<Array>} List of enrolled classes
 */
export async function getStudentEnrolledClasses(studentId) {
  if (!isSupabaseConfigured || !studentId) return [];

  const { data, error } = await supabase
    .from('class_members')
    .select(`
      id,
      joined_at,
      classes:class_id (
        id,
        class_code,
        is_active,
        faculty:faculty_id (
          id,
          full_name,
          email
        ),
        subjects:subject_id (
          id,
          name,
          code,
          semesters:semester_id (
            id,
            semester_number,
            academic_year
          )
        )
      )
    `)
    .eq('student_id', studentId)
    .order('joined_at', { ascending: false });

  if (error) {
    console.error('[ClassService] Error fetching student classes:', error.message);
    throw error;
  }

  return (data || [])
    .filter(item => item.classes)
    .map(item => ({
      membershipId: item.id,
      joinedAt: item.joined_at,
      classId: item.classes.id,
      classCode: item.classes.class_code,
      isActive: item.classes.is_active,
      facultyName: item.classes.faculty?.full_name || 'Faculty Member',
      subjectName: item.classes.subjects?.name || 'Subject',
      subjectCode: item.classes.subjects?.code || '',
      semesterNumber: item.classes.subjects?.semesters?.semester_number || 'N/A',
      academicYear: item.classes.subjects?.semesters?.academic_year || ''
    }));
}

/**
 * Remove a student's enrollment from a class (Leave Class)
 * Deletes ONLY from public.class_members for the authenticated student.
 * Protected by RLS class_members_delete_policy (USING student_id = auth.uid()).
 *
 * @param {Object} params
 * @param {string} params.classId - UUID of the class
 * @param {string} params.studentId - UUID of the authenticated student
 * @returns {Promise<{ success: boolean }>}
 */
export async function leaveClass({ classId, studentId }) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Please supply valid credentials in .env.');
  }

  if (!classId) {
    throw new Error('Class identifier is required.');
  }

  if (!studentId) {
    throw new Error('Student identifier is required.');
  }

  const { error } = await supabase
    .from('class_members')
    .delete()
    .eq('class_id', classId)
    .eq('student_id', studentId);

  if (error) {
    console.error('[ClassService] Error leaving class:', error.message);
    throw new Error(error.message || 'Failed to leave class.');
  }

  return { success: true };
}

/**
 * Permanently deletes an unused class that has ZERO feedback sessions.
 * Safety Rule: Classes with >= 1 feedback sessions MUST NOT be deleted.
 * RLS on public.classes enforces auth.uid() = faculty_id.
 *
 * @param {Object} params
 * @param {string} params.classId - UUID of the class to delete
 * @param {string} params.facultyId - UUID of the authenticated faculty member
 * @returns {Promise<{ success: boolean }>}
 */
export async function deleteClass({ classId, facultyId }) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Please supply valid credentials in .env.');
  }

  if (!classId) {
    throw new Error('Class identifier is required.');
  }

  if (!facultyId) {
    throw new Error('Faculty identifier is required.');
  }

  // 1. Safety verification gate: check for existing feedback sessions
  const { count, error: countError } = await supabase
    .from('class_feedback_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('class_id', classId);

  if (countError) {
    console.error('[ClassService] Error checking class sessions before delete:', countError.message);
    throw new Error('Failed to verify class session status before deletion.');
  }

  if (count && count > 0) {
    throw new Error('This class contains active or historical feedback sessions and cannot be permanently deleted. Archive the class instead to preserve teaching and student feedback records.');
  }

  // 2. Perform safe single-row deletion on classes (RLS verifies faculty_id = auth.uid())
  const { error: deleteError } = await supabase
    .from('classes')
    .delete()
    .eq('id', classId)
    .eq('faculty_id', facultyId);

  if (deleteError) {
    console.error('[ClassService] Error deleting class:', deleteError.message);
    throw new Error(deleteError.message || 'Failed to delete class.');
  }

  return { success: true };
}

/**
 * Archive a class by marking it inactive (wrapper around toggleClassStatus)
 * @param {string} classId - UUID of the class to archive
 * @returns {Promise<boolean>}
 */
export async function archiveClass(classId) {
  return toggleClassStatus(classId, false);
}
