/**
 * Student Feedback & Community Improvement System
 * Authentication & Route Protection Module (js/auth.js)
 * Reusable auth functions, role resolution, and route guards
 */

import { supabase, isSupabaseConfigured } from './supabase.js';

/**
 * Returns the relative dashboard URL for a given user role
 */
export function getRoleDashboardUrl(role) {
  switch (role ? role.toLowerCase() : '') {
    case 'student':
      return '/student/';
    case 'faculty':
      return '/faculty/';
    case 'hod':
      return '/hod/';
    default:
      return '/login.html';
  }
}

/**
 * Retrieves the current Supabase session
 */
export async function getCurrentSession() {
  if (!isSupabaseConfigured) return null;
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.warn('[Auth] Error getting session:', error.message);
      return null;
    }
    return session;
  } catch (err) {
    console.error('[Auth] Failed to retrieve session:', err);
    return null;
  }
}

/**
 * Retrieves the currently authenticated user
 */
export async function getCurrentUser() {
  if (!isSupabaseConfigured) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return null;
    return user;
  } catch (err) {
    console.error('[Auth] Failed to retrieve user:', err);
    return null;
  }
}

/**
 * Fetches user profile from public.profiles with fallback to auth metadata
 */
export async function getUserProfile(user) {
  if (!user) return null;

  let profile = {
    id: user.id,
    email: user.email,
    fullName: user.user_metadata?.full_name || 'Academic User',
    role: user.user_metadata?.role || 'student',
    rollNumber: user.user_metadata?.roll_number || null,
    departmentId: user.user_metadata?.department_id || null,
    departmentName: user.user_metadata?.department_name || null
  };

  if (!isSupabaseConfigured) return profile;

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('full_name, role, email, roll_number, department_id, departments:department_id(name)')
      .eq('id', user.id)
      .maybeSingle();

    if (!error && data) {
      profile.fullName = data.full_name || profile.fullName;
      profile.role = data.role || profile.role;
      profile.email = data.email || profile.email;
      profile.rollNumber = data.roll_number || profile.rollNumber;
      profile.departmentId = data.department_id || profile.departmentId;
      profile.departmentName = data.departments?.name || profile.departmentName;
    }
  } catch (err) {
    console.warn('[Auth] Profile table read failed, using auth metadata fallback:', err);
  }

  return profile;
}

/**
 * Register a new user with Supabase Auth and initialize their profile
 */
export async function signUpUser({ fullName, email, password, role, rollNumber, departmentId }) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Please supply VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.');
  }

  if (!departmentId) {
    throw new Error('Department is required for registration.');
  }

  const normalizedRole = role ? role.toLowerCase() : 'student';
  let normalizedRoll = null;

  if (normalizedRole === 'student') {
    normalizedRoll = (rollNumber || '').trim().toUpperCase();
    if (!normalizedRoll) {
      throw new Error('Roll number is required for student registration.');
    }

    if (!/^[A-Z0-9]{5,20}$/.test(normalizedRoll)) {
      throw new Error('Please enter a valid roll number (5 to 20 alphanumeric characters, e.g. 24331A0767).');
    }

    // Pre-flight check 1: RPC check_roll_number_exists (allowed for unauthenticated/anon clients)
    try {
      const { data: isTaken, error: rpcErr } = await supabase
        .rpc('check_roll_number_exists', { p_roll_number: normalizedRoll });

      if (!rpcErr && isTaken === true) {
        throw new Error('This roll number is already registered. Please use a different roll number.');
      }
    } catch (rpcEx) {
      if (rpcEx.message?.includes('already registered')) {
        throw rpcEx;
      }
      // If RPC is not yet created or throws network error, proceed to fallback checks
    }

    // Pre-flight check 2: Direct select from profiles (if permitted by session or RLS)
    try {
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .ilike('roll_number', normalizedRoll)
        .maybeSingle();

      if (existingProfile) {
        throw new Error('This roll number is already registered. Please use a different roll number.');
      }
    } catch (tableEx) {
      if (tableEx.message?.includes('already registered')) {
        throw tableEx;
      }
    }
  }

  // Pre-flight check for HOD: enforce maximum 1 HOD per department
  if (normalizedRole === 'hod') {
    try {
      const { data: existingHod } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'hod')
        .eq('department_id', departmentId)
        .maybeSingle();

      if (existingHod) {
        throw new Error('This department already has an assigned HOD. Each department may only have one HOD.');
      }
    } catch (hodEx) {
      if (hodEx.message?.includes('already has an assigned HOD')) {
        throw hodEx;
      }
    }
  }

  // 1. Create auth user with metadata
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        role: normalizedRole,
        roll_number: normalizedRoll,
        department_id: departmentId
      }
    }
  });

  if (authError) {
    const errorMsg = (authError.message || '').toLowerCase();
    // Gotrue returns "Database error saving new user" when handle_new_user() trigger
    // aborts the transaction due to unique constraint violations
    if (
      normalizedRole === 'student' && 
      (errorMsg.includes('database error saving new user') || 
       errorMsg.includes('database error') ||
       errorMsg.includes('unique constraint') ||
       errorMsg.includes('uq_idx_profiles_roll_number') ||
       errorMsg.includes('duplicate key'))
    ) {
      throw new Error('This roll number is already registered. Please use a different roll number.');
    }

    if (
      normalizedRole === 'hod' &&
      (errorMsg.includes('uq_one_hod_per_department') ||
       errorMsg.includes('already has an assigned hod') ||
       (errorMsg.includes('unique constraint') && errorMsg.includes('hod')) ||
       errorMsg.includes('database error saving new user'))
    ) {
      throw new Error('This department already has an assigned HOD. Each department may only have one HOD.');
    }

    throw authError;
  }

  const user = authData.user;
  const session = authData.session;

  // 2. Fallback upsert into profiles if session is active (or if DB trigger is delayed)
  if (user && session) {
    try {
      await supabase.from('profiles').upsert({
        id: user.id,
        full_name: fullName,
        email: email,
        role: normalizedRole,
        roll_number: normalizedRoll,
        department_id: departmentId,
        updated_at: new Date().toISOString()
      });
    } catch (profileErr) {
      console.warn('[Auth] Direct profile upsert notice (trigger may handle this):', profileErr);
    }
  }

  return {
    user,
    session,
    role: normalizedRole,
    rollNumber: normalizedRoll,
    departmentId,
    needsEmailConfirmation: !session && user && user.identities?.length > 0
  };
}

/**
 * Sign in existing user with email and password
 */
export async function signInUser(email, password) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Please supply VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    throw error;
  }

  const user = data.user;
  const profile = await getUserProfile(user);

  return {
    user,
    session: data.session,
    profile,
    role: profile.role
  };
}

/**
 * Logs out the current user and redirects to login page
 */
export async function signOutUser() {
  if (isSupabaseConfigured) {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('[Auth] Error during signOut:', err);
    }
  }
  window.location.href = '/login.html';
}

/**
 * Route Guard for protected dashboard pages
 * Checks for authentication and verifies the user has the required role.
 * 
 * @param {string} allowedRole - 'student' | 'faculty' | 'hod'
 * @returns {Promise<{user: Object, profile: Object}>}
 */
export async function requireAuth(allowedRole) {
  const overlay = document.getElementById('authLoadingOverlay');

  try {
    const session = await getCurrentSession();

    if (!session || !session.user) {
      console.info('[Auth Guard] No active session found. Redirecting to login.');
      window.location.replace('/login.html');
      return null;
    }

    const profile = await getUserProfile(session.user);
    const userRole = (profile.role || 'student').toLowerCase();
    const targetRole = allowedRole.toLowerCase();

    // Check role authorization
    if (userRole !== targetRole) {
      console.warn(`[Auth Guard] Role mismatch. User has role "${userRole}" but page requires "${targetRole}". Redirecting.`);
      window.location.replace(getRoleDashboardUrl(userRole));
      return null;
    }

    // Authorization successful, dismiss overlay
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 250);
    }

    return { user: session.user, profile };
  } catch (err) {
    console.error('[Auth Guard] Error verifying route access:', err);
    window.location.replace('/login.html');
    return null;
  }
}

/**
 * Guest Guard for login and register pages
 * If a user is already logged in, redirects them straight to their dashboard.
 */
export async function redirectIfAuthenticated() {
  try {
    const session = await getCurrentSession();
    if (session && session.user) {
      const profile = await getUserProfile(session.user);
      const dashboardUrl = getRoleDashboardUrl(profile.role);
      console.info(`[Auth] User already authenticated as ${profile.role}. Redirecting to ${dashboardUrl}`);
      window.location.replace(dashboardUrl);
    }
  } catch (err) {
    console.warn('[Auth] Guest guard check encountered error:', err);
  }
}

/**
 * Subscribes to Supabase Auth state changes
 */
export function onAuthStateChange(callback) {
  if (!isSupabaseConfigured) return { data: { subscription: { unsubscribe: () => {} } } };
  return supabase.auth.onAuthStateChange(callback);
}
