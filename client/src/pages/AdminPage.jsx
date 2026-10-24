import React, { useState, useEffect } from 'react';
import { apiFetch } from '../api/client';
import NotFoundPage from './NotFoundPage';

/**
 * Admin Console Component.
 * Accessible strictly to users with role === 'admin'.
 * Enforces Rule 4: Zero automatic access to document contents.
 * Renders operational metadata only (no file contents, no download links).
 * Provides interactive button to execute verifyChain().
 */
export default function AdminPage() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [is404, setIs404] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const fetchActivity = async () => {
    try {
      setLoading(true);
      setError(null);
      setIs404(false);
      const data = await apiFetch('/api/admin/activity');
      setActivities(data.activityFeed || data.activities || []);
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setError(err.message || 'Failed to fetch admin activity stream');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchActivity();
  }, []);

  const handleVerifyChain = async () => {
    setIsVerifying(true);
    setVerificationResult(null);
    try {
      const data = await apiFetch('/api/admin/verify-chain', {
        method: 'POST',
      });
      setVerificationResult(data);
    } catch (err) {
      setVerificationResult({
        valid: false,
        error: err.message || 'Verification execution failed',
      });
    } finally {
      setIsVerifying(false);
    }
  };

  if (is404) {
    return <NotFoundPage />;
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Administration Console</h1>
          <p className="page-subtitle">
            Audit Ledger Oversight & Cryptographic Integrity Verification (Metadata only, zero content access).
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleVerifyChain}
            disabled={isVerifying}
            id="btn-verify-chain"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>{isVerifying ? 'Verifying Hashes...' : 'Verify Hash Chain'}</span>
          </button>
        </div>
      </div>

      {/* Cryptographic Chain Verification Result Banner */}
      {verificationResult && (
        <div className={`alert ${verificationResult.valid ? 'alert-success' : 'alert-error'}`}>
          <div className="verification-status-box">
            <span className="verification-icon">
              {verificationResult.valid ? '🛡️' : '⚠️'}
            </span>
            <div>
              <strong>
                {verificationResult.valid
                  ? 'Audit Chain Intact & Verified'
                  : 'Audit Chain Tampering Detected!'}
              </strong>
              <div className="verification-meta-text">
                {verificationResult.valid
                  ? `Monotonically verified ${verificationResult.eventCount || verificationResult.blockHeight || activities.length} consecutive events. All hash pointers match.`
                  : `Integrity Failure: ${verificationResult.error}`}
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      )}

      {/* Activity Feed */}
      <div className="admin-feed-section">
        <h2 className="section-title">Audit Activity Feed (Metadata Stream)</h2>
        {loading ? (
          <div className="loading-card">
            <div className="spinner"></div>
            <p className="loading-text">Loading audit activity...</p>
          </div>
        ) : activities.length === 0 ? (
          <div className="empty-state-card">
            <p className="empty-text">No audit events recorded yet.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="vault-table">
              <thead>
                <tr>
                  <th>Seq #</th>
                  <th>Event Type</th>
                  <th>Status</th>
                  <th>Action</th>
                  <th>User Email</th>
                  <th>Timestamp</th>
                  <th>Hash Pointer</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((act) => (
                  <tr key={act._id || act.sequenceNumber}>
                    <td className="font-mono text-muted">#{act.sequenceNumber}</td>
                    <td>
                      <span className="badge badge-event">{act.eventType}</span>
                    </td>
                    <td>
                      <span className={`status-pill status-${act.status?.toLowerCase()}`}>
                        {act.status}
                      </span>
                    </td>
                    <td className="font-mono">{act.action}</td>
                    <td className="text-highlight">{act.userEmail || act.userId || 'System'}</td>
                    <td className="text-muted">
                      {new Date(act.timestamp || act.createdAt).toLocaleString()}
                    </td>
                    <td className="font-mono text-muted text-truncate" title={act.hash}>
                      {act.hash ? `${act.hash.slice(0, 10)}...` : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
