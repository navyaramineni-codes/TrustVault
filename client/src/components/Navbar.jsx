import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Navigation Bar Component.
 * Enforces role-based navigation display:
 * - Shows /admin ONLY when user.role === 'admin'.
 * - Shows /documents, /upload, /search for all authenticated users.
 * - Displays active session identity (rendered strictly as plain text, never dangerouslySetInnerHTML).
 * - Provides Logout button triggering session destruction.
 */
export default function Navbar() {
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const [showSignupModal, setShowSignupModal] = useState(false);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="navbar-header">
      <div className="navbar-container">
        {/* Brand Logo */}
        <Link to="/" className="navbar-brand">
          <div className="brand-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
            </svg>
          </div>
          <span className="brand-name">TrustVault</span>
        </Link>

        {/* Navigation Links based on role */}
        <nav className="navbar-nav">
          {isAuthenticated && (
            <>
              <NavLink
                to="/documents"
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                Documents
              </NavLink>

              <NavLink
                to="/upload"
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                Upload
              </NavLink>

              <NavLink
                to="/search"
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                Search
              </NavLink>

              {/* Show only when user role is admin */}
              {isAdmin && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) => `nav-link nav-link-admin ${isActive ? 'active' : ''}`}
                >
                  <span className="admin-indicator"></span>
                  Admin Console
                </NavLink>
              )}
            </>
          )}
        </nav>

        {/* User Identity or Auth Action Buttons */}
        <div className="navbar-actions">
          {isAuthenticated && user ? (
            <div className="user-profile-badge">
              <span className="user-email-text">{user.email}</span>
              <span className={`role-badge role-${user.role}`}>
                {user.role}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="btn btn-outline btn-logout"
                title="Log out of TrustVault"
                id="btn-logout"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                <span>Logout</span>
              </button>
            </div>
          ) : (
            <div className="navbar-auth-actions">
              <NavLink
                to="/login"
                className={({ isActive }) => `btn btn-sm ${isActive ? 'btn-outline-subtle' : 'btn-ghost'} nav-auth-signin`}
                id="nav-btn-signin"
              >
                Sign In
              </NavLink>
              <button
                type="button"
                onClick={() => setShowSignupModal(true)}
                className="btn btn-sm btn-primary nav-auth-signup"
                id="nav-btn-signup"
                title="Enterprise Account Registration"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                  <line x1="20" y1="8" x2="20" y2="14" />
                  <line x1="23" y1="11" x2="17" y2="11" />
                </svg>
                <span>Sign Up</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Enterprise Signup / Access Provisioning Modal (Portal to body to escape sticky header containing block) */}
      {showSignupModal && typeof document !== 'undefined' && createPortal(
        <div className="modal-backdrop" onClick={() => setShowSignupModal(false)}>
          <div
            className="modal-box modal-box-signup"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="signup-modal-title"
          >
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge signup-shield-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
                  </svg>
                </div>
                <div>
                  <h3 id="signup-modal-title" className="modal-title">
                    Enterprise Account Registration
                  </h3>
                  <p className="modal-subtitle">
                    Zero-Trust Access Control & Governance
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowSignupModal(false)}
                aria-label="Close modal"
              >
                &times;
              </button>
            </div>

            <div className="modal-body">
              <div className="signup-callout-card">
                <div className="signup-callout-header">
                  <span className="signup-shield-tag">🛡️ Administrator Provisioning Only</span>
                </div>
                <p className="signup-callout-text">
                  To protect vault integrity, prevent credential stuffing, and enforce organizational separation of duties,
                  <strong> self-service public user registration is disabled</strong>.
                </p>
                <p className="signup-callout-subtext">
                  All user accounts and access levels are provisioned directly by System Administrators via the Admin Console.
                </p>
              </div>

              <div className="demo-accounts-preview">
                <h4 className="preview-heading">Testing or Evaluating TrustVault?</h4>
                <p className="preview-subtext">
                  You can explore the vault immediately using the pre-seeded demo accounts on the login page:
                </p>
                <div className="demo-preview-list">
                  <div className="demo-preview-item">
                    <span className="demo-preview-badge badge-admin">Admin</span>
                    <code>admin@trustvault.local</code>
                    <span className="demo-preview-desc">User provisioning, role control, audit chain verification</span>
                  </div>
                  <div className="demo-preview-item">
                    <span className="demo-preview-badge badge-owner">Owner</span>
                    <code>owner@trustvault.local</code>
                    <span className="demo-preview-desc">Upload, metadata editing, file replacement, access sharing</span>
                  </div>
                  <div className="demo-preview-item">
                    <span className="demo-preview-badge badge-viewer">Viewer</span>
                    <code>viewer@trustvault.local</code>
                    <span className="demo-preview-desc">Access granted documents, verified immutable viewing</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-actions-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowSignupModal(false)}
              >
                Close
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowSignupModal(false);
                  navigate('/login');
                }}
              >
                Go to Demo Login
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </header>
  );
}
