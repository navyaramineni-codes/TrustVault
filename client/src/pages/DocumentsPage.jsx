import React, { useState, useEffect } from 'react';
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
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'document';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err) {
      if (err.status === 404) {
        alert('File could not be downloaded: not found or access denied.');
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
         ACCESSIBLE DOCUMENTS TABLE SECTION (Name, Category, Owner, Date)
         ========================================================================= */}
      <div className="documents-list-section">
        <div className="section-header-row">
          <h2 className="section-title">Accessible Documents</h2>
          <span className="results-count-text">
            Total Available: <strong>{documents.length}</strong>
          </span>
        </div>

        {fetchError && (
          <div className="alert alert-error">
            <span>{fetchError}</span>
          </div>
        )}

        {loading ? (
          <div className="loading-card">
            <div className="spinner"></div>
            <p className="loading-text">Loading authorized documents...</p>
          </div>
        ) : documents.length === 0 ? (
          <div className="empty-state-card">
            <div className="empty-icon">📂</div>
            <h3 className="empty-title">No Accessible Documents</h3>
            <p className="empty-text">
              You currently have no documents in your vault. Use the upload form above to add a document, or request permissions from a document owner.
            </p>
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
                            <div className="doc-title-text">{doc.name || doc.title}</div>
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
