import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiFetch, clearCsrfToken, getCsrfToken, ApiError } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Authentication state is stored purely in memory. Never in localStorage or sessionStorage!
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  /**
   * Check active session against the backend on app boot.
   * If cookie is valid, the server returns the session profile via /api/auth/me.
   */
  const checkSession = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch('/api/auth/me');
      setUser(data.user);
      setAuthError(null);
      // Pre-warm the CSRF token in memory for subsequent state-changing requests
      await getCsrfToken();
    } catch (err) {
      // 401 or 404 indicates no active session
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  /**
   * Authenticate with email & password.
   * The server regenerates session ID and issues the HttpOnly cookie.
   */
  const login = async (email, password) => {
    setAuthError(null);
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setUser(data.user);
      // Immediately pre-fetch fresh CSRF token bound to this session
      await getCsrfToken(true);
      return { success: true, user: data.user };
    } catch (err) {
      const message = err.data?.error || err.message || 'Login failed';
      setAuthError(message);
      throw new Error(message);
    }
  };

  /**
   * Terminate active session and clear in-memory state.
   */
  const logout = async () => {
    try {
      await apiFetch('/api/auth/logout', {
        method: 'POST',
      });
    } catch {
      // Ignore network errors on logout
    } finally {
      clearCsrfToken();
      setUser(null);
      setAuthError(null);
    }
  };

  const value = {
    user,
    loading,
    authError,
    isAuthenticated: !!user,
    isAdmin: user?.role === 'admin',
    login,
    logout,
    checkSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
