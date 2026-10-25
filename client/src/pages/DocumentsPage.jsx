import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import NotFoundPage from './NotFoundPage';

/**
 * Documents Page Component.
 * Features:
 * - Table of documents accessible to the authenticated user (Name, Category, Owner, Date).
 * - Inline Upload Form with Name, Category, Tags, and File Picker.
 * - Clear, prominent display of server validation errors:
 *   * Wrong type (non-whitelisted MIME / spoofed extension)
 *   * Too large (>5MB)
 *   * Empty file (0 bytes)
 *   * Path traversal attempts
 * - Strict Plain-Text Rendering (zero dangerouslySetInnerHTML per security rules).
 * - Downloads piped strictly through backend download route (/api/documents/:id/download).
 * - CSRF token automatically attached to all uploads and deletions.
 */
export default function DocumentsPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [is404, setIs404] = useState(false);
  const [actionSuccess, setActionSuccess] = useState('');

  // Search Bar & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterName, setFilterName] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [activeFiltersCount, setActiveFiltersCount] = useState(0);

  // Upload Form State
  const [uploadFile, setUploadFile] = useState(null);
  const [docName, setDocName] = useState('');
  const [category, setCategory] = useState('general');
  const [tagsInput, setTagsInput] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [serverValidationError, setServerValidationError] = useState(null);
  const [uploadSuccess, setUploadSuccess] = useState('');
  const [isUploadCardOpen, setIsUploadCardOpen] = useState(true);

  // Fetch all accessible documents
  const fetchDocuments = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      setIs404(false);
      const data = await apiFetch('/api/documents');
      setDocuments(data.documents || []);
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setFetchError(err.message || 'Failed to retrieve documents');
      }
    } finally {
      setLoading(false);
    }
  };

  // Call Search API with active search bar and filters
  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    setSearchError('');
    setIsSearching(true);

    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.append('q', searchQuery.trim());
      if (filterName.trim()) params.append('name', filterName.trim());
      if (filterOwner.trim()) params.append('owner', filterOwner.trim());
      if (filterCategory) params.append('category', filterCategory);
      if (filterStartDate) params.append('startDate', filterStartDate);
      if (filterEndDate) params.append('endDate', filterEndDate);

      const queryString = params.toString();
      const endpoint = queryString ? `/api/documents/search?${queryString}` : '/api/documents';
      const data = await apiFetch(endpoint);
      setDocuments(data.documents || data.results || []);
      setHasSearched(Boolean(queryString));

      // Calculate count of active filters
      let count = 0;
      if (searchQuery.trim()) count++;
      if (filterName.trim()) count++;
      if (filterOwner.trim()) count++;
      if (filterCategory) count++;
      if (filterStartDate || filterEndDate) count++;
      setActiveFiltersCount(count);
    } catch (err) {
      if (err.status === 404) {
        setDocuments([]);
        setHasSearched(true);
      } else {
        setSearchError(err.message || 'Failed to search documents');
      }
    } finally {
      setIsSearching(false);
    }
  };

  // Clear all filters and restore full list
  const handleClearFilters = async () => {
    setSearchQuery('');
    setFilterName('');
    setFilterOwner('');
    setFilterCategory('');
    setFilterStartDate('');
    setFilterEndDate('');
    setHasSearched(false);
    setActiveFiltersCount(0);
    setSearchError('');
    await fetchDocuments();
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  // Handle file selection
  const handleFileChange = (e) => {
    setServerValidationError(null);
    setUploadSuccess('');
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setUploadFile(selected);
      if (!docName.trim()) {
        // Pre-fill name from filename without extension
        setDocName(selected.name.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  // Helper to categorize server errors
  const parseServerValidationError = (errorMsg, status) => {
    const lower = String(errorMsg || '').toLowerCase();
    let categoryTitle = 'Server Validation Error';
    let hint = '';

    if (lower.includes('type not allowed') || lower.includes('unrecognized') || lower.includes('spoofed')) {
      categoryTitle = 'Validation Failed: Wrong File Type';
      hint = 'Only secure documents (PDF, JPEG, PNG, WEBP) with valid matching magic bytes are accepted.';
    } else if (lower.includes('size') || lower.includes('large') || lower.includes('limit') || status === 413) {
      categoryTitle = 'Validation Failed: File Too Large';
      hint = 'Uploaded files must not exceed the strict 5 MB storage ceiling.';
    } else if (lower.includes('empty') || lower.includes('0 bytes')) {
      categoryTitle = 'Validation Failed: Empty File';
      hint = 'Zero-byte files cannot be vaulted. Please select a valid document.';
    } else if (lower.includes('path traversal') || lower.includes('filename')) {
      categoryTitle = 'Security Violation: Path Traversal Detected';
      hint = 'Directory navigation sequences (../) in filenames are strictly rejected.';
    }

    return {
      title: categoryTitle,
      message: errorMsg,
      hint,
    };
  };

  // Submit Upload Form
  const handleUploadSubmit = async (e) => {
    e.preventDefault();
    setServerValidationError(null);
    setUploadSuccess('');

    if (!uploadFile) {
      setServerValidationError({
        title: 'Validation Error',
        message: 'No file selected. Please choose a file to upload.',
        hint: 'Click the file picker or drag and drop a document.',
      });
      return;
    }

    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('name', docName.trim() || uploadFile.name);
      formData.append('title', docName.trim() || uploadFile.name);
      formData.append('category', category);
      
      // Parse comma-separated tags into array
      const tagsArray = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      tagsArray.forEach((tag) => formData.append('tags', tag));

      const res = await apiFetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      });

      setUploadSuccess(`"${res.document?.name || docName}" successfully vaulted and verified.`);
      
      // Reset form
      setUploadFile(null);
      setDocName('');
      setCategory('general');
      setTagsInput('');
      const fileInput = document.getElementById('upload-file-input');
      if (fileInput) fileInput.value = '';

      // Refresh table immediately
      fetchDocuments();
    } catch (err) {
      const parsedError = parseServerValidationError(
        err.data?.error || err.message || 'Upload rejected by server',
        err.status
      );
      setServerValidationError(parsedError);
    } finally {
      setIsUploading(false);
    }
  };

  // Handle Download via backend route only
  const handleDownload = async (docId, fileName) => {
    try {
      const blob = await apiFetch(`/api/documents/${docId}/download`);
      if (!blob || !(blob instanceof Blob)) {
        throw new Error('Received invalid or empty file data');
      }
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'document';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        a.remove();
      }, 500);
    } catch (err) {
      if (err.status === 404) {
        alert(err.data?.error === 'File not found on storage'
          ? 'File not found on storage. (If uploaded in an earlier container before persistent storage was enabled, please re-upload this document).'
          : 'File could not be downloaded: not found or access denied.');
      } else {
        alert('Download error: ' + (err.message || 'Failed to download'));
      }
    }
  };

  // Handle Soft-Delete
  const handleDelete = async (docId, docName) => {
    if (!window.confirm(`Are you sure you want to delete "${docName}"?`)) {
      return;
    }

    try {
      await apiFetch(`/api/documents/${docId}`, {
        method: 'DELETE',
      });
      setActionSuccess(`Document "${docName}" soft-deleted successfully.`);
      fetchDocuments();
    } catch (err) {
      alert(err.status === 404 ? 'Document not found or unauthorized.' : err.message);
    }
  };

  if (is404) {
    return <NotFoundPage />;
  }

  return (
    <div className="page-container">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Vault Documents</h1>
          <p className="page-subtitle">
            Secure, permission-isolated document repository for{' '}
            <strong className="text-highlight">{user?.email}</strong> ({user?.role})
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsUploadCardOpen((prev) => !prev)}
            id="btn-toggle-upload"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>{isUploadCardOpen ? 'Hide Upload Form' : 'Upload New Document'}</span>
          </button>
        </div>
      </div>

      {/* Global Action Banner */}
      {actionSuccess && (
        <div className="alert alert-success">
          <span>{actionSuccess}</span>
          <button
            type="button"
            className="btn-icon"
            onClick={() => setActionSuccess('')}
            style={{ marginLeft: 'auto', border: 'none' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================================
         UPLOAD FORM SECTION (with Name, Category, Tags & Server Error Reporting)
         ========================================================================= */}
      {isUploadCardOpen && (
        <div className="upload-section-card" id="upload-section">
          <div className="card-header-row">
            <div>
              <h2 className="section-title">Upload Confidential Document</h2>
              <p className="card-subtitle-text">
                Files are stored under UUIDs outside web root. All uploads require CSRF token validation and magic-byte verification.
              </p>
            </div>
            <span className="badge badge-category">Max Size: 5MB</span>
          </div>

          {/* Prominent Server Validation Error Alert */}
          {serverValidationError && (
            <div className="alert alert-error server-error-box" role="alert" id="server-validation-alert">
              <div className="error-icon-col">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="24" height="24">
                  <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="error-content-col">
                <strong className="error-title-text">{serverValidationError.title}</strong>
                <div className="error-server-msg">Server response: "{serverValidationError.message}"</div>
                {serverValidationError.hint && (
                  <div className="error-hint-text">💡 {serverValidationError.hint}</div>
                )}
              </div>
            </div>
          )}

          {/* Upload Success Alert */}
          {uploadSuccess && (
            <div className="alert alert-success" role="status">
              <span>✅ {uploadSuccess}</span>
            </div>
          )}

          <form onSubmit={handleUploadSubmit} className="inline-upload-form">
            <div className="upload-form-grid">
              {/* File Drop / Select Zone */}
              <div className="form-group grid-full">
                <label className="form-label" htmlFor="upload-file-input">
                  Select Document File <span className="text-danger">*</span>
                </label>
                <div className={`file-drop-zone ${uploadFile ? 'has-file' : ''}`}>
                  <input
                    id="upload-file-input"
                    type="file"
                    className="file-input"
                    onChange={handleFileChange}
                  />
                  <div className="file-drop-content">
                    <div className="file-upload-icon">{uploadFile ? '📄' : '📁'}</div>
                    <span className="file-upload-prompt">
                      {uploadFile ? uploadFile.name : 'Choose a file (PDF, PNG, JPEG, WEBP) or drag & drop here'}
                    </span>
                    {uploadFile && (
                      <span className="file-size-hint">
                        Size: {(uploadFile.size / 1024).toFixed(1)} KB (Type: {uploadFile.type || 'detected by server'})
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Name Field */}
              <div className="form-group">
                <label className="form-label" htmlFor="doc-name-input">
                  Document Name <span className="text-danger">*</span>
                </label>
                <input
                  id="doc-name-input"
                  type="text"
                  className="form-input"
                  placeholder="e.g. Q3 Verified Financial Audit"
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                  required
                />
              </div>

              {/* Category Field */}
              <div className="form-group">
                <label className="form-label" htmlFor="doc-category-select">
                  Category
                </label>
                <select
                  id="doc-category-select"
                  className="form-input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="general">General</option>
                  <option value="financial">Financial</option>
                  <option value="legal">Legal</option>
                  <option value="technical">Technical</option>
                  <option value="confidential">Confidential</option>
                </select>
              </div>

              {/* Tags Field */}
              <div className="form-group grid-full">
                <label className="form-label" htmlFor="doc-tags-input">
                  Tags <span className="text-muted">(comma-separated)</span>
                </label>
                <input
                  id="doc-tags-input"
                  type="text"
                  className="form-input"
                  placeholder="e.g. audit, 2026, confidential, executive"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                />
              </div>
            </div>

            <div className="upload-submit-row">
              <button
                type="submit"
                className="btn btn-primary btn-lg"
                disabled={isUploading}
                id="btn-submit-upload"
              >
                {isUploading ? (
                  <>
                    <span className="spinner-sm"></span>
                    <span>Encrypting & Vaulting File...</span>
                  </>
                ) : (
                  <span>Upload & Verify Document</span>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* =========================================================================
         SEARCH BAR & FILTERS SECTION (Search Bar, Name, Owner, Category, Date Range)
         ========================================================================= */}
      <div className="search-filter-card" id="search-filter-section">
        <div className="search-filter-header">
          <div className="search-filter-title-col">
            <div className="search-filter-badge">🔍</div>
            <div>
              <h2 className="section-title">Search & Filter Documents</h2>
              <p className="card-subtitle-text">
                Native permission-isolated search. Filter across name, owner, category, and creation date range.
              </p>
            </div>
          </div>
          {activeFiltersCount > 0 && (
            <div className="active-filters-indicator">
              <span className="badge badge-primary">
                {activeFiltersCount} Active {activeFiltersCount === 1 ? 'Filter' : 'Filters'}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleClearFilters}
                id="btn-clear-filters-header"
              >
                Clear All
              </button>
            </div>
          )}
        </div>

        {searchError && (
          <div className="alert alert-error" role="alert" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
            <span>⚠️ {searchError}</span>
          </div>
        )}

        <form onSubmit={handleSearch} className="search-filter-form" id="form-documents-search">
          {/* Main Hero Search Bar */}
          <div className="main-search-bar-row">
            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>
              <input
                id="search-query-input"
                type="text"
                className="form-input search-hero-input"
                placeholder="Search keywords, filenames, description, or tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-inline-btn"
                  onClick={() => setSearchQuery('')}
                  title="Clear search text"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-search-submit"
              disabled={isSearching}
              id="btn-submit-search"
            >
              {isSearching ? (
                <>
                  <span className="spinner-sm"></span>
                  <span>Searching...</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span>Search Vault</span>
                </>
              )}
            </button>
          </div>

          {/* Detailed Filters Grid: Name, Owner, Category, Date Range */}
          <div className="filters-grid-row">
            {/* Filter by Name */}
            <div className="form-group filter-col">
              <label className="form-label" htmlFor="filter-name-input">
                Document Name
              </label>
              <input
                id="filter-name-input"
                type="text"
                className="form-input"
                placeholder="Filter by document name..."
                value={filterName}
                onChange={(e) => setFilterName(e.target.value)}
              />
            </div>

            {/* Filter by Owner */}
            <div className="form-group filter-col">
              <label className="form-label" htmlFor="filter-owner-input">
                Owner (Name / Email)
              </label>
              <input
                id="filter-owner-input"
                type="text"
                className="form-input"
                placeholder="e.g. owner or viewer..."
                value={filterOwner}
                onChange={(e) => setFilterOwner(e.target.value)}
              />
            </div>

            {/* Filter by Category */}
            <div className="form-group filter-col">
              <label className="form-label" htmlFor="filter-category-select">
                Category
              </label>
              <select
                id="filter-category-select"
                className="form-input"
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
              >
                <option value="">All Categories</option>
                <option value="general">General</option>
                <option value="financial">Financial</option>
                <option value="legal">Legal</option>
                <option value="technical">Technical</option>
                <option value="confidential">Confidential</option>
              </select>
            </div>

            {/* Filter by Date Range */}
            <div className="form-group filter-col date-range-col">
              <label className="form-label">Date Range</label>
              <div className="date-range-inputs">
                <input
                  id="filter-start-date"
                  type="date"
                  className="form-input date-input"
                  value={filterStartDate}
                  onChange={(e) => setFilterStartDate(e.target.value)}
                  title="From date"
                />
                <span className="date-separator">to</span>
                <input
                  id="filter-end-date"
                  type="date"
                  className="form-input date-input"
                  value={filterEndDate}
                  onChange={(e) => setFilterEndDate(e.target.value)}
                  title="To date"
                />
              </div>
            </div>
          </div>

          {/* Form Actions Footer */}
          <div className="search-filter-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSearching}
              id="btn-apply-filters"
            >
              Apply Filters
            </button>
            {activeFiltersCount > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleClearFilters}
                id="btn-reset-filters"
              >
                Reset Filters
              </button>
            )}
          </div>
        </form>
      </div>

      {/* =========================================================================
         ACCESSIBLE DOCUMENTS TABLE SECTION (Name, Category, Owner, Date)
         ========================================================================= */}
      <div className="documents-list-section">
        <div className="section-header-row">
          <h2 className="section-title">
            {hasSearched ? 'Search & Filter Results' : 'Accessible Documents'}
          </h2>
          <span className="results-count-text">
            {hasSearched ? (
              <>
                Matched: <strong>{documents.length}</strong> {documents.length === 1 ? 'document' : 'documents'}
              </>
            ) : (
              <>
                Total Available: <strong>{documents.length}</strong>
              </>
            )}
          </span>
        </div>

        {fetchError && (
          <div className="alert alert-error">
            <span>{fetchError}</span>
          </div>
        )}

        {loading || isSearching ? (
          <div className="loading-card">
            <div className="spinner"></div>
            <p className="loading-text">
              {isSearching ? 'Executing zero-leakage search query...' : 'Loading authorized documents...'}
            </p>
          </div>
        ) : documents.length === 0 ? (
          <div className="empty-state-card" id="empty-documents-card">
            <div className="empty-icon">{hasSearched ? '🔍' : '📂'}</div>
            <h3 className="empty-title">
              {hasSearched ? 'No Matching Documents Found' : 'No Accessible Documents'}
            </h3>
            <p className="empty-text">
              {hasSearched
                ? 'No documents matched your search parameters and filter criteria. Try adjusting or clearing your filters.'
                : 'You currently have no documents in your vault. Use the upload form above to add a document, or request permissions from a document owner.'}
            </p>
            {hasSearched && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleClearFilters}
                style={{ marginTop: '1rem' }}
                id="btn-clear-search-empty"
              >
                Clear Search & Show All Documents
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="vault-table" id="table-documents">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Category</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Date</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  const ownerId = doc.owner?._id || doc.owner || doc.ownerId;
                  const currentUserId = user?._id;
                  const isOwner = String(ownerId) === String(currentUserId);
                  const ownerEmail = doc.owner?.email || (isOwner ? user?.email : 'Other User');

                  return (
                    <tr key={doc._id} className="doc-table-row">
                      {/* 1. Name & Tags (Rendered strictly as text, never dangerouslySetInnerHTML) */}
                      <td>
                        <div className="doc-title-cell">
                          <span className="doc-icon">📄</span>
                          <div>
                            <Link to={`/documents/${doc._id}`} className="doc-title-link">
                              {doc.name || doc.title}
                            </Link>
                            <div className="doc-meta-sub">{doc.originalFileName}</div>
                            {/* Tags list */}
                            {Array.isArray(doc.tags) && doc.tags.length > 0 && (
                              <div className="doc-tags-row">
                                {doc.tags.map((tag, idx) => (
                                  <span key={idx} className="tag-pill">
                                    #{tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* 2. Category */}
                      <td>
                        <span className="badge badge-category">{doc.category || 'general'}</span>
                      </td>

                      {/* 3. Owner */}
                      <td>
                        <div className="owner-cell">
                          <span className={`owner-indicator ${isOwner ? 'is-self' : ''}`}>
                            {isOwner ? '⭐ You' : ownerEmail}
                          </span>
                        </div>
                      </td>

                      {/* 4. Date */}
                      <td className="text-muted">
                        <time dateTime={doc.createdAt}>
                          {new Date(doc.createdAt).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </time>
                      </td>

                      {/* Actions */}
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
                            title="Download via backend route"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                          </button>

                          {isOwner && (
                            <button
                              type="button"
                              className="btn-icon btn-delete"
                              onClick={() => handleDelete(doc._id, doc.name || doc.title)}
                              title="Soft delete document"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
