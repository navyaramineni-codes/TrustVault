import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client';
import { useAuth } from '../context/AuthContext';
import NotFoundPage from './NotFoundPage';

/**
 * Admin Console Component.
 *
 * Enforces strict security specifications:
 * - Accessible strictly to users with role === 'admin'.
 * - Enforces Rule 4: Zero automatic access to document contents.
 * - Prompt constraint: "No file contents and no download links on any admin page."
 * - Non-admins receive 404 Not Found (enforcing Rule 3).
 *
 * Provides:
 * 1. User Management (create user, change role, disable user with session revocation).
 * 2. Activity Feed (with filters for user, document, date range, event type, status).
 * 3. Permission-Change History (with filters by user, document, and date).
 * 4. “Verify audit chain” button that prominently displays PASS or FAIL.
 */
export default function AdminPage() {
  const { tab: urlTab } = useParams();
  const navigate = useNavigate();
  const { user: currentAdmin } = useAuth();

  // Active Tab State (users | activity | permissions)
  const validTabs = ['users', 'activity', 'permissions'];
  const activeTab = validTabs.includes(urlTab) ? urlTab : 'users';

  const switchTab = (tabName) => {
    navigate(`/admin/${tabName}`);
  };

  // Global State
  const [is404, setIs404] = useState(false);
  const [globalError, setGlobalError] = useState(null);

  // -------------------------------------------------------------
  // Cryptographic Chain Verification State
  // -------------------------------------------------------------
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);

  const handleVerifyChain = async () => {
    setIsVerifying(true);
    setVerificationResult(null);
    setGlobalError(null);
    try {
      const data = await apiFetch('/api/admin/verify-chain', {
        method: 'POST',
      });
      setVerificationResult(data);
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setVerificationResult({
          pass: false,
          isValid: false,
          error: err.message || 'Verification execution failed',
          verifiedAt: new Date().toISOString(),
        });
      }
    } finally {
      setIsVerifying(false);
    }
  };

  // -------------------------------------------------------------
  // Tab 1: User Management State & Actions
  // -------------------------------------------------------------
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userError, setUserError] = useState(null);
  const [userSuccess, setUserSuccess] = useState(null);

  // Create User Form State
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState('user');
  const [creatingUser, setCreatingUser] = useState(false);

  // User Disablement State (Confirmation Modal)
  const [userToDisable, setUserToDisable] = useState(null);
  const [disablingUser, setDisablingUser] = useState(false);
  const [updatingRoleId, setUpdatingRoleId] = useState(null);

  const fetchUsers = useCallback(async () => {
    try {
      setLoadingUsers(true);
      setUserError(null);
      const data = await apiFetch('/api/admin/users');
      setUsers(data.users || []);
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setUserError(err.message || 'Failed to fetch user list');
      }
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setUserError(null);
    setUserSuccess(null);

    if (!createEmail.trim() || !createPassword.trim()) {
      setUserError('Email and password are required');
      return;
    }

    try {
      setCreatingUser(true);
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        body: {
          email: createEmail.trim(),
          password: createPassword,
          role: createRole,
        },
      });

      setUserSuccess(`User ${res.user?.email || createEmail} provisioned successfully with role "${res.user?.role || createRole}".`);
      setCreateEmail('');
      setCreatePassword('');
      setCreateRole('user');
      await fetchUsers();
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setUserError(err.message || 'Failed to create user');
      }
    } finally {
      setCreatingUser(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    setUserError(null);
    setUserSuccess(null);
    try {
      setUpdatingRoleId(userId);
      const res = await apiFetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        body: { role: newRole },
      });
      setUserSuccess(`Role updated to "${res.user?.role || newRole}" for ${res.user?.email}.`);
      setUsers((prev) =>
        prev.map((u) => (u._id === userId ? { ...u, role: res.user?.role || newRole } : u))
      );
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setUserError(err.message || 'Failed to update user role');
      }
    } finally {
      setUpdatingRoleId(null);
    }
  };

  const handleConfirmDisable = async () => {
    if (!userToDisable) return;
    setUserError(null);
    setUserSuccess(null);

    try {
      setDisablingUser(true);
      await apiFetch(`/api/admin/users/${userToDisable._id}/disable`, {
        method: 'POST',
      });
      setUserSuccess(`Account ${userToDisable.email} has been disabled and all active sessions revoked.`);
      setUsers((prev) =>
        prev.map((u) => (u._id === userToDisable._id ? { ...u, isActive: false } : u))
      );
      setUserToDisable(null);
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setUserError(err.message || 'Failed to disable user');
      }
    } finally {
      setDisablingUser(false);
    }
  };

  // -------------------------------------------------------------
  // Tab 2: Activity Feed State & Filters
  // -------------------------------------------------------------
  const [activities, setActivities] = useState([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError, setActivityError] = useState(null);

  const [feedFilterUser, setFeedFilterUser] = useState('');
  const [feedFilterDoc, setFeedFilterDoc] = useState('');
  const [feedFilterStart, setFeedFilterStart] = useState('');
  const [feedFilterEnd, setFeedFilterEnd] = useState('');
  const [feedFilterType, setFeedFilterType] = useState('');
  const [feedFilterStatus, setFeedFilterStatus] = useState('');

  const fetchActivity = useCallback(async (customParams = {}) => {
    try {
      setLoadingActivity(true);
      setActivityError(null);

      const params = new URLSearchParams();
      if (customParams.user) params.set('user', customParams.user);
      if (customParams.document) params.set('document', customParams.document);
      if (customParams.startDate) params.set('startDate', customParams.startDate);
      if (customParams.endDate) params.set('endDate', customParams.endDate);
      if (customParams.eventType) params.set('eventType', customParams.eventType);
      if (customParams.status) params.set('status', customParams.status);

      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiFetch(`/api/admin/activity${qs}`);
      setActivities(data.events || data.activityFeed || data.activities || []);
      setActivityTotal(data.total !== undefined ? data.total : (data.count || 0));
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setActivityError(err.message || 'Failed to fetch activity feed');
      }
    } finally {
      setLoadingActivity(false);
    }
  }, []);

  const handleApplyFeedFilters = (e) => {
    if (e) e.preventDefault();
    fetchActivity({
      user: feedFilterUser.trim(),
      document: feedFilterDoc.trim(),
      startDate: feedFilterStart,
      endDate: feedFilterEnd,
      eventType: feedFilterType,
      status: feedFilterStatus,
    });
  };

  const handleResetFeedFilters = () => {
    setFeedFilterUser('');
    setFeedFilterDoc('');
    setFeedFilterStart('');
    setFeedFilterEnd('');
    setFeedFilterType('');
    setFeedFilterStatus('');
    fetchActivity({});
  };

  // -------------------------------------------------------------
  // Tab 3: Permission-Change History State & Filters
  // -------------------------------------------------------------
  const [permHistory, setPermHistory] = useState([]);
  const [permTotal, setPermTotal] = useState(0);
  const [loadingPerms, setLoadingPerms] = useState(false);
  const [permError, setPermError] = useState(null);

  const [permFilterUser, setPermFilterUser] = useState('');
  const [permFilterDoc, setPermFilterDoc] = useState('');
  const [permFilterStart, setPermFilterStart] = useState('');
  const [permFilterEnd, setPermFilterEnd] = useState('');

  const fetchPermHistory = useCallback(async (customParams = {}) => {
    try {
      setLoadingPerms(true);
      setPermError(null);

      const params = new URLSearchParams();
      if (customParams.user) params.set('user', customParams.user);
      if (customParams.document) params.set('document', customParams.document);
      if (customParams.startDate) params.set('startDate', customParams.startDate);
      if (customParams.endDate) params.set('endDate', customParams.endDate);

      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiFetch(`/api/admin/permissions/history${qs}`);
      setPermHistory(data.events || []);
      setPermTotal(data.total !== undefined ? data.total : (data.count || 0));
    } catch (err) {
      if (err.status === 404) {
        setIs404(true);
      } else {
        setPermError(err.message || 'Failed to fetch permission-change history');
      }
    } finally {
      setLoadingPerms(false);
    }
  }, []);

  const handleApplyPermFilters = (e) => {
    if (e) e.preventDefault();
    fetchPermHistory({
      user: permFilterUser.trim(),
      document: permFilterDoc.trim(),
      startDate: permFilterStart,
      endDate: permFilterEnd,
    });
  };

  const handleResetPermFilters = () => {
    setPermFilterUser('');
    setPermFilterDoc('');
    setPermFilterStart('');
    setPermFilterEnd('');
    fetchPermHistory({});
  };

  // Load data corresponding to active tab
  useEffect(() => {
    if (activeTab === 'users') {
      fetchUsers();
    } else if (activeTab === 'activity') {
      fetchActivity({
        user: feedFilterUser.trim(),
        document: feedFilterDoc.trim(),
        startDate: feedFilterStart,
        endDate: feedFilterEnd,
        eventType: feedFilterType,
        status: feedFilterStatus,
      });
    } else if (activeTab === 'permissions') {
      fetchPermHistory({
        user: permFilterUser.trim(),
        document: permFilterDoc.trim(),
        startDate: permFilterStart,
        endDate: permFilterEnd,
      });
    }
  }, [activeTab, fetchUsers, fetchActivity, fetchPermHistory]);

  if (is404) {
    return <NotFoundPage />;
  }

  // Determine Pass / Fail from verification result
  const isPass = verificationResult?.pass === true || verificationResult?.isValid === true;
  const isFail = verificationResult && !isPass;

  return (
    <div className="page-container admin-page-container">
      {/* Header with Title and “Verify audit chain” Action Button */}
      <div className="page-header admin-page-header">
        <div>
          <div className="admin-header-badge">
            <span className="badge-shield-icon">🛡️</span>
            <span>Zero Content Access Security Model</span>
          </div>
          <h1 className="page-title">Administration Console</h1>
          <p className="page-subtitle">
            User identity management, cryptographic audit ledger, and permission modification history.
            <strong className="admin-constraint-note"> Metadata only — zero file contents or download links.</strong>
          </p>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className={`btn btn-verify-chain ${isVerifying ? 'btn-loading' : ''}`}
            onClick={handleVerifyChain}
            disabled={isVerifying}
            id="btn-verify-chain"
            title="Execute SHA-256 cryptographic hash chain verification over all ledger rows"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>{isVerifying ? 'Verifying Chain...' : 'Verify audit chain'}</span>
          </button>
        </div>
      </div>

      {/* Prominent Cryptographic Chain Verification Result Banner (PASS / FAIL) */}
      {verificationResult && (
        <div
          className={`verify-result-banner ${isPass ? 'verify-pass' : 'verify-fail'}`}
          id="audit-chain-verification-banner"
        >
          <div className="verify-result-header">
            <div className="verify-result-badge-col">
              <span className={`verify-status-badge ${isPass ? 'badge-pass' : 'badge-fail'}`}>
                {isPass ? 'PASS' : 'FAIL'}
              </span>
            </div>
            <div className="verify-result-details">
              <h3 className="verify-result-title">
                {isPass
                  ? 'Cryptographic Audit Chain Intact & Verified'
                  : 'Audit Chain Tampering Detected!'}
              </h3>
              <p className="verify-result-desc">
                {isPass ? (
                  <>
                    Monotonically verified{' '}
                    <strong>{verificationResult.totalEvents || verificationResult.eventCount || 0}</strong> consecutive audit events.
                    All SHA-256 hash pointers matched perfectly with zero detected alterations.
                  </>
                ) : (
                  <>
                    Integrity verification failed!{' '}
                    {verificationResult.brokenSequence && (
                      <span className="broken-seq-pill">
                        Broken Sequence #{verificationResult.brokenSequence}
                      </span>
                    )}
                    <span className="fail-error-text">
                      {verificationResult.error || 'Hash mismatch detected in audit log.'}
                    </span>
                  </>
                )}
              </p>
              <div className="verify-result-meta">
                <span>Verified At: {new Date(verificationResult.verifiedAt || Date.now()).toLocaleTimeString()}</span>
                {verificationResult.latestHash && (
                  <span className="latest-hash-text font-mono">
                    Latest Hash: {verificationResult.latestHash.slice(0, 16)}...
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="verify-close-btn"
              onClick={() => setVerificationResult(null)}
              title="Dismiss verification banner"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {globalError && (
        <div className="alert alert-error">
          <span>{globalError}</span>
        </div>
      )}

      {/* Admin Tabs Navigation Bar */}
      <div className="admin-tabs-nav">
        <button
          type="button"
          className={`admin-tab-btn ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => switchTab('users')}
          id="tab-btn-users"
        >
          <span className="tab-icon">👥</span>
          <span className="tab-label">User Management</span>
          {users.length > 0 && <span className="tab-counter">{users.length}</span>}
        </button>

        <button
          type="button"
          className={`admin-tab-btn ${activeTab === 'activity' ? 'active' : ''}`}
          onClick={() => switchTab('activity')}
          id="tab-btn-activity"
        >
          <span className="tab-icon">📜</span>
          <span className="tab-label">Activity Feed</span>
          {activityTotal > 0 && <span className="tab-counter">{activityTotal}</span>}
        </button>

        <button
          type="button"
          className={`admin-tab-btn ${activeTab === 'permissions' ? 'active' : ''}`}
          onClick={() => switchTab('permissions')}
          id="tab-btn-permissions"
        >
          <span className="tab-icon">🔐</span>
          <span className="tab-label">Permission History</span>
          {permTotal > 0 && <span className="tab-counter">{permTotal}</span>}
        </button>
      </div>

      {/* =====================================================================
          TAB 1: USER MANAGEMENT (Create, Change Role, Disable)
          ===================================================================== */}
      {activeTab === 'users' && (
        <div className="admin-tab-content" id="panel-user-management">
          {/* User Feedback Messages */}
          {userError && (
            <div className="alert alert-error">
              <span>{userError}</span>
            </div>
          )}
          {userSuccess && (
            <div className="alert alert-success">
              <span>{userSuccess}</span>
            </div>
          )}

          {/* Provision New User Card */}
          <div className="admin-card user-create-card">
            <div className="admin-card-header">
              <div className="admin-card-icon">➕</div>
              <div>
                <h2 className="admin-card-title">Create User Account</h2>
                <p className="admin-card-subtitle">
                  Provision new credentials with Argon2id cryptographic hashing.
                </p>
              </div>
            </div>

            <form onSubmit={handleCreateUser} className="admin-form-grid" id="form-create-user">
              <div className="form-group">
                <label className="form-label" htmlFor="create-user-email">
                  Email Address
                </label>
                <input
                  type="email"
                  id="create-user-email"
                  className="form-input"
                  placeholder="analyst@trustvault.local"
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="create-user-password">
                  Initial Password
                </label>
                <input
                  type="password"
                  id="create-user-password"
                  className="form-input"
                  placeholder="Minimum 8 characters"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="create-user-role">
                  System Role
                </label>
                <select
                  id="create-user-role"
                  className="form-input form-select"
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value)}
                >
                  <option value="user">Standard User (user)</option>
                  <option value="admin">Administrator (admin)</option>
                </select>
              </div>

              <div className="form-submit-col">
                <button
                  type="submit"
                  className="btn btn-primary btn-create-user-submit"
                  disabled={creatingUser}
                  id="btn-submit-create-user"
                >
                  {creatingUser ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>

          {/* Registered Users Table */}
          <div className="admin-card user-table-card">
            <div className="admin-table-header-row">
              <div>
                <h2 className="admin-card-title">Registered User Directory</h2>
                <p className="admin-card-subtitle">
                  Manage roles and enforce immediate session invalidation by disabling accounts.
                </p>
              </div>
              <div className="user-count-badge">
                {users.length} {users.length === 1 ? 'Account' : 'Accounts'}
              </div>
            </div>

            {loadingUsers ? (
              <div className="loading-card">
                <div className="spinner"></div>
                <p className="loading-text">Loading user directory...</p>
              </div>
            ) : users.length === 0 ? (
              <div className="empty-state-card">
                <p className="empty-text">No registered users found.</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="vault-table admin-users-table">
                  <thead>
                    <tr>
                      <th>Account Email</th>
                      <th>Current Role</th>
                      <th>Status</th>
                      <th>Created Date</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const isCurrent = currentAdmin?._id === u._id || currentAdmin?.id === u._id;
                      const isActive = u.isActive !== false;

                      return (
                        <tr key={u._id} className={!isActive ? 'row-disabled' : ''}>
                          <td>
                            <div className="user-email-cell">
                              <span className="user-avatar-initial">
                                {u.email ? u.email.charAt(0).toUpperCase() : '?'}
                              </span>
                              <div>
                                <strong className="user-email-text">{u.email}</strong>
                                {isCurrent && <span className="current-user-tag">(You)</span>}
                              </div>
                            </div>
                          </td>

                          <td>
                            <span className={`badge badge-role ${u.role === 'admin' ? 'role-admin' : 'role-user'}`}>
                              {u.role}
                            </span>
                          </td>

                          <td>
                            <span className={`status-pill ${isActive ? 'status-success' : 'status-denied'}`}>
                              {isActive ? 'Active' : 'Disabled'}
                            </span>
                          </td>

                          <td className="text-muted text-sm">
                            {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A'}
                          </td>

                          <td className="text-right">
                            <div className="admin-user-actions-cluster">
                              {/* Change Role Selector */}
                              <div className="role-change-control">
                                <label htmlFor={`role-select-${u._id}`} className="sr-only">
                                  Change Role for {u.email}
                                </label>
                                <select
                                  id={`role-select-${u._id}`}
                                  className="form-select-sm"
                                  value={u.role}
                                  onChange={(e) => handleRoleChange(u._id, e.target.value)}
                                  disabled={updatingRoleId === u._id || !isActive}
                                  title="Change role (user <-> admin)"
                                >
                                  <option value="user">User</option>
                                  <option value="admin">Admin</option>
                                </select>
                              </div>

                              {/* Disable User Action */}
                              {isActive ? (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-danger-outline"
                                  onClick={() => setUserToDisable(u)}
                                  id={`btn-disable-${u._id}`}
                                  title="Disable account and immediately terminate all active sessions"
                                >
                                  Disable
                                </button>
                              ) : (
                                <span className="disabled-account-indicator">Disabled</span>
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

          {/* Modal: Confirm Account Disablement */}
          {userToDisable && (
            <div className="modal-backdrop" onClick={() => setUserToDisable(null)}>
              <div
                className="modal-box modal-box-danger"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-labelledby="disable-modal-title"
              >
                <div className="modal-header">
                  <div className="modal-danger-icon">⚠️</div>
                  <div>
                    <h3 className="modal-title" id="disable-modal-title">
                      Confirm Account Disablement
                    </h3>
                    <p className="modal-subtitle">Immediate session invalidation will occur.</p>
                  </div>
                </div>

                <div className="modal-body">
                  <p>
                    Are you sure you want to disable <strong>{userToDisable.email}</strong>?
                  </p>
                  <div className="danger-notice-box">
                    <strong>Security Enforcement:</strong>
                    <ul>
                      <li>All active sessions and cookies will be immediately terminated.</li>
                      <li>The user will be immediately rejected from any further API or UI requests with 404.</li>
                    </ul>
                  </div>
                </div>

                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setUserToDisable(null)}
                    disabled={disablingUser}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={handleConfirmDisable}
                    disabled={disablingUser}
                    id="btn-confirm-disable"
                  >
                    {disablingUser ? 'Disabling Account...' : 'Yes, Disable Account'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB 2: ACTIVITY FEED (Multi-Criteria Filters & Ledger Stream)
          ===================================================================== */}
      {activeTab === 'activity' && (
        <div className="admin-tab-content" id="panel-activity-feed">
          {activityError && (
            <div className="alert alert-error">
              <span>{activityError}</span>
            </div>
          )}

          {/* Activity Filters Card */}
          <div className="admin-card admin-filter-card">
            <div className="admin-card-header">
              <div className="admin-card-icon">🔍</div>
              <div>
                <h2 className="admin-card-title">Filter Audit Activity Stream</h2>
                <p className="admin-card-subtitle">
                  Query cryptographic log rows by user, document, date range, event type, or outcome.
                </p>
              </div>
            </div>

            <form onSubmit={handleApplyFeedFilters} className="admin-filter-form" id="form-filter-activity">
              <div className="filter-grid-5">
                <div className="form-group">
                  <label className="form-label" htmlFor="feed-filter-user">
                    User (Email / ID)
                  </label>
                  <input
                    type="text"
                    id="feed-filter-user"
                    className="form-input"
                    placeholder="e.g. owner@trustvault.local"
                    value={feedFilterUser}
                    onChange={(e) => setFeedFilterUser(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="feed-filter-doc">
                    Document (Name / ID)
                  </label>
                  <input
                    type="text"
                    id="feed-filter-doc"
                    className="form-input"
                    placeholder="e.g. Financial"
                    value={feedFilterDoc}
                    onChange={(e) => setFeedFilterDoc(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="feed-filter-start">
                    From Date
                  </label>
                  <input
                    type="date"
                    id="feed-filter-start"
                    className="form-input date-input"
                    value={feedFilterStart}
                    onChange={(e) => setFeedFilterStart(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="feed-filter-end">
                    To Date
                  </label>
                  <input
                    type="date"
                    id="feed-filter-end"
                    className="form-input date-input"
                    value={feedFilterEnd}
                    onChange={(e) => setFeedFilterEnd(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="feed-filter-type">
                    Event Type
                  </label>
                  <select
                    id="feed-filter-type"
                    className="form-input form-select"
                    value={feedFilterType}
                    onChange={(e) => setFeedFilterType(e.target.value)}
                  >
                    <option value="">All Event Types</option>
                    <option value="USER_CREATE">USER_CREATE</option>
                    <option value="ROLE_CHANGE">ROLE_CHANGE</option>
                    <option value="USER_DISABLE">USER_DISABLE</option>
                    <option value="PERMISSION_GRANT">PERMISSION_GRANT</option>
                    <option value="PERMISSION_REVOKE">PERMISSION_REVOKE</option>
                    <option value="DOCUMENT_CREATE">DOCUMENT_CREATE</option>
                    <option value="DOCUMENT_READ">DOCUMENT_READ</option>
                    <option value="DOCUMENT_UPDATE">DOCUMENT_UPDATE</option>
                    <option value="DOCUMENT_DELETE">DOCUMENT_DELETE</option>
                    <option value="ACCESS_DENIED">ACCESS_DENIED</option>
                  </select>
                </div>
              </div>

              <div className="filter-actions-row">
                <div className="filter-actions-left">
                  <label className="form-label inline-label" htmlFor="feed-filter-status">
                    Status:
                  </label>
                  <select
                    id="feed-filter-status"
                    className="form-select-sm"
                    value={feedFilterStatus}
                    onChange={(e) => setFeedFilterStatus(e.target.value)}
                  >
                    <option value="">All Statuses</option>
                    <option value="SUCCESS">SUCCESS</option>
                    <option value="DENIED">DENIED</option>
                    <option value="FAILURE">FAILURE</option>
                  </select>
                </div>

                <div className="filter-actions-right">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleResetFeedFilters}
                    id="btn-reset-activity-filters"
                  >
                    Reset Filters
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={loadingActivity}
                    id="btn-apply-activity-filters"
                  >
                    {loadingActivity ? 'Filtering...' : 'Apply Filters'}
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Activity Ledger Table (Metadata Only — No File Contents or Download Links) */}
          <div className="admin-card">
            <div className="admin-table-header-row">
              <div>
                <h2 className="admin-card-title">System-Wide Activity Log</h2>
                <p className="admin-card-subtitle">
                  Strict metadata only. Zero download links or file content viewers are rendered.
                </p>
              </div>
              <div className="user-count-badge">
                {activities.length} Recorded Events
              </div>
            </div>

            {loadingActivity ? (
              <div className="loading-card">
                <div className="spinner"></div>
                <p className="loading-text">Loading audit activity stream...</p>
              </div>
            ) : activities.length === 0 ? (
              <div className="empty-state-card">
                <p className="empty-text">No audit events match the selected filter criteria.</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="vault-table admin-activity-table">
                  <thead>
                    <tr>
                      <th>Seq #</th>
                      <th>Timestamp</th>
                      <th>Event Type</th>
                      <th>Status</th>
                      <th>Action</th>
                      <th>User</th>
                      <th>Document</th>
                      <th>Integrity Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activities.map((act) => {
                      const displayUser = act.userEmail || act.userId || act.metadata?.email || 'System';
                      const displayDoc = act.documentName || act.metadata?.documentName || act.documentId || '—';

                      return (
                        <tr key={act._id || act.sequenceNumber || Math.random()}>
                          <td className="font-mono text-muted">
                            #{act.sequenceNumber !== undefined ? act.sequenceNumber : '—'}
                          </td>

                          <td className="text-muted text-sm whitespace-nowrap">
                            {new Date(act.timestamp || act.createdAt).toLocaleString()}
                          </td>

                          <td>
                            <span className="badge badge-event">{act.eventType}</span>
                          </td>

                          <td>
                            <span className={`status-pill status-${act.status?.toLowerCase()}`}>
                              {act.status}
                            </span>
                          </td>

                          <td className="font-mono text-sm">{act.action}</td>

                          <td className="text-highlight text-sm">
                            <span title={String(displayUser)}>{displayUser}</span>
                          </td>

                          {/* Rule 4: Plain text metadata ONLY. No download link or file preview */}
                          <td className="text-muted text-sm">
                            <span className="doc-metadata-plain" title={String(displayDoc)}>
                              {displayDoc}
                            </span>
                          </td>

                          <td className="font-mono text-muted text-xs text-truncate" title={act.hash}>
                            {act.hash ? `${act.hash.slice(0, 10)}...` : 'N/A'}
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
      )}

      {/* =====================================================================
          TAB 3: PERMISSION-CHANGE HISTORY (Filters by User, Document, Date)
          ===================================================================== */}
      {activeTab === 'permissions' && (
        <div className="admin-tab-content" id="panel-permission-history">
          {permError && (
            <div className="alert alert-error">
              <span>{permError}</span>
            </div>
          )}

          {/* Permission History Filters Card */}
          <div className="admin-card admin-filter-card">
            <div className="admin-card-header">
              <div className="admin-card-icon">🔑</div>
              <div>
                <h2 className="admin-card-title">Filter Permission-Change History</h2>
                <p className="admin-card-subtitle">
                  Inspect access control grants and revocations by user, document, or date.
                </p>
              </div>
            </div>

            <form onSubmit={handleApplyPermFilters} className="admin-filter-form" id="form-filter-permissions">
              <div className="filter-grid-4">
                <div className="form-group">
                  <label className="form-label" htmlFor="perm-filter-user">
                    User (Target or Granter)
                  </label>
                  <input
                    type="text"
                    id="perm-filter-user"
                    className="form-input"
                    placeholder="e.g. viewer@trustvault.local"
                    value={permFilterUser}
                    onChange={(e) => setPermFilterUser(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="perm-filter-doc">
                    Document (Name or ID)
                  </label>
                  <input
                    type="text"
                    id="perm-filter-doc"
                    className="form-input"
                    placeholder="e.g. Confidential Report"
                    value={permFilterDoc}
                    onChange={(e) => setPermFilterDoc(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="perm-filter-start">
                    From Date
                  </label>
                  <input
                    type="date"
                    id="perm-filter-start"
                    className="form-input date-input"
                    value={permFilterStart}
                    onChange={(e) => setPermFilterStart(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="perm-filter-end">
                    To Date
                  </label>
                  <input
                    type="date"
                    id="perm-filter-end"
                    className="form-input date-input"
                    value={permFilterEnd}
                    onChange={(e) => setPermFilterEnd(e.target.value)}
                  />
                </div>
              </div>

              <div className="filter-actions-row filter-actions-right-only">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleResetPermFilters}
                  id="btn-reset-perm-filters"
                >
                  Reset Filters
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={loadingPerms}
                  id="btn-apply-perm-filters"
                >
                  {loadingPerms ? 'Filtering...' : 'Apply Filters'}
                </button>
              </div>
            </form>
          </div>

          {/* Permission History Table (Metadata Only — No Download Links) */}
          <div className="admin-card">
            <div className="admin-table-header-row">
              <div>
                <h2 className="admin-card-title">Permission Modification Log</h2>
                <p className="admin-card-subtitle">
                  Historical record of all PERMISSION_GRANT and PERMISSION_REVOKE events.
                </p>
              </div>
              <div className="user-count-badge">
                {permHistory.length} Permission Events
              </div>
            </div>

            {loadingPerms ? (
              <div className="loading-card">
                <div className="spinner"></div>
                <p className="loading-text">Loading permission history...</p>
              </div>
            ) : permHistory.length === 0 ? (
              <div className="empty-state-card">
                <p className="empty-text">No permission changes match the selected criteria.</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="vault-table admin-permissions-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Event Type</th>
                      <th>Target User</th>
                      <th>Document Name</th>
                      <th>Permission Level</th>
                      <th>Changed By</th>
                      <th>Integrity Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {permHistory.map((p) => {
                      const isGrant = p.eventType === 'PERMISSION_GRANT';
                      const targetUser = p.metadata?.targetEmail || p.metadata?.targetUserId || p.metadata?.email || 'N/A';
                      const docName = p.documentName || p.metadata?.documentName || p.metadata?.name || '—';
                      const level = p.metadata?.level || (isGrant ? 'READ' : 'REVOKED');
                      const actor = p.userEmail || p.userId || 'Owner';

                      return (
                        <tr key={p._id || p.sequenceNumber || Math.random()}>
                          <td className="text-muted text-sm whitespace-nowrap">
                            {new Date(p.timestamp || p.createdAt).toLocaleString()}
                          </td>

                          <td>
                            <span className={`badge ${isGrant ? 'badge-permission-grant' : 'badge-permission-revoke'}`}>
                              {isGrant ? 'GRANT' : 'REVOKE'}
                            </span>
                          </td>

                          <td className="text-highlight text-sm">
                            <span title={String(targetUser)}>{targetUser}</span>
                          </td>

                          {/* Rule 4: Plain text metadata ONLY. No download link or file preview */}
                          <td className="text-muted text-sm">
                            <span className="doc-metadata-plain" title={String(docName)}>
                              {docName}
                            </span>
                          </td>

                          <td>
                            <span className={`badge badge-level-${String(level).toLowerCase()}`}>
                              {String(level).toUpperCase()}
                            </span>
                          </td>

                          <td className="text-muted text-sm font-mono">{actor}</td>

                          <td className="font-mono text-muted text-xs text-truncate" title={p.hash}>
                            {p.hash ? `${p.hash.slice(0, 10)}...` : 'N/A'}
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
      )}
    </div>
  );
}
