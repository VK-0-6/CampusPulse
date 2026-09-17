/**
 * Student Feedback & Community Improvement System
 * Utility Functions (js/utils.js)
 * Input validation, user-friendly error formatting, and UI helpers
 */

import { isSupabaseConfigured } from './supabase.js';

/**
 * Validates email format using standard RFC 5322 compatible regex
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

/**
 * Validates password strength (minimum 6 characters for Supabase Auth)
 */
export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

/**
 * Maps raw Supabase error messages/codes to friendly, non-technical messages
 */
export function getFriendlyErrorMessage(error) {
  if (!error) return 'An unexpected error occurred. Please try again.';

  const msg = error.message ? error.message.toLowerCase() : (typeof error === 'string' ? error.toLowerCase() : '');

  // Roll number duplicate check
  if (
    msg.includes('roll number') || 
    msg.includes('uq_idx_profiles_roll_number') ||
    msg.includes('database error saving new user')
  ) {
    return 'This roll number is already registered. Please use a different roll number.';
  }

  if (msg.includes('invalid login credentials') || msg.includes('invalid_grant')) {
    return 'Invalid email or password. Please verify your credentials and try again.';
  }
  if (msg.includes('user already registered') || msg.includes('unique constraint')) {
    return 'An account with this email already exists. Please sign in instead.';
  }
  if (msg.includes('email not confirmed')) {
    return 'Please confirm your email address before signing in, or check your Supabase Auth configuration.';
  }
  if (msg.includes('password should be at least')) {
    return 'Your password must be at least 6 characters long.';
  }
  if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network request failed')) {
    return 'Unable to reach the authentication service. Please verify your internet connection or Supabase URL configuration.';
  }
  if (msg.includes('rate limit')) {
    return 'Too many attempts. Please wait a few moments before trying again.';
  }
  if (!isSupabaseConfigured || msg.includes('not configured')) {
    return 'Supabase credentials are not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env file.';
  }

  // Fallback generic error
  return 'Authentication request could not be completed. Please try again.';
}

/**
 * Displays a clean status alert banner inside a container element
 */
export function showAlert(containerElement, message, type = 'danger') {
  if (!containerElement) return;

  const iconMap = {
    danger: '⚠️',
    success: '✅',
    warning: '⚡',
    info: 'ℹ️'
  };

  containerElement.className = `alert alert-${type}`;
  containerElement.innerHTML = `
    <span class="alert-icon">${iconMap[type] || 'ℹ️'}</span>
    <div class="alert-content">${escapeHtml(message)}</div>
  `;
  containerElement.classList.remove('hidden');
}

/**
 * Clears and hides an alert element
 */
export function clearAlert(containerElement) {
  if (!containerElement) return;
  containerElement.className = 'alert hidden';
  containerElement.innerHTML = '';
}

/**
 * Toggles a button loading state with spinner
 */
export function setButtonLoading(button, isLoading, loadingText = 'Processing...', defaultText = 'Submit') {
  if (!button) return;
  if (isLoading) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${loadingText}`;
  } else {
    button.disabled = false;
    button.innerHTML = defaultText;
  }
}

/**
 * Basic HTML escaping helper to prevent XSS in alerts
 */
export function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Checks if Supabase is unconfigured and displays an alert banner if container exists
 */
export function checkAndRenderConfigBanner() {
  const banner = document.getElementById('supabaseConfigBanner');
  if (banner && !isSupabaseConfigured) {
    banner.classList.add('active');
  }
}
