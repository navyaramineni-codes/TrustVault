import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { apiFetch, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import NotFoundPage from './NotFoundPage';

/**
 * Format bytes into human-readable string (e.g. 1.2 MB, 450 KB).
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Categorize server validation error strings into actionable UI banners.
 */
function parseServerValidationError(errorMsg, status) {
  const lower = String(errorMsg || '').toLowerCase();
  let title = 'File Replacement Error';
  let hint = '';

  if (lower.includes('type not allowed') || lower.includes('unrecognized') || lower.includes('spoofed')) {
    title = 'Validation Failed: Wrong File Type';
    hint = 'Allowed file formats: PDF, JPEG, PNG, WEBP. Binary signature must match extension.';
  } else if (lower.includes('size') || lower.includes('large') || lower.includes('limit') || status === 413) {
    title = 'Validation Failed: File Too Large';
    hint = 'Replacement files must not exceed the strict 5 MB storage ceiling.';
  } else if (lower.includes('empty') || lower.includes('0 bytes')) {
    title = 'Validation Failed: Empty File';
    hint = 'Zero-byte files cannot replace vaulted documents.';
  } else if (lower.includes('path traversal') || lower.includes('filename')) {
    title = 'Security Violation: Path Traversal Detected';
    hint = 'Directory navigation sequences (../) in filenames are strictly forbidden.';
  }

  return { title, message: errorMsg, hint };
}

export default function DocumentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Document & Permission State
  const [doc, setDoc] = useState(null);
  const [permissions, setPermissions] = useState({
    isOwner: false,
    canEdit: false,
    canDelete: false,
    level: 'read',
  });
  const [loading, setLoading] = useState(true);
  const [is404, setIs404] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // Metadata Edit Form State
  const [name, setName] = useState('');
  const [category, setCategory] = useState('general');
  const [tagsInput, setTagsInput] = useState('');
  const [description, setDescription] = useState('');
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [metadataSuccess, setMetadataSuccess] = useState('');
  const [metadataError, setMetadataError] = useState('');

  // File Replacement State
  const [replaceFile, setReplaceFile] = useState(null);
  const [isReplacingFile, setIsReplacingFile] = useState(false);
  const [replaceSuccess, setReplaceSuccess] = useState('');
  const [replaceValidationError, setReplaceValidationError] = useState(null);

  // Delete State & Confirmation Modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Active Tab for Edit Panel ('metadata' | 'replace')
  const [activeTab, setActiveTab] = useState('metadata');

  // Sharing & Access Control State (Owner Only)
  const [permissionsList, setPermissionsList] = useState([]);
  const [grantName, setGrantName] = useState('');
  const [grantLevel, setGrantLevel] = useState('read');
  const [isGranting, setIsGranting] = useState(false);
  const [grantSuccess, setGrantSuccess] = useState('');
  const [grantError, setGrantError] = useState('');
  const [revokingUserId, setRevokingUserId] = useState(null);
  const [revokeSuccess, setRevokeSuccess] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [userToRevoke, setUserToRevoke] = useState(null);

  // Fetch active permissions list for this document (Owner only)
  const fetchPermissionsList = async () => {
    try {
      const res = await apiFetch(`/api/documents/${id}/permissions`);
      setPermissionsList(res.permissions || []);
    } catch (err) {
      // Non-owners receive 404 per Rule 3
      if (err.status !== 404) {
        console.error('Failed to load permissions list:', err);
      }
    }
  };

  // Load document details and permissions
  const fetchDocumentDetail = async () => {
    try {
      setLoading(true);
      setFetchError('');
      setIs404(false);

      const res = await apiFetch(`/api/documents/${id}`);
      const documentData = res.document;
      const permData = res.permissions || {
        isOwner: false,
        canEdit: false,
        canDelete: false,
        level: 'read',
      };

      setDoc(documentData);
      setPermissions(permData);

      // Populate metadata form fields
      setName(documentData.name || documentData.title || '');
      setCategory(documentData.category || 'general');
      setTagsInput(Array.isArray(documentData.tags) ? documentData.tags.join(', ') : '');
      setDescription(documentData.description || '');

      // If user is owner, populate permissions list
      if (permData.isOwner) {
        if (Array.isArray(res.permissionsList)) {
          setPermissionsList(res.permissionsList);
        } else {
          fetchPermissionsList();
        }
      }
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setFetchError(err.message || 'Failed to retrieve document details');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) {
      fetchDocumentDetail();
    }
  }, [id]);

  // Handle Secure Download
  const handleDownload = async () => {
    try {
      const blob = await apiFetch(`/api/documents/${id}/download`);
      if (!blob || !(blob instanceof Blob)) {
        throw new Error('Received invalid or empty file data');
      }
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc?.originalFileName || doc?.name || 'document';
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
          : 'File could not be downloaded: document not found or access denied.');
      } else {
        alert(`Download error: ${err.message || 'Failed to download'}`);
      }
    }
  };

  // Handle Metadata Form Submission
  const handleMetadataSubmit = async (e) => {
    e.preventDefault();
    setMetadataError('');
    setMetadataSuccess('');
    setIsSavingMetadata(true);

    try {
      const tagsArray = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await apiFetch(`/api/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          title: name.trim(),
          category,
          tags: tagsArray,
          description: description.trim(),
        }),
      });

      setDoc(res.document);
      setMetadataSuccess('Document metadata successfully updated and audited.');
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setMetadataError(err.message || 'Failed to update metadata.');
      }
    } finally {
      setIsSavingMetadata(false);
    }
  };

  // Handle Replacement File Selection
  const handleReplaceFileChange = (e) => {
    setReplaceValidationError(null);
    setReplaceSuccess('');
    if (e.target.files && e.target.files[0]) {
      setReplaceFile(e.target.files[0]);
    }
  };

  // Handle File Replacement Submission
  const handleFileReplaceSubmit = async (e) => {
    e.preventDefault();
    setReplaceValidationError(null);
    setReplaceSuccess('');

    if (!replaceFile) {
      setReplaceValidationError({
        title: 'Validation Error',
        message: 'No file selected for replacement. Please choose a file.',
        hint: 'Click the picker or drag a file to upload.',
      });
      return;
    }

    setIsReplacingFile(true);

    try {
      const formData = new FormData();
      formData.append('file', replaceFile);

      const res = await apiFetch(`/api/documents/${id}/replace`, {
        method: 'POST',
        body: formData,
      });

      setDoc(res.document);
      setReplaceSuccess(
        `File successfully replaced! New SHA-256: ${res.document.sha256.substring(0, 16)}... (archived in audit chain)`
      );
      setReplaceFile(null);
      const input = document.getElementById('replace-file-input');
      if (input) input.value = '';
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        const parsed = parseServerValidationError(
          err.data?.error || err.message || 'File replacement rejected by server',
          err.status
        );
        setReplaceValidationError(parsed);
      }
    } finally {
      setIsReplacingFile(false);
    }
  };

  // Handle Soft-Delete Confirmation
  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    setDeleteError('');

    try {
      await apiFetch(`/api/documents/${id}`, {
        method: 'DELETE',
      });
      setShowDeleteModal(false);
      navigate('/documents', {
        state: { flashMessage: `Document "${doc.name}" was soft-deleted successfully.` },
      });
    } catch (err) {
      if (err.status === 404) {
        setShowDeleteModal(false);
        setIs404(true);
      } else {
        setDeleteError(err.message || 'Failed to delete document.');
      }
    } finally {
      setIsDeleting(false);
    }
  };

  // Handle Grant Permission Form Submission (Owner Only)
  const handleGrantSubmit = async (e) => {
    e.preventDefault();
    setGrantError('');
    setGrantSuccess('');
    setRevokeSuccess('');
    setRevokeError('');

    const trimmed = grantName.trim();
    if (!trimmed) {
      setGrantError('Please enter a user name or email address.');
      return;
    }

    setIsGranting(true);
    try {
      const res = await apiFetch(`/api/documents/${id}/permissions`, {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          level: grantLevel,
        }),
      });

      setGrantSuccess(res.message || `Access successfully granted to "${trimmed}" (${grantLevel.toUpperCase()}).`);
      setGrantName('');
      // Refresh permissions list
      await fetchPermissionsList();
    } catch (err) {
      if (err.status === 404) {
        setGrantError(`User "${trimmed}" not found. Please verify the name or email.`);
      } else {
        setGrantError(err.message || 'Failed to grant permission.');
      }
    } finally {
      setIsGranting(false);
    }
  };

  // Handle Revoke Permission Confirmation (Owner Only)
  const handleRevokeConfirm = async () => {
    if (!userToRevoke) return;
    const targetUserId = userToRevoke.userId || userToRevoke._id;
    setRevokingUserId(targetUserId);
    setRevokeError('');
    setRevokeSuccess('');
    setGrantSuccess('');
    setGrantError('');

    try {
      await apiFetch(`/api/documents/${id}/permissions/${targetUserId}`, {
        method: 'DELETE',
      });

      setPermissionsList((prev) => prev.filter((p) => (p.userId || p._id) !== targetUserId));
      setRevokeSuccess(`Revoked access for ${userToRevoke.email || userToRevoke.name || 'user'}.`);
      setUserToRevoke(null);
    } catch (err) {
      setRevokeError(err.message || 'Failed to revoke access.');
    } finally {
      setRevokingUserId(null);
    }
  };

  // Cloak unauthorized or missing documents with 404 Not Found
  if (is404) {
    return <NotFoundPage />;
  }

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-card">
          <div className="spinner"></div>
          <p className="loading-text">Loading document details & permissions...</p>
        </div>
      </div>
    );
  }

  if (fetchError || !doc) {
    return (
      <div className="page-container">
        <div className="alert alert-error">
          <span>{fetchError || 'Unable to load document.'}</span>
        </div>
        <Link to="/documents" className="btn btn-secondary">
          ← Back to Documents
        </Link>
      </div>
    );
  }

  const isOwner = permissions.isOwner;
  const canEdit = permissions.canEdit;
  const canDelete = permissions.canDelete;

  return (
    <div className="page-container">
      {/* Navigation Breadcrumb */}
      <div className="detail-nav-breadcrumb">
        <Link to="/documents" className="breadcrumb-back-link" id="link-back-documents">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>Back to Documents</span>
        </Link>
        <div className="breadcrumb-trail">
          <span>Documents</span> / <span className="breadcrumb-active">{doc.name || doc.title}</span>
        </div>
      </div>

      {/* Main Document Overview Header */}
      <div className="detail-header-card">
        <div className="detail-header-main">
          <div className="detail-icon-badge">📄</div>
          <div className="detail-title-col">
            <div className="detail-title-row">
              <h1 className="detail-doc-title">{doc.name || doc.title}</h1>
              <span className="badge badge-category">{doc.category || 'general'}</span>
              {isOwner ? (
                <span className="owner-indicator is-self">⭐ You (Owner)</span>
              ) : (
                <span className="badge badge-permission-level">
                  Permission: {permissions.level.toUpperCase()}
                </span>
              )}
            </div>
            <p className="detail-original-filename font-mono text-muted">
              Filename: {doc.originalFileName}
            </p>
          </div>
        </div>

        {/* Primary Action Buttons: Download & Delete */}
        <div className="detail-action-buttons">
          {/* Download Button (Available to all authorized viewers) */}
          <button
            type="button"
            className="btn btn-primary btn-download-hero"
            onClick={handleDownload}
            id="btn-download-document"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Download Document</span>
          </button>

          {/* Delete Button (Rendered ONLY if user's permissions allow deletion: Owner Only) */}
          {canDelete && (
            <button
              type="button"
              className="btn btn-danger-outline"
              onClick={() => setShowDeleteModal(true)}
              id="btn-delete-document-trigger"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              <span>Delete Document</span>
            </button>
          )}
        </div>
      </div>

      {/* Grid: Metadata Specs & Edit Panel */}
      <div className="detail-grid-layout">
        {/* Left Column: Cryptographic Specs & Document Information */}
        <div className="detail-info-column">
          <div className="detail-card">
            <h2 className="section-title">Cryptographic & Storage Specs</h2>
            <div className="spec-item-list">
              <div className="spec-item">
                <span className="spec-label">File Size:</span>
                <span className="spec-value">{formatBytes(doc.size || doc.sizeBytes)}</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">MIME Type:</span>
                <span className="spec-value font-mono">{doc.mimeType}</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Owner Account:</span>
                <span className="spec-value">{doc.ownerEmail || (isOwner ? user?.email : 'Other User')}</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Date Created:</span>
                <span className="spec-value">
                  {new Date(doc.createdAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Last Modified:</span>
                <span className="spec-value">
                  {new Date(doc.updatedAt || doc.createdAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="spec-item spec-item-block">
                <span className="spec-label">SHA-256 Digest (Verified):</span>
                <div className="sha256-box font-mono" title={doc.sha256}>
                  <span className="sha256-text">{doc.sha256}</span>
                  <span className="sha-verified-badge">✓ Verified</span>
                </div>
              </div>
            </div>

            {/* Tags Display (Safe plain-text rendering) */}
            <div className="detail-tags-section">
              <span className="spec-label">Tags:</span>
              {Array.isArray(doc.tags) && doc.tags.length > 0 ? (
                <div className="doc-tags-row">
                  {doc.tags.map((tag, idx) => (
                    <span key={idx} className="tag-pill">
                      #{tag}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-dim">No tags assigned</span>
              )}
            </div>

            {/* Description Display */}
            {doc.description && (
              <div className="detail-description-section">
                <span className="spec-label">Description:</span>
                <p className="detail-description-text">{doc.description}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Edit Form (Metadata & File Replacement) */}
        <div className="detail-edit-column">
          {canEdit ? (
            <div className="detail-card edit-card" id="edit-form-card">
              {/* Tab Navigation: Edit Metadata vs Replace File */}
              <div className="edit-tabs-nav">
                <button
                  type="button"
                  className={`edit-tab-btn ${activeTab === 'metadata' ? 'active' : ''}`}
                  onClick={() => setActiveTab('metadata')}
                  id="tab-edit-metadata"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                  <span>Edit Metadata</span>
                </button>
                <button
                  type="button"
                  className={`edit-tab-btn ${activeTab === 'replace' ? 'active' : ''}`}
                  onClick={() => setActiveTab('replace')}
                  id="tab-replace-file"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <polyline points="17 1 21 5 17 9" />
                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" />
                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                  <span>Replace File</span>
                </button>
              </div>

              {/* =============================================================
                 TAB 1: EDIT METADATA FORM
                 ============================================================= */}
              {activeTab === 'metadata' && (
                <form onSubmit={handleMetadataSubmit} className="edit-form">
                  <div className="form-header-note">
                    <p className="text-sub">
                      Update document attributes. Changes are cryptographically timestamped and audited.
                    </p>
                  </div>

                  {metadataSuccess && (
                    <div className="alert alert-success" role="status">
                      <span>✅ {metadataSuccess}</span>
                    </div>
                  )}

                  {metadataError && (
                    <div className="alert alert-error" role="alert">
                      <span>⚠️ {metadataError}</span>
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-label" htmlFor="edit-name-input">
                      Document Name / Title <span className="text-danger">*</span>
                    </label>
                    <input
                      id="edit-name-input"
                      type="text"
                      className="form-input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="edit-category-select">
                      Category
                    </label>
                    <select
                      id="edit-category-select"
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

                  <div className="form-group">
                    <label className="form-label" htmlFor="edit-tags-input">
                      Tags <span className="text-muted">(comma-separated)</span>
                    </label>
                    <input
                      id="edit-tags-input"
                      type="text"
                      className="form-input"
                      value={tagsInput}
                      onChange={(e) => setTagsInput(e.target.value)}
                      placeholder="e.g. audit, executive, 2026"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="edit-description-textarea">
                      Description / Notes
                    </label>
                    <textarea
                      id="edit-description-textarea"
                      className="form-input form-textarea"
                      rows="4"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Enter optional description or notes..."
                    />
                  </div>

                  <div className="edit-submit-row">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={isSavingMetadata}
                      id="btn-save-metadata"
                    >
                      {isSavingMetadata ? (
                        <>
                          <span className="spinner-sm"></span>
                          <span>Saving Changes...</span>
                        </>
                      ) : (
                        <span>Save Metadata Changes</span>
                      )}
                    </button>
                  </div>
                </form>
              )}

              {/* =============================================================
                 TAB 2: FILE REPLACEMENT FORM
                 ============================================================= */}
              {activeTab === 'replace' && (
                <form onSubmit={handleFileReplaceSubmit} className="edit-form">
                  <div className="form-header-note">
                    <p className="text-sub">
                      Replace the physical file. The server computes a new SHA-256 hash and records the transition (old & new SHA-256) in the immutable audit log.
                    </p>
                  </div>

                  {replaceSuccess && (
                    <div className="alert alert-success" role="status">
                      <span>✅ {replaceSuccess}</span>
                    </div>
                  )}

                  {/* Prominent Server Validation Error Alert */}
                  {replaceValidationError && (
                    <div className="alert alert-error server-error-box" role="alert" id="replace-validation-alert">
                      <div className="error-icon-col">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="24" height="24">
                          <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
                          <line x1="12" y1="8" x2="12" y2="12" />
                          <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                      </div>
                      <div className="error-content-col">
                        <strong className="error-title-text">{replaceValidationError.title}</strong>
                        <div className="error-server-msg">Server response: "{replaceValidationError.message}"</div>
                        {replaceValidationError.hint && (
                          <div className="error-hint-text">💡 {replaceValidationError.hint}</div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-label" htmlFor="replace-file-input">
                      Choose Replacement File <span className="text-danger">*</span>
                    </label>
                    <div className={`file-drop-zone ${replaceFile ? 'has-file' : ''}`}>
                      <input
                        id="replace-file-input"
                        type="file"
                        className="file-input"
                        onChange={handleReplaceFileChange}
                      />
                      <div className="file-drop-content">
                        <div className="file-upload-icon">{replaceFile ? '📄' : '🔄'}</div>
                        <span className="file-upload-prompt">
                          {replaceFile ? replaceFile.name : 'Select a replacement file (PDF, PNG, JPEG, WEBP)'}
                        </span>
                        {replaceFile && (
                          <span className="file-size-hint">
                            Size: {(replaceFile.size / 1024).toFixed(1)} KB (Type: {replaceFile.type || 'detected by server'})
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="edit-submit-row">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={isReplacingFile}
                      id="btn-submit-replace-file"
                    >
                      {isReplacingFile ? (
                        <>
                          <span className="spinner-sm"></span>
                          <span>Hashing & Replacing File...</span>
                        </>
                      ) : (
                        <span>Upload Replacement File</span>
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            /* Read-Only Notice: Rendered when user lacks edit permission */
            <div className="detail-card read-only-notice-card" id="read-only-card">
              <div className="notice-icon">🔒</div>
              <h3 className="notice-title">Read-Only Document Access</h3>
              <p className="notice-text">
                Your account possesses <strong>read permission</strong> for this document. Editing metadata and replacing the physical file are restricted to the document owner or users with granted edit rights.
              </p>
              <div className="notice-contact">
                Document Owner: <strong>{doc.ownerEmail || 'Vault Owner'}</strong>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* =====================================================================
         SHARING & ACCESS CONTROL PANEL (OWNER ONLY)
         ===================================================================== */}
      {isOwner && (
        <div className="detail-card sharing-panel-card" id="sharing-panel">
          <div className="sharing-header-row">
            <div className="sharing-header-info">
              <div className="sharing-icon-badge">👥</div>
              <div>
                <h2 className="section-title sharing-title">Sharing & Access Control</h2>
                <p className="text-sub">
                  Grant or revoke document access for individual users. All permission changes are sealed into the immutable audit hash chain.
                </p>
              </div>
            </div>
            <span className="owner-indicator is-self">🔒 Owner Managed</span>
          </div>

          {/* Feedback Alerts */}
          {grantSuccess && (
            <div className="alert alert-success" role="status" id="grant-success-alert">
              <span>✅ {grantSuccess}</span>
            </div>
          )}
          {grantError && (
            <div className="alert alert-error" role="alert" id="grant-error-alert">
              <span>⚠️ {grantError}</span>
            </div>
          )}
          {revokeSuccess && (
            <div className="alert alert-success" role="status" id="revoke-success-alert">
              <span>✅ {revokeSuccess}</span>
            </div>
          )}
          {revokeError && (
            <div className="alert alert-error" role="alert" id="revoke-error-alert">
              <span>⚠️ {revokeError}</span>
            </div>
          )}

          {/* List of Who Has Access */}
          <div className="sharing-list-section">
            <div className="sharing-list-header">
              <h3 className="sharing-section-subtitle">
                Current Access List
              </h3>
              <span className="count-pill">{permissionsList.length + 1} with access</span>
            </div>

            <div className="sharing-table-wrapper">
              <table className="sharing-table" id="sharing-access-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email Address</th>
                    <th>Access Level</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Document Owner (Non-revocable) */}
                  <tr className="owner-access-row">
                    <td>
                      <div className="user-name-cell">
                        <span className="user-avatar-badge avatar-owner">⭐</span>
                        <div>
                          <span className="user-display-name">{user?.email ? user.email.split('@')[0] : 'Owner'}</span>
                          <span className="badge badge-owner-tag">Owner</span>
                        </div>
                      </div>
                    </td>
                    <td className="font-mono text-muted">{user?.email}</td>
                    <td>
                      <span className="level-badge level-badge-owner">FULL (OWNER)</span>
                    </td>
                    <td className="text-muted text-xs">Primary Owner</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="text-muted text-xs font-italic">Non-revocable</span>
                    </td>
                  </tr>

                  {/* Users with Granted Access */}
                  {permissionsList.map((perm) => {
                    const permUserId = perm.userId || perm._id;
                    const isBeingRevoked = revokingUserId === permUserId;

                    return (
                      <tr key={perm._id || permUserId} id={`permission-row-${permUserId}`}>
                        <td>
                          <div className="user-name-cell">
                            <span className="user-avatar-badge">
                              {(perm.name || perm.email || 'U').charAt(0).toUpperCase()}
                            </span>
                            <span className="user-display-name">{perm.name || perm.email.split('@')[0]}</span>
                          </div>
                        </td>
                        <td className="font-mono text-muted">{perm.email}</td>
                        <td>
                          {perm.level === 'edit' ? (
                            <span className="level-badge level-badge-edit">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                              </svg>
                              EDIT (Read & Edit)
                            </span>
                          ) : (
                            <span className="level-badge level-badge-read">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                              READ (View & Download)
                            </span>
                          )}
                        </td>
                        <td className="text-muted text-xs">
                          {perm.createdAt
                            ? new Date(perm.createdAt).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : 'Active'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-danger-sm btn-revoke"
                            onClick={() => setUserToRevoke(perm)}
                            disabled={isBeingRevoked}
                            id={`btn-revoke-${permUserId}`}
                            title={`Revoke access for ${perm.email || perm.name}`}
                          >
                            {isBeingRevoked ? (
                              <>
                                <span className="spinner-sm"></span>
                                <span>Revoking...</span>
                              </>
                            ) : (
                              <>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                                <span>Revoke</span>
                              </>
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {permissionsList.length === 0 && (
                    <tr>
                      <td colSpan="5" className="empty-permissions-row">
                        <div className="empty-permissions-inner">
                          <p className="empty-permissions-title">No other users currently have access</p>
                          <p className="empty-permissions-sub">
                            This document is private to you. Use the form below to grant access by name.
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Form to Grant Access to a User by Name */}
          <div className="grant-form-wrapper">
            <h3 className="sharing-section-subtitle">Grant Access to a User</h3>
            <p className="text-sub text-xs">
              Enter the user's name or email to grant access. Select whether they can only read or also edit.
            </p>

            <form onSubmit={handleGrantSubmit} className="grant-form-grid" id="form-grant-permission">
              <div className="form-group grant-input-group">
                <label className="form-label" htmlFor="grant-user-name-input">
                  User Name or Email <span className="text-danger">*</span>
                </label>
                <input
                  id="grant-user-name-input"
                  type="text"
                  className="form-input"
                  value={grantName}
                  onChange={(e) => setGrantName(e.target.value)}
                  placeholder="e.g. viewer or viewer@trustvault.local"
                  required
                />
              </div>

              <div className="form-group grant-level-group">
                <label className="form-label" htmlFor="grant-level-select">
                  Permission Level <span className="text-danger">*</span>
                </label>
                <select
                  id="grant-level-select"
                  className="form-input"
                  value={grantLevel}
                  onChange={(e) => setGrantLevel(e.target.value)}
                >
                  <option value="read">Read (View & Download)</option>
                  <option value="edit">Edit (View, Download, Edit & Replace)</option>
                </select>
              </div>

              <div className="grant-submit-btn-col">
                <button
                  type="submit"
                  className="btn btn-primary btn-grant-submit"
                  disabled={isGranting}
                  id="btn-grant-access"
                >
                  {isGranting ? (
                    <>
                      <span className="spinner-sm"></span>
                      <span>Granting Access...</span>
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>Grant Access</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =====================================================================
         REVOKE ACCESS CONFIRMATION MODAL (Owner Only)
         ===================================================================== */}
      {userToRevoke && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="revoke-dialog-title">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-icon-danger">⚠️</div>
              <h3 className="modal-title" id="revoke-dialog-title">
                Confirm Revoke Access
              </h3>
            </div>
            <div className="modal-body">
              <p className="modal-text">
                Revoke access for <strong>{userToRevoke.email || userToRevoke.name}</strong>?
              </p>
              <p className="modal-subtext text-muted">
                This user will immediately lose access to this document and subsequent download, view, or edit attempts will return 404 Not Found. This revocation is recorded in the tamper-evident audit hash chain.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setUserToRevoke(null)}
                disabled={Boolean(revokingUserId)}
                id="btn-cancel-revoke"
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleRevokeConfirm}
                disabled={Boolean(revokingUserId)}
                id="btn-confirm-revoke"
              >
                {revokingUserId ? (
                  <>
                    <span className="spinner-sm"></span>
                    <span>Revoking Access...</span>
                  </>
                ) : (
                  <span>Yes, Revoke Access</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
         DELETE CONFIRMATION MODAL (Owner Only)
         ===================================================================== */}
      {showDeleteModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-icon-danger">⚠️</div>
              <h3 className="modal-title" id="delete-dialog-title">
                Confirm Document Deletion
              </h3>
            </div>
            <div className="modal-body">
              <p className="modal-text">
                Are you sure you want to soft-delete <strong>"{doc.name || doc.title}"</strong>?
              </p>
              <p className="modal-subtext text-muted">
                This document will be marked as deleted and immediately become inaccessible. An immutable record of this deletion will be sealed into the audit hash chain.
              </p>
              {deleteError && (
                <div className="alert alert-error" style={{ marginTop: '1rem' }}>
                  <span>{deleteError}</span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowDeleteModal(false)}
                disabled={isDeleting}
                id="btn-cancel-delete"
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                id="btn-confirm-delete"
              >
                {isDeleting ? (
                  <>
                    <span className="spinner-sm"></span>
                    <span>Deleting Document...</span>
                  </>
                ) : (
                  <span>Yes, Delete Document</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
