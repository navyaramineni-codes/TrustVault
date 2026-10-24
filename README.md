# TrustVault

> Enterprise-grade secure document vault and authorization platform built with Node.js, Express, React, and MongoDB. Engineered with strict defense-in-depth principles, immutable cryptographic audit logging, universal 404 cloaking, and zero administrative content access.

---

## Table of Contents
1. [How to Run](#how-to-run)
2. [User Roles and Permissions Matrix](#user-roles-and-permissions-matrix)
3. [Security Architecture & Design](#security-architecture--design)
4. [Why Administrators Cannot Read File Contents](#why-administrators-cannot-read-file-contents)
5. [What I Did Not Build and Why](#what-i-did-not-build-and-why)
6. [Testing & Verification](#testing--verification)

---

## How to Run

### Repository Architecture
- **`/backend`**: Express API server, Mongoose schemas, centralized Policy Decision Point (`src/authz.js`), cryptographic audit logger (`src/audit.js`), and 13 automated test suites.
- **`/client`**: React 19 (Vite) Single Page Application, in-memory session and CSRF management, role-based navigation, and generic 404 cloaking.

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **Docker & Docker Compose**: For containerized MongoDB 7.0
- **npm**: v9.0.0 or higher

---

### Step 1: Start the Database Container
Launch MongoDB 7.0 with persistent storage bound strictly to `127.0.0.1:27017`:

```bash
docker-compose up -d
```

Verify that the container is healthy:
```bash
docker-compose ps
```

---

### Step 2: Configure & Start the Backend Server

1. Navigate to the backend directory and configure the environment:
   ```bash
   cd backend
   cp .env.example .env
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Seed the database with default accounts and configure the restricted MongoDB audit user:
   ```bash
   npm run seed
   ```

4. Launch the backend API server:
   ```bash
   npm run dev
   ```
   The backend API initializes at `http://localhost:5000`.

---

### Step 3: Configure & Start the Frontend Client

1. Open a new terminal and navigate to the client directory:
   ```bash
   cd client
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Launch the Vite development server:
   ```bash
   npm run dev
   ```
   The client application initializes at `http://localhost:5173`. The Vite proxy automatically routes all `/api` and `/auth` requests to the Express backend at `http://localhost:5000`, preserving same-origin `HttpOnly` session cookies.

---

### Pre-Configured Seed Accounts

| Email | Password | Role | Description |
|---|---|---|---|
| `admin@trustvault.local` | `AdminVault2026!` | `admin` | System administrator (user provisioning, role management, audit chain verification; zero content access) |
| `owner@trustvault.local` | `OwnerVault2026!` | `user` | Document owner (upload, edit metadata, replace file, soft delete, and delegate permissions) |
| `viewer@trustvault.local` | `ViewerVault2026!` | `user` | Standard user (read/edit access available strictly when explicitly granted by owner) |

---

### Step 4: Run the Test Suites

All automated tests run via Jest from the `backend/` directory:

```bash
cd backend
npm test
```

TrustVault includes 13 test suites with 224 test cases covering authorization matrices, cryptographic audit immutability, path traversal defense, CSRF mitigation, and XSS immunity.

---

## User Roles and Permissions Matrix

TrustVault enforces a strict Policy Decision Point model (`authorize(user, doc, action)` in `backend/src/authz.js`). Access control is evaluated per request directly against MongoDB with zero caching.

| Capability / Route | Anonymous | Standard User (No Grant) | Viewer (Read Grant) | Viewer (Edit Grant) | Document Owner | Administrator (`admin`) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Upload Document** (`POST /documents/upload`) | ❌ 401 | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed | ✅ Allowed (owns uploaded) |
| **Read Metadata** (`GET /documents/:id`) | ❌ 404 | ❌ 404 | ✅ Allowed | ✅ Allowed | ✅ Allowed | ❌ 404 (unless owner) |
| **Download File** (`GET /documents/:id/download`) | ❌ 404 | ❌ 404 | ✅ Allowed | ✅ Allowed | ✅ Allowed | ❌ 404 (unless owner) |
| **Edit Metadata** (`PATCH/PUT /documents/:id`) | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed | ✅ Allowed | ❌ 404 (unless owner) |
| **Replace File** (`POST /documents/:id/replace`) | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed | ✅ Allowed | ❌ 404 (unless owner) |
| **Soft Delete** (`DELETE /documents/:id`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed | ❌ 404 (unless owner) |
| **Grant Permission** (`POST /documents/:id/permissions`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed | ❌ 404 (unless owner) |
| **Revoke Permission** (`DELETE /documents/:id/permissions/:uid`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed | ❌ 404 (unless owner) |
| **Search Documents** (`GET /documents/search`) | ❌ 401 | Own only | Own + Granted | Own + Granted | Own + Granted | Own only (zero leak) |
| **Access Admin Console** (`GET /admin`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed |
| **Create Users** (`POST /admin/users`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed |
| **Change User Roles** (`PATCH /admin/users/:id/role`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed |
| **Disable User** (`POST /admin/users/:id/disable`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed |
| **View Audit Feed** (`GET /admin/activity`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed (Metadata only) |
| **View Permission History** (`GET /admin/permissions/history`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed (Metadata only) |
| **Verify Audit Chain** (`POST /admin/verify-chain`) | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ❌ 404 | ✅ Allowed |

---

## Security Architecture & Design

TrustVault is engineered around five foundational architectural pillars:

### 1. Centralized Policy Decision Point (PDP) & Universal 404 Cloaking
- **Rule 2 Compliance:** Every document access dispatches through `authorize(user, doc, action)` in `backend/src/authz.js`. Document routes never query the database directly.
- **Rule 3 Compliance:** Unauthorized access requests unconditionally return HTTP `404 Not Found` (never `403 Forbidden` on resource endpoints). This cloaks the existence of confidential documents and administrative routes, preventing attackers from mapping or enumerating valid resource IDs.
- **Real-Time Validation (Rule 6):** Permissions are queried directly from MongoDB on every request. Caching is prohibited, guaranteeing that permission revocations take effect immediately on the viewer's next request.

### 2. Tamper-Evident Cryptographic Audit Ledger
- **Cryptographic Chaining:** Each audit event records an auto-incrementing monotonic sequence number (`sequenceNumber`) backed by a unique index, and stores `hash = SHA256(previousHash + canonicalContent)`. Concurrent writes cannot fork or reorder the ledger.
- **Pre-Hook Immutability:** Mongoose middleware blocks all update and delete mutations on the `AuditEvent` collection.
- **Database-Level Least Privilege:** A dedicated MongoDB database user (`trustvault_app`) is provisioned with privileges restricted strictly to `insert` and `find` on `auditevents`. Update and delete operations are rejected at the database engine level.
- **Integrity Verifier:** The `verifyChain()` utility validates the mathematical continuity of sequence numbers, cryptographic pointers, and recalculates payload hashes to detect any database-level tampering.

### 3. Physical Storage & Path Traversal Defense
- **UUID File Storage:** Uploaded files are stored outside the web root (`storage/documents/`) using cryptographically generated random UUIDs. The user's original filename is preserved strictly as descriptive metadata.
- **Content Integrity:** Cryptographic SHA-256 hashes are computed from the incoming stream and verified on upload, download, and file replacement.
- **Magic-Byte Sniffing:** File types are validated using initial file byte headers (`file-type`), defeating spoofed file extensions.

### 4. Web Application Defense-in-Depth
- **Password Hardening:** Argon2id (`@node-rs/argon2`) memory-hard hashing defends against GPU/ASIC cracking.
- **Anti-Enumeration:** Constant-time dummy Argon2 verification equalizes response latency when querying non-existent accounts.
- **Session Security:** Server-side session storage in MongoDB (`connect-mongo`) with `HttpOnly`, `SameSite=Lax`, and `Secure` cookies. Session IDs are regenerated upon authentication (`req.session.regenerate()`) to defeat Session Fixation.
- **Immediate Session Revocation:** Disabling a user immediately purges all active session documents from MongoDB and in-memory stores, terminating existing sessions instantly.
- **Brute-Force Rate Limiting:** `express-rate-limit` restricts `/auth/login` to a strict maximum of 5 attempts per minute per IP, returning HTTP `429 Too Many Requests` on the 6th attempt.
- **CSRF Protection:** Double-Submit Cookie protection via `csrf-csrf` using 32-byte tokens, session binding, and custom header validation (`x-csrf-token`).
- **HTTP Header Hardening:** `helmet` applies Content Security Policy (`default-src 'self'`), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN`. Framework banners (`X-Powered-By`) are explicitly omitted.
- **Zero Client-Side Web Storage:** `localStorage` and `sessionStorage` are completely prohibited; session state is managed purely in memory via React Context.
- **Zero Raw HTML Injection:** Strict plain-text rendering (zero `dangerouslySetInnerHTML`), rendering XSS payloads harmlessly as literal text nodes.

### 5. Zero-Leakage Query-Level Search
- **Database-Level Isolation:** Search filters are executed inside the MongoDB query engine (`$or: [{ owner: user._id }, { _id: { $in: grantedDocIds } }]`).
- **Zero In-Memory Filtering:** Filtering in application code after fetching is strictly forbidden. Both search results and the returned result count strictly reflect authorized documents, preventing count-based side-channel leaks.

---

## Why Administrators Cannot Read File Contents

> **Administrators cannot read or download file contents because TrustVault enforces strict Separation of Duties and the Principle of Least Privilege, guaranteeing that administrative oversight never compromises the confidentiality of proprietary user data even if administrative credentials are breached.**

---

## What I Did Not Build and Why

To maintain strict security boundaries, prevent feature creep, and adhere to sound architectural principles, the following features were intentionally **not** built:

1. **Self-Service Public User Registration:**
   - *Why:* Open registration allows anonymous users to create unvetted accounts, opening the platform to spam, credential stuffing, and multi-tenant resource exhaustion. In enterprise security architectures, user onboarding is strictly an administrative function (`POST /admin/users`).
2. **Administrative File Content Viewers & Download Routes:**
   - *Why:* Rule 4 explicitly specifies that administrators have no automatic access to document contents. Providing download links or content inspection in the admin dashboard violates Separation of Duties and creates an immediate vector for insider data exfiltration.
3. **Client-Side Stateless JWTs in LocalStorage / SessionStorage:**
   - *Why:* Tokens stored in browser `localStorage` or `sessionStorage` are fully vulnerable to theft via Cross-Site Scripting (XSS). Furthermore, stateless JWTs cannot be revoked immediately upon user deactivation or session compromise without complex distributed blacklists. TrustVault uses server-side sessions backed by `HttpOnly` cookies and MongoDB storage.
4. **In-Memory Permission Caching (Redis / Local Cache):**
   - *Why:* Caching access control lists introduces a "time-of-check to time-of-use" (TOCTOU) vulnerability window. Rule 6 mandates querying the database on every request so that an owner's permission revocation takes effect instantly on the viewer's very next request.
5. **Client-Side / In-Memory Search Filtering:**
   - *Why:* Fetching unfiltered documents into Node.js and filtering by permission in JavaScript introduces severe memory exhaustion risks (DoS) and leaks metadata (document counts, existence) in database query logs or timing channels. TrustVault constructs the permission filter directly inside the MongoDB query.
6. **Hard Physical Deletion of Document Records:**
   - *Why:* TrustVault utilizes soft deletes (`deletedAt`). Hard deletion breaks foreign key references and creates dangling pointers in historical audit ledgers. Soft-deleted documents return HTTP 404 for everyone (including owners) on all routes and searches, while preserving immutable audit traceability.
7. **External UI Frameworks (Tailwind / Bootstrap):**
   - *Why:* Avoids external bundle overhead, runtime injection vectors, and dependency bloat. TrustVault uses curated, vanilla CSS custom properties with responsive glassmorphism for complete styling control and zero third-party UI attack surface.

---

## Testing & Verification

The test suite covers 224 automated test cases across 13 test suites with a 100% pass rate:

```bash
cd backend
npm test
```

### Test Suite Map
- `tests/health.test.js`: Health route probes, in-memory status, anti-fingerprinting.
- `tests/models.test.js`: Data validation, passwordHash redaction, compound index uniqueness, audit immutability.
- `tests/auth.test.js`: Argon2id verification, session regeneration, constant-time dummy verification.
- `tests/upload.test.js`: UUID file storage outside web root, SHA-256 integrity, path traversal defense, magic-byte sniffing.
- `tests/documents.test.js`: Document CRUD, soft deletion, 404 cloaking for deleted files, sharing panel permissions.
- `tests/authz.test.js`: Full authorization matrix across all roles and actions (Owner, Viewer, Admin, Anonymous).
- `tests/permissions.test.js`: Permission grants, revoking, immediate database validation without caching.
- `tests/search.test.js`: Anti-leakage tests, query-level permission isolation (3 out of 40 match guarantee), multi-criteria filters.
- `tests/audit.test.js`: SHA-256 hash chaining, sequence monotonicity, `verifyChain()`, restricted MongoDB app user.
- `tests/admin.test.js`: Admin-only routes, user creation, role changes, immediate session destruction upon deactivation.
- `tests/admin-activity.test.js`: Admin console, metadata-only activity feed (no file contents/download links), verifyChain UI.
- `tests/security-controls.test.js`: Helmet headers, login rate limiting (5/min), double-submit CSRF, cross-user isolation, and mandatory `authorize()` route verification.
- `tests/xss-upload.test.js`: Uploading `<img src=x onerror=alert(1)>.pdf`, literal string preservation, and HTML entity escaping.