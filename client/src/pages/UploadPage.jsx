import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../api/client';

/**
 * Upload Page Component.
 * Dispatches file upload to POST /api/documents/upload.
 * CSRF token is automatically appended to request headers by apiFetch.
 */
export default function UploadPage() {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('general');
  const [description, setDescription] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const navigate = useNavigate();

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      if (!title) {
        setTitle(selected.name.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      setErrorMessage('Please select a file to upload.');
      return;
    }

    setErrorMessage('');
    setSuccessMessage('');
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', title);
      formData.append('name', title);
      formData.append('category', category);
      formData.append('description', description);

      await apiFetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      });

      setSuccessMessage('Document securely uploaded and encrypted in vault.');
      setTimeout(() => {
        navigate('/documents');
      }, 1200);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to upload document');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Upload Confidential Document</h1>
          <p className="page-subtitle">
            Files are stored outside the web root under randomized UUIDs with SHA-256 integrity verification.
          </p>
        </div>
        <Link to="/documents" className="btn btn-secondary">
          Back to Documents
        </Link>
      </div>

      <div className="form-card-wrapper">
        <div className="form-card">
          {errorMessage && (
            <div className="alert alert-error">
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="alert alert-success">
              <span>{successMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="upload-form">
            <div className="form-group">
              <label className="form-label" htmlFor="upload-file">
                Select File
              </label>
              <div className="file-drop-zone">
                <input
                  id="upload-file"
                  type="file"
                  className="file-input"
                  onChange={handleFileChange}
                  required
                />
                <div className="file-drop-content">
                  <div className="file-upload-icon">📁</div>
                  <span className="file-upload-prompt">
                    {file ? file.name : 'Choose a file or drag & drop here'}
                  </span>
                  {file && (
                    <span className="file-size-hint">
                      ({(file.size / 1024).toFixed(1)} KB)
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="upload-title">
                Document Title
              </label>
              <input
                id="upload-title"
                type="text"
                className="form-input"
                placeholder="e.g. Q3 Financial Statement"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="upload-category">
                Category
              </label>
              <select
                id="upload-category"
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
              <label className="form-label" htmlFor="upload-desc">
                Description (Optional)
              </label>
              <textarea
                id="upload-desc"
                className="form-input form-textarea"
                rows="3"
                placeholder="Brief summary of document contents..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg"
              disabled={isUploading}
            >
              {isUploading ? 'Securing & Uploading...' : 'Upload Document'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
