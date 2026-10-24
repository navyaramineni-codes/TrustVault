import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Universal Generic Not Found Screen.
 * Fulfills Frontend Rule: "A 404 from the API always shows the same generic 'Not found' screen."
 * Cloaks existence of confidential files and administrative surfaces.
 */
export default function NotFoundPage({ message }) {
  return (
    <div className="not-found-container">
      <div className="not-found-card">
        <div className="not-found-badge">404</div>
        <h1 className="not-found-title">Resource Not Found</h1>
        <p className="not-found-text">
          {message || 'The requested page or document could not be found, or you do not have permission to access it.'}
        </p>
        <div className="not-found-actions">
          <Link to="/" className="btn btn-primary">
            Return to Vault
          </Link>
        </div>
      </div>
    </div>
  );
}
