import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api/client';
import NotFoundPage from './NotFoundPage';

/**
 * Search Page Component.
 * Queries /api/documents/search.
 * Enforces Rule 6: Results are permission-filtered at the database level.
 * Render strictly as plain text (never dangerouslySetInnerHTML).
 */
export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState([]);
  const [count, setCount] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [is404, setIs404] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    setErrorMessage('');
    setIs404(false);
    setIsSearching(true);
    setHasSearched(true);

    try {
      const params = new URLSearchParams();
      if (query) params.append('q', query);
      if (category) params.append('category', category);

      const data = await apiFetch(`/api/documents/search?${params.toString()}`);
      setResults(data.documents || data.results || []);
      setCount(data.count !== undefined ? data.count : data.documents?.length);
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setErrorMessage(err.message || 'Search failed');
      }
    } finally {
      setIsSearching(false);
    }
  };

  const handleDownload = async (docId, fileName) => {
    try {
      const blob = await apiFetch(`/api/documents/${docId}/download`);
      if (!blob || !(blob instanceof Blob)) {
        throw new Error('Received invalid or empty file data');
      }
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        a.remove();
      }, 500);
    } catch (err) {
      alert(err.status === 404 ? 'Document not found or unauthorized' : 'Download failed: ' + (err.message || 'Unknown error'));
    }
  };

  if (is404) {
    return <NotFoundPage />;
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Secure Vault Search</h1>
          <p className="page-subtitle">
            Zero-leakage search query: Permission filtering is enforced natively within MongoDB.
          </p>
        </div>
      </div>

      <div className="search-card">
        <form onSubmit={handleSearch} className="search-form">
          <div className="search-input-group">
            <input
              type="text"
              className="form-input search-input"
              placeholder="Search by title, filename, or keyword..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="form-input search-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All Categories</option>
              <option value="general">General</option>
              <option value="financial">Financial</option>
              <option value="legal">Legal</option>
              <option value="technical">Technical</option>
              <option value="confidential">Confidential</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={isSearching}>
              {isSearching ? 'Searching...' : 'Search Vault'}
            </button>
          </div>
        </form>
      </div>

      {errorMessage && (
        <div className="alert alert-error">
          <span>{errorMessage}</span>
        </div>
      )}

      {hasSearched && (
        <div className="search-results-section">
          <div className="results-meta-header">
            <span className="results-count-text">
              Found <strong>{count}</strong> accessible document{count === 1 ? '' : 's'}
            </span>
          </div>

          {results.length === 0 ? (
            <div className="empty-state-card">
              <p className="empty-text">No accessible documents matched your search parameters.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="vault-table">
                <thead>
                  <tr>
                    <th>Title & Name</th>
                    <th>Category</th>
                    <th>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((doc) => (
                    <tr key={doc._id}>
                      <td>
                        <div className="doc-title-cell">
                          <span className="doc-icon">📄</span>
                          <div>
                            <Link to={`/documents/${doc._id}`} className="doc-title-link">
                              {doc.title || doc.name}
                            </Link>
                            <div className="doc-meta-sub">{doc.originalFileName}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="badge badge-category">{doc.category || 'general'}</span>
                      </td>
                      <td className="text-muted">
                        {doc.size ? `${(doc.size / 1024).toFixed(1)} KB` : 'N/A'}
                      </td>
                      <td>
                        <div className="action-buttons-cell">
                          <Link
                            to={`/documents/${doc._id}`}
                            className="btn-icon btn-detail"
                            title="Inspect details, edit metadata or replace file"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </Link>

                          <button
                            type="button"
                            className="btn-icon btn-download"
                            onClick={() => handleDownload(doc._id, doc.originalFileName || doc.name)}
                            title="Download document"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
