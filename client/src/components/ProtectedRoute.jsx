import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotFoundPage from '../pages/NotFoundPage';

/**
 * Protected Route Wrapper.
 * - Redirects to /login when session is missing.
 * - Displays loading indicator while verifying session cookie.
 * - Cloaks restricted routes (e.g. admin) with generic 404 screen when role is unauthorized.
 */
export default function ProtectedRoute({ children, allowedRoles }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p className="loading-text">Verifying secure session...</p>
      </div>
    );
  }

  // Missing session -> redirect to login preserving attempted destination
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Role restriction (e.g. non-admin accessing admin route) -> render generic 404 per Rule 3
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <NotFoundPage />;
  }

  return children;
}
