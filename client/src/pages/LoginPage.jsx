import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Login Page Component.
 * Features:
 * - Direct session authentication (HttpOnly cookie returned by server, zero localStorage).
 * - CSRF token automatically fetched and dispatched with POST /api/auth/login.
 * - Brute-force feedback (e.g., HTTP 429 Too Many Requests).
 * - Demo account helper buttons for rapid testing across roles.
 */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Redirect destination after successful login (default to /documents)
  const from = location.state?.from?.pathname || '/documents';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMessage('Please enter both email and password.');
      return;
    }

    setErrorMessage('');
    setIsSubmitting(true);

    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setErrorMessage(err.message || 'Authentication failed. Please verify credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFillDemo = (demoEmail, demoPassword) => {
    setEmail(demoEmail);
    setPassword(demoPassword);
    setErrorMessage('');
  };

  return (
    <div className="login-page-container">
      <div className="login-card-wrapper">
        <div className="login-card">
          {/* Header */}
          <div className="login-header">
            <div className="login-icon-badge">
              <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
              </svg>
            </div>
            <h1 className="login-title">TrustVault</h1>
            <p className="login-subtitle">Secure Document Storage & Access Control</p>
          </div>

          {/* Error Banner */}
          {errorMessage && (
            <div className="alert alert-error" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Authentication Form */}
          <form onSubmit={handleSubmit} className="login-form">
            <div className="form-group">
              <label htmlFor="login-email" className="form-label">
                Email Address
              </label>
              <div className="input-wrapper">
                <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                <input
                  id="login-email"
                  type="email"
                  className="form-input"
                  placeholder="name@trustvault.local"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="login-password" className="form-label">
                Password
              </label>
              <div className="input-wrapper">
                <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <input
                  id="login-password"
                  type="password"
                  className="form-input"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg"
              disabled={isSubmitting}
              id="btn-login-submit"
            >
              {isSubmitting ? (
                <>
                  <span className="spinner-sm"></span>
                  <span>Authenticating...</span>
                </>
              ) : (
                <span>Sign In to Vault</span>
              )}
            </button>
          </form>

          {/* Quick Demo Credentials */}
          <div className="demo-credentials-section">
            <div className="demo-divider">
              <span>Quick Login (Demo Accounts)</span>
            </div>
            <div className="demo-buttons-grid">
              <button
                type="button"
                className="demo-pill demo-admin"
                onClick={() => handleFillDemo('admin@trustvault.local', 'AdminVault2026!')}
                title="Fill Admin Credentials"
              >
                <span className="demo-role-badge">Admin</span>
                <span className="demo-email-hint">admin@trustvault.local</span>
              </button>

              <button
                type="button"
                className="demo-pill demo-owner"
                onClick={() => handleFillDemo('owner@trustvault.local', 'OwnerVault2026!')}
                title="Fill Document Owner Credentials"
              >
                <span className="demo-role-badge">Owner</span>
                <span className="demo-email-hint">owner@trustvault.local</span>
              </button>

              <button
                type="button"
                className="demo-pill demo-viewer"
                onClick={() => handleFillDemo('viewer@trustvault.local', 'ViewerVault2026!')}
                title="Fill Viewer Credentials"
              >
                <span className="demo-role-badge">Viewer</span>
                <span className="demo-email-hint">viewer@trustvault.local</span>
              </button>
            </div>
          </div>

          <div className="login-footer">
            <p className="security-notice">
              🔒 Authenticated via encrypted HttpOnly session cookie & Argon2id. Zero client storage.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
