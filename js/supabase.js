/**
 * Student Feedback & Community Improvement System
 * Supabase Client Initialization (js/supabase.js)
 * 
 * Uses Vite environment variables:
 * - import.meta.env.VITE_SUPABASE_URL
 * - import.meta.env.VITE_SUPABASE_ANON_KEY
 */

import { createClient } from '@supabase/supabase-js';

const env = (typeof import.meta !== 'undefined' && import.meta.env) 
  ? import.meta.env 
  : (typeof process !== 'undefined' && process.env ? process.env : {});

const supabaseUrl = env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || '';

// Check if credentials are properly configured
export const isSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey && 
  !supabaseUrl.includes('your-project-ref') &&
  supabaseUrl.startsWith('https://')
);

export const SUPABASE_CONFIG_MESSAGE = `
Supabase is not yet configured. Please create a .env file with valid:
- VITE_SUPABASE_URL
- VITE_SUPABASE_ANON_KEY
Obtain these from your Supabase Dashboard under Project Settings > API.
`;

if (!isSupabaseConfigured) {
  console.warn('[SFCIS Configuration Warning]: ' + SUPABASE_CONFIG_MESSAGE.trim());
}

// Initialize Supabase client. Fallback to dummy strings if unconfigured so app doesn't crash on boot.
export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : 'https://placeholder-project.supabase.co',
  isSupabaseConfigured ? supabaseAnonKey : 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);
