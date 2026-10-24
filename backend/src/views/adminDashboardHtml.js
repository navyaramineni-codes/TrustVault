/**
 * Generates the responsive, glassmorphic Single Page Application for the TrustVault Admin Console.
 * Fulfills prompt requirements:
 * 1. Activity feed
 * 2. Permission-change history
 * 3. Filterable by user, document, and date
 * 4. Button that executes verifyChain()
 * 5. Strictly metadata-only (zero file contents, zero download links per Rule 4)
 *
 * @param {Object} currentUser - The authenticated admin user
 * @returns {string} Complete HTML document
 */
function renderAdminDashboardHtml(currentUser) {
  const adminEmail = (currentUser && currentUser.email) ? currentUser.email : 'admin@trustvault.local';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrustVault - Audit & Compliance Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #07090e;
      --bg-surface: #0e131f;
      --bg-card: rgba(18, 24, 38, 0.7);
      --bg-card-hover: rgba(28, 38, 60, 0.85);
      --border-color: rgba(99, 102, 241, 0.18);
      --border-glow: rgba(99, 102, 241, 0.35);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-faint: #64748b;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-light: #818cf8;
      --cyan: #38bdf8;
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.25);
      --crimson: #ef4444;
      --crimson-glow: rgba(239, 68, 68, 0.25);
      --amber: #f59e0b;
      --purple: #a855f7;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-dark);
      background-image:
        radial-gradient(at 10% 10%, rgba(99, 102, 241, 0.08) 0px, transparent 50%),
        radial-gradient(at 90% 90%, rgba(56, 189, 248, 0.06) 0px, transparent 50%);
      color: var(--text-main);
      font-family: var(--font-sans);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    /* Container */
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem 1.5rem 4rem;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 2rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      margin-bottom: 2rem;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #6366f1, #38bdf8);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);
    }

    .logo-icon svg {
      width: 26px;
      height: 26px;
      fill: #ffffff;
    }

    .brand-text h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 0.85rem;
      color: var(--cyan);
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .admin-pill {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-color);
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 0.85rem;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      background: var(--emerald);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--emerald);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }

    /* Security Notice Banner */
    .security-notice {
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.12), rgba(56, 189, 248, 0.08));
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 12px;
      padding: 0.875rem 1.25rem;
      margin-bottom: 2rem;
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.875rem;
      color: #e2e8f0;
    }

    .security-notice svg {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      color: var(--cyan);
    }

    /* Verification Hero Card */
    .verify-hero {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1.75rem;
      margin-bottom: 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.5rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      position: relative;
      overflow: hidden;
    }

    .verify-hero::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--primary), var(--cyan), var(--emerald));
    }

    .verify-info h2 {
      font-size: 1.25rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .verify-info p {
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .verify-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .btn-verify {
      background: linear-gradient(135deg, #4f46e5, #06b6d4);
      color: #ffffff;
      border: none;
      padding: 0.75rem 1.75rem;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      transition: all 0.2s ease;
      box-shadow: 0 4px 20px rgba(79, 70, 229, 0.4);
    }

    .btn-verify:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 25px rgba(79, 70, 229, 0.6);
    }

    .btn-verify:active {
      transform: translateY(0);
    }

    .btn-verify:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .chain-badge {
      padding: 0.45rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      letter-spacing: 0.02em;
    }

    .chain-badge.valid {
      background: var(--emerald-glow);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }

    .chain-badge.invalid {
      background: var(--crimson-glow);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.35);
    }

    .chain-badge.idle {
      background: rgba(148, 163, 184, 0.1);
      color: var(--text-muted);
      border: 1px solid rgba(148, 163, 184, 0.2);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--bg-card);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .stat-label {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #ffffff;
      font-family: var(--font-mono);
    }

    /* Filters Section */
    .filter-card {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }

    .filter-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      align-items: flex-end;
    }

    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .filter-group label {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
    }

    .filter-group input,
    .filter-group select {
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      color: #ffffff;
      padding: 0.65rem 0.875rem;
      font-size: 0.875rem;
      font-family: inherit;
      outline: none;
      transition: all 0.2s ease;
    }

    .filter-group input:focus,
    .filter-group select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .filter-buttons {
      display: flex;
      gap: 0.75rem;
    }

    .btn-filter {
      background: var(--primary);
      color: #ffffff;
      border: none;
      padding: 0.65rem 1.25rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .btn-filter:hover {
      background: var(--primary-hover);
    }

    .btn-reset {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 0.65rem 1rem;
      border-radius: 8px;
      font-weight: 500;
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-reset:hover {
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.25);
    }

    /* Tabs */
    .tabs-nav {
      display: flex;
      gap: 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      margin-bottom: 1.5rem;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.75rem 1.25rem;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      transition: color 0.2s ease;
    }

    .tab-btn.active {
      color: #ffffff;
    }

    .tab-btn.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--primary);
      box-shadow: 0 0 12px var(--primary);
    }

    .tab-badge {
      background: rgba(255, 255, 255, 0.08);
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
    }

    /* Events List / Table */
    .events-container {
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
    }

    .event-card {
      background: var(--bg-card);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1.25rem;
      transition: all 0.2s ease;
    }

    .event-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-glow);
      transform: translateY(-1px);
    }

    .event-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .event-meta-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .seq-number {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--cyan);
      background: rgba(56, 189, 248, 0.1);
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
    }

    .badge-event-type {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.25rem 0.65rem;
      border-radius: 6px;
    }

    .badge-grant {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }

    .badge-revoke {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-denied {
      background: var(--crimson-glow);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .badge-create {
      background: var(--emerald-glow);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge-general {
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.3);
    }

    .badge-status {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
    }

    .status-SUCCESS {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
    }

    .status-DENIED {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
    }

    .event-timestamp {
      font-size: 0.8rem;
      color: var(--text-faint);
    }

    .event-details-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }

    .detail-item strong {
      color: #cbd5e1;
      font-weight: 500;
    }

    .hash-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(10, 15, 26, 0.6);
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-faint);
      overflow-x: auto;
    }

    .hash-val {
      color: #94a3b8;
    }

    .empty-state {
      text-align: center;
      padding: 3.5rem 1.5rem;
      color: var(--text-muted);
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px dashed rgba(255, 255, 255, 0.1);
    }

    .empty-state svg {
      width: 44px;
      height: 44px;
      margin-bottom: 1rem;
      color: var(--text-faint);
    }

    /* Modal / Toast */
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #1e293b;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 1rem 1.5rem;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      gap: 0.75rem;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s ease;
      z-index: 1000;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand-section">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
          </svg>
        </div>
        <div class="brand-text">
          <h1>TrustVault Audit Center</h1>
          <p>Cryptographic Provenance & Compliance Operations</p>
        </div>
      </div>
      <div class="admin-pill">
        <span class="status-dot"></span>
        <span>Administrator: <strong id="admin-user-email">${adminEmail}</strong></span>
      </div>
    </header>

    <!-- Security Guarantee Notice (Rule 4) -->
    <div class="security-notice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <div>
        <strong>Rule 4 Least Privilege Guarantee:</strong> Administrators have zero automatic access to document contents. Under security policy, administrative endpoints display metadata only and never provide download links or file previews.
      </div>
    </div>

    <!-- verifyChain Hero Card -->
    <section class="verify-hero">
      <div class="verify-info">
        <h2>
          <span>Audit Chain Provenance</span>
          <span id="chain-badge" class="chain-badge idle">Ready to Verify</span>
        </h2>
        <p id="chain-meta-text">Cryptographic SHA-256 linear hash chaining guarantees tamper-evidence and prevents fork divergence.</p>
      </div>
      <div class="verify-actions">
        <button id="btn-verify-chain" class="btn-verify">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
          </svg>
          <span id="verify-btn-text">Run verifyChain()</span>
        </button>
      </div>
    </section>

    <!-- Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Chain Height</span>
        <span class="stat-value" id="stat-height">--</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Verified Events</span>
        <span class="stat-value" id="stat-events">--</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Permission Events</span>
        <span class="stat-value" id="stat-permissions">--</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Tamper Status</span>
        <span class="stat-value" id="stat-tamper" style="color: var(--emerald);">VERIFIED</span>
      </div>
    </div>

    <!-- Filters Section -->
    <section class="filter-card">
      <form id="filter-form" class="filter-grid" onsubmit="event.preventDefault(); applyFilters();">
        <div class="filter-group">
          <label for="filter-user">Filter by User</label>
          <input type="text" id="filter-user" placeholder="Email or User ID...">
        </div>
        <div class="filter-group">
          <label for="filter-doc">Filter by Document</label>
          <input type="text" id="filter-doc" placeholder="Document Name or ID...">
        </div>
        <div class="filter-group">
          <label for="filter-from">From Date</label>
          <input type="date" id="filter-from">
        </div>
        <div class="filter-group">
          <label for="filter-to">To Date</label>
          <input type="date" id="filter-to">
        </div>
        <div class="filter-buttons">
          <button type="submit" class="btn-filter" id="btn-apply-filters">Apply Filters</button>
          <button type="button" class="btn-reset" id="btn-reset-filters" onclick="resetFilters()">Reset</button>
        </div>
      </form>
    </section>

    <!-- Navigation Tabs -->
    <nav class="tabs-nav">
      <button class="tab-btn active" id="tab-activity" onclick="switchTab('activity')">
        <span>Activity Feed</span>
        <span class="tab-badge" id="count-activity">0</span>
      </button>
      <button class="tab-btn" id="tab-permissions" onclick="switchTab('permissions')">
        <span>Permission-Change History</span>
        <span class="tab-badge" id="count-permissions">0</span>
      </button>
    </nav>

    <!-- Events Container -->
    <main id="events-list" class="events-container">
      <div class="empty-state">
        <p>Loading audit events...</p>
      </div>
    </main>
  </div>

  <!-- Toast Notification -->
  <div id="toast" class="toast">
    <span id="toast-message">Notification</span>
  </div>

  <script>
    let activeTab = 'activity';
    let activityEvents = [];
    let permissionEvents = [];

    // Initialize application on load
    document.addEventListener('DOMContentLoaded', () => {
      fetchActivity();
      runChainVerification(false); // Initial background verification check
    });

    // verifyChain execution
    document.getElementById('btn-verify-chain').addEventListener('click', () => {
      runChainVerification(true);
    });

    async function runChainVerification(showToastNotification) {
      const btn = document.getElementById('btn-verify-chain');
      const btnText = document.getElementById('verify-btn-text');
      const badge = document.getElementById('chain-badge');
      const metaText = document.getElementById('chain-meta-text');
      const statTamper = document.getElementById('stat-tamper');

      btn.disabled = true;
      btnText.textContent = 'Verifying SHA-256 Chain...';

      try {
        const res = await fetch('/admin/verify-chain', { method: 'POST' });
        if (!res.ok) throw new Error('Verification request failed with status ' + res.status);
        const data = await res.json();

        if (data.isValid) {
          badge.className = 'chain-badge valid';
          badge.textContent = 'Chain Valid - Zero Tampering';
          metaText.textContent = \`Contiguous chain verified: \${data.totalEvents} blocks verified at \${new Date(data.verifiedAt).toLocaleTimeString()}.\`;
          statTamper.textContent = 'VERIFIED';
          statTamper.style.color = 'var(--emerald)';
          if (showToastNotification) showToast(\`Audit chain verified: \${data.totalEvents} blocks intact.\`, 'success');
        } else {
          badge.className = 'chain-badge invalid';
          badge.textContent = 'Chain Broken / Tampered!';
          metaText.textContent = \`Tampering detected at sequence #\${data.brokenSequence}: \${data.error}\`;
          statTamper.textContent = 'TAMPERED';
          statTamper.style.color = 'var(--crimson)';
          if (showToastNotification) showToast(\`Integrity check failed at sequence #\${data.brokenSequence}\`, 'error');
        }

        document.getElementById('stat-height').textContent = data.latestSequenceNumber || data.totalEvents || '0';
        document.getElementById('stat-events').textContent = data.totalEvents || '0';
      } catch (err) {
        badge.className = 'chain-badge invalid';
        badge.textContent = 'Verification Error';
        metaText.textContent = err.message;
        if (showToastNotification) showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btnText.textContent = 'Run verifyChain()';
      }
    }

    async function fetchActivity() {
      const user = document.getElementById('filter-user').value.trim();
      const doc = document.getElementById('filter-doc').value.trim();
      const from = document.getElementById('filter-from').value;
      const to = document.getElementById('filter-to').value;

      const params = new URLSearchParams();
      if (user) params.append('user', user);
      if (doc) params.append('document', doc);
      if (from) params.append('startDate', from);
      if (to) params.append('endDate', to);

      try {
        const [activityRes, permissionsRes] = await Promise.all([
          fetch('/admin/activity?' + params.toString()),
          fetch('/admin/permissions/history?' + params.toString()),
        ]);

        if (activityRes.status === 404 || permissionsRes.status === 404) {
          document.getElementById('events-list').innerHTML = '<div class="empty-state"><p>Access Denied: 404 Not Found</p></div>';
          return;
        }

        const activityData = await activityRes.json();
        const permissionsData = await permissionsRes.json();

        activityEvents = activityData.events || [];
        permissionEvents = permissionsData.events || [];

        document.getElementById('count-activity').textContent = activityEvents.length;
        document.getElementById('count-permissions').textContent = permissionEvents.length;
        document.getElementById('stat-permissions').textContent = permissionEvents.length;

        renderCurrentTab();
      } catch (err) {
        document.getElementById('events-list').innerHTML = \`<div class="empty-state"><p>Error fetching audit stream: \${err.message}</p></div>\`;
      }
    }

    function switchTab(tabName) {
      activeTab = tabName;
      document.getElementById('tab-activity').classList.toggle('active', tabName === 'activity');
      document.getElementById('tab-permissions').classList.toggle('active', tabName === 'permissions');
      renderCurrentTab();
    }

    function renderCurrentTab() {
      const listContainer = document.getElementById('events-list');
      const events = activeTab === 'activity' ? activityEvents : permissionEvents;

      if (!events || events.length === 0) {
        listContainer.innerHTML = \`
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
            </svg>
            <p>No audit records matching criteria.</p>
          </div>
        \`;
        return;
      }

      listContainer.innerHTML = events.map((event) => renderEventCard(event)).join('');
    }

    function renderEventCard(event) {
      let badgeClass = 'badge-general';
      if (event.eventType === 'PERMISSION_GRANT') badgeClass = 'badge-grant';
      else if (event.eventType === 'PERMISSION_REVOKE') badgeClass = 'badge-revoke';
      else if (event.status === 'DENIED' || event.eventType === 'ACCESS_DENIED') badgeClass = 'badge-denied';
      else if (event.eventType === 'DOCUMENT_CREATE') badgeClass = 'badge-create';

      const userDisplay = event.userEmail || event.userId || 'Anonymous / System';
      const docDisplay = event.documentName || event.documentId || 'N/A';
      const formattedDate = new Date(event.timestamp).toLocaleString();

      return \`
        <article class="event-card">
          <div class="event-header">
            <div class="event-meta-left">
              <span class="seq-number">#\${event.sequenceNumber || '--'}</span>
              <span class="badge-event-type \${badgeClass}">\${event.eventType}</span>
              <span class="badge-status status-\${event.status}">\${event.status}</span>
            </div>
            <span class="event-timestamp">\${formattedDate}</span>
          </div>

          <div class="event-details-grid">
            <div class="detail-item"><strong>User:</strong> \${escapeHtml(userDisplay)}</div>
            <div class="detail-item"><strong>Document (Metadata Only):</strong> \${escapeHtml(docDisplay)}</div>
            <div class="detail-item"><strong>Action:</strong> \${escapeHtml(event.action || '--')}</div>
            \${event.metadata && event.metadata.level ? \`<div class="detail-item"><strong>Granted Level:</strong> \${escapeHtml(event.metadata.level)}</div>\` : ''}
            \${event.metadata && event.metadata.targetEmail ? \`<div class="detail-item"><strong>Target User:</strong> \${escapeHtml(event.metadata.targetEmail)}</div>\` : ''}
            \${event.reason ? \`<div class="detail-item" style="color: #f87171;"><strong>Reason:</strong> \${escapeHtml(event.reason)}</div>\` : ''}
          </div>

          <div class="hash-row">
            <span>SHA-256 Digest:</span>
            <span class="hash-val">\${event.hash || 'GENESIS'}</span>
          </div>
        </article>
      \`;
    }

    function applyFilters() {
      fetchActivity();
    }

    function resetFilters() {
      document.getElementById('filter-user').value = '';
      document.getElementById('filter-doc').value = '';
      document.getElementById('filter-from').value = '';
      document.getElementById('filter-to').value = '';
      fetchActivity();
    }

    function showToast(msg, type) {
      const toast = document.getElementById('toast');
      const msgEl = document.getElementById('toast-message');
      msgEl.textContent = msg;
      toast.style.borderColor = type === 'error' ? 'var(--crimson)' : 'var(--emerald)';
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3500);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
}

module.exports = {
  renderAdminDashboardHtml,
};
