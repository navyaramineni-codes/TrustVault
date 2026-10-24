import React from 'react';
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
          {isAuthenticated ? (
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
          ) : (
            <NavLink
              to="/login"
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              Sign In
            </NavLink>
          )}
        </nav>

        {/* User Identity & Logout Button */}
        <div className="navbar-actions">
          {isAuthenticated && user && (
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
          )}
        </div>
      </div>
    </header>
  );
}
