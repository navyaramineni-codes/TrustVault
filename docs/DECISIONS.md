# TrustVault - Architecture Decision Records (ADR)

## ADR 001: Separation of Express App and HTTP Server Initialization
- **Status:** Accepted
- **Context:** Applications that combine Express middleware/routing definitions with `app.listen()` inside a single entry point create friction for automated testing, containerized runners, and process lifecycle management. Running integration tests against a listening port causes address collision (`EADDRINUSE`) when multiple test suites execute concurrently.
- **Decision:** Split the codebase into `src/app.js` (Express configuration, middleware, route mounting, error handling) and `src/server.js` (environment loading, database connection bootstrapper, `server.listen()`, and graceful shutdown signal handlers).
- **Consequences:** Supertest can directly import `app` to make ephemeral in-memory HTTP requests without spinning up network listeners. Simplifies teardown and enables reliable, isolated testing suites.

---

## ADR 002: Docker Compose MongoDB Localhost Binding & Mandatory Authentication
- **Status:** Accepted
- **Context:** Standard Docker port mappings (`27017:27017`) bind by default to `0.0.0.0`. On developer machines connected to shared Wi-Fi or virtual private networks, this exposes MongoDB to external network scans and unauthorized access.
- **Decision:** Explicitly bind the host port to `127.0.0.1:27017:27017` and configure `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` out-of-the-box in `docker-compose.yml`.
- **Consequences:** Prevents lateral network movement and unauthorized exposure while ensuring that authentication is never treated as an afterthought.

---

## ADR 003: Non-Blocking Health Check via In-Memory ReadyState
- **Status:** Accepted
- **Context:** Orchestration systems (Kubernetes, Docker, load balancers) probe `/health` frequently. If the health check performs active queries (`db.adminCommand('ping')` or `User.findOne()`), a flood of health probes can deplete database connection pools or amplify downtime during database strain.
- **Decision:** Read `mongoose.connection.readyState` directly from memory within `src/routes/health.js` to determine database connectivity status (`connected` vs `disconnected`).
- **Consequences:** The endpoint responds in sub-millisecond time with zero database I/O overhead. It reliably signals readiness without inducing self-inflicted Denial of Service (DoS).

---

## ADR 004: Anti-Fingerprinting and Security Header Baseline
- **Status:** Accepted
- **Context:** Express by default broadcasts `X-Powered-By: Express` in response headers. Default Express error responses also disclose internal call stacks when exceptions occur.
- **Decision:** Disable `x-powered-by` via `app.disable('x-powered-by')`, apply `helmet` for defense-in-depth security headers (such as `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN`), and establish a centralized error handler that suppresses stack traces in production.
- **Consequences:** Mitigates CWE-200 (Information Exposure) and CWE-209 (Information Exposure Through an Error Message), hindering reconnaissance by automated vulnerability scanners.

---

## ADR 005: Normalized Permission Collection with Unique Compound Indexing
- **Status:** Accepted
- **Context:** Managing Access Control Lists (ACLs) can be done either embedded inside `Document` (e.g. `document.permissions = []`) or in a dedicated `Permission` collection. Embedded permissions risk BSON 16MB limits for heavily shared files, trigger concurrent document write conflicts, and make database-level search filtering across user permissions (`Rule 6`) complex and inefficient.
- **Decision:** Implement `Permission` as an independent collection featuring a unique compound index `{ documentId: 1, userId: 1 }`, a secondary index `{ userId: 1, level: 1, documentId: 1 }`, and strict enum levels restricted to `['read', 'edit']`.
- **Consequences:** Guarantees idempotency on permission grants, eliminates write-lock contention on the parent `Document`, strictly enforces Rule 5 (viewers can never be assigned delete or grant rights), and allows lightning-fast indexed queries for permission-filtered search inside MongoDB.

---

## ADR 006: Separation of Physical Storage UUIDs from Logical File Metadata
- **Status:** Accepted
- **Context:** File uploads frequently fall prey to Path Traversal, Null Byte Injections, or file overwrite attacks if original filenames or unsanitized user inputs dictate disk paths.
- **Decision:** The `Document` model stores a cryptographically random UUID in `fileStorageName` (Rule 8: files stored outside web root under UUID) while retaining `originalFileName`, `mimeType`, and `sizeBytes` purely as descriptive metadata. Ownership is strictly bound to `ownerId` (ref: `User`).
- **Consequences:** Physical file storage paths cannot be manipulated or traversed by end-user filenames, and access is fundamentally tied to database authorization rather than predictable static web paths.

---

## ADR 007: Defense-in-Depth Credential Protection in User Model
- **Status:** Accepted
- **Context:** Credential leakage (CWE-200) commonly occurs when developers query a user and return the object directly via `res.json(user)` or pass user objects into logging libraries.
- **Decision:** Configure `passwordHash` with `select: false` at the schema definition level and configure `toJSON` and `toObject` transforms to automatically delete `passwordHash` and `__v`.
- **Consequences:** Mongoose queries (`find`, `findById`) automatically omit `passwordHash` from the query projection unless explicitly overridden via `.select('+passwordHash')`. Accidental direct JSON serialization will never leak the hash.

---

## ADR 008: Schema-Enforced Immutability for AuditEvent Collection
- **Status:** Accepted
- **Context:** Audit logs are high-value targets for malicious actors seeking to cover tracks after unauthorized actions or privilege escalation (CWE-778 / Log Repudiation).
- **Decision:** Enforce append-only semantics directly in the Mongoose `AuditEvent` schema by rejecting updates in pre-hooks (`updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`) and rejecting `save()` calls when `!this.isNew`. Configure schema timestamps to record only `createdAt` (omitting `updatedAt`).
- **Consequences:** Audit records cannot be altered, replaced, or tampered with through the Mongoose model layer once written, ensuring tamper-resistant audit trails.

---

## ADR 009: Argon2id for Password Hashing over Bcrypt / Scrypt
- **Status:** Accepted
- **Context:** Password hashing must defend against modern offline cracking attacks employing specialized hardware (ASICs, FPGAs, and high-density GPU clusters). Standard algorithms like bcrypt are memory-light, making them vulnerable to massive parallel cracking on GPUs.
- **Decision:** Utilize Argon2id (`@node-rs/argon2`), the winner of the Password Hashing Competition (PHC), which combines resistance to GPU cracking (via memory hardness) with resistance to side-channel cache-timing attacks.
- **Consequences:** Provides state-of-the-art password protection. Prebuilt N-API Rust binaries eliminate fragile C++ compilation requirements on non-x86 developer environments (e.g. Windows ARM64).

---

## ADR 010: Stateful Session Storage via HttpOnly, SameSite Cookies & MongoDB Store
- **Status:** Accepted
- **Context:** Deciding between client-side stateless tokens (JWTs stored in browser `localStorage`) versus server-side sessions with signed cookies. `localStorage` is completely vulnerable to credential theft through Cross-Site Scripting (XSS), and stateless JWTs cannot be revoked immediately upon logout or credential compromise.
- **Decision:** Implement server-side session management using `express-session` with sessions stored in MongoDB (`connect-mongo`). The session identifier is transported strictly via `HttpOnly`, `SameSite=Lax`, and `Secure` (in production) cookies.
- **Consequences:** JavaScript execution cannot read the session cookie (`HttpOnly`), thwarting token theft via XSS. `SameSite=Lax` prevents unauthorized cross-origin credential transmission during Cross-Site Request Forgery (CSRF). Sessions can be revoked instantly on the server upon logout.

---

## ADR 011: Session Regeneration on Authentication (Session Fixation Prevention)
- **Status:** Accepted
- **Context:** In Session Fixation attacks (CWE-384), an attacker obtains or sets a valid session ID for a victim before they authenticate. If the application retains the same session ID after successful login, the attacker immediately inherits the authenticated session.
- **Decision:** In `src/routes/auth.js`, execute `req.session.regenerate()` immediately upon successful credential verification before binding user identity attributes (`userId`, `role`, `email`) to the session.
- **Consequences:** The session ID is replaced with a new cryptographically random token upon privilege change, rendering any pre-login session ID useless to an attacker.

---

## ADR 012: Constant-Time Password Verification against Non-Existent Users
- **Status:** Accepted
- **Context:** When handling login requests, if the application returns an error immediately upon failing to find an email in the database, the response returns in $<2\text{ms}$. If the user exists, computing the Argon2 hash comparison takes $\sim50-70\text{ms}$. Attackers measure this timing difference to enumerate valid user email addresses.
- **Decision:** When a queried email is not found, execute a dummy Argon2 verification against a static pre-computed hash before returning a generic `401 Invalid email or password`.
- **Consequences:** Equalizes response latency between existing and non-existing accounts, completely defeating timing-based user enumeration attacks (CWE-208 / CWE-200).

---

## ADR 013: Test-Driven Parametrized Authorization Matrix
- **Status:** Accepted
- **Context:** Document authorization systems often fail at boundary edge-cases (e.g., viewers attempting grant/delete actions, administrators implicitly bypassing ownership constraints, or deactivated users acting on cached sessions). Ad-hoc authorization unit testing frequently misses combinations.
- **Decision:** Author a 35-case parametrized authorization test matrix in `tests/authz.test.js` prior to implementing `src/authz.js`. The matrix covers all permutations of actors (owner, viewer-edit, viewer-read, unrelated user, admin without grant, admin with ownership, unauthenticated anonymous, inactive owner, inactive viewer), documents (standard, admin-owned, missing/null), and actions (`read`, `edit`, `delete`, `grant`, invalid/arbitrary).
- **Consequences:** Establishes an unambiguous, executable policy contract directly derived from `RULES.md` (Rules 2, 3, 4, 5, 7) that prevents privilege escalation regressions across all future refactorings.

---

## ADR 014: 404-Only Denial Policy for Document Authorization (Anti-Enumeration)
- **Status:** Accepted
- **Context:** Returning HTTP 403 Forbidden informs an unauthorized requester that a document exists at that ID/path, confirming the presence of confidential files or internal resource IDs (CWE-200 / Information Disclosure).
- **Decision:** Codify in the authorization matrix that every denied access attempt—regardless of user role, token validity, or action attempted—returns an error with status 404 (Not Found), never 403 (Rule 3).
- **Consequences:** Completely eliminates metadata enumeration and IDOR discovery vectors, ensuring unauthorized users cannot differentiate between a non-existent document and an existing confidential document they lack rights to view.

---

## ADR 015: Centralized Policy Decision Point (PDP) via `authorize()` in `src/authz.js`
- **Status:** Accepted
- **Context:** In multi-tenant document systems, distributing authorization checks across individual Express route handlers leads to logic drift, missed edge cases, and high audit overhead. Rule 2 specifies: *"Every document access goes through authorize(user, doc, action) in src/authz.js. Routes never query the documents collection directly."*
- **Decision:** Implement a centralized asynchronous authorization function `authorize(user, doc, action)` in `src/authz.js` that acts as the sole Policy Decision Point (PDP). All controllers and operations must consult this function before processing document access.
- **Consequences:** Establishes a single, easily auditable choke-point for access control. Guarantees uniform enforcement of ownership checks, viewer privilege ceilings (`delete` and `grant` restricted strictly to owner), and database-level permission lookups.

---

## ADR 016: Unified Denial Pattern with Inline Audit Emission
- **Status:** Accepted
- **Context:** Rule 3 mandates returning 404 (never 403) on unauthorized access, and Rule 7 mandates that every denied attempt writes an audit event via `src/audit.js`. Implementing this in disparate error blocks risks omissions.
- **Decision:** Channel all authorization rejections through an internal `deny(user, doc, action, reason)` function in `src/authz.js`. This function asynchronously emits an `ACCESS_DENIED` audit event with actor, document, action, status `'DENIED'`, and rationale, then immediately throws an `AuthorizationError` with `status: 404` and `statusCode: 404`.
- **Consequences:** Guarantees that no denial path escapes security audit logging, completely eliminates duplicate audit code across controllers, and strictly maintains the 404 status code guarantee.

---

## ADR 017: Two-Tier In-Memory File Type Validation via Magic Bytes & Extension Whitelisting
- **Status:** Accepted
- **Context:** Relying on client-supplied `Content-Type` headers or file extensions alone allows attackers to upload executable binaries (PE, ELF, Mach-O), shell scripts, or polyglots disguised with benign extensions (`.pdf`, `.png`). Writing untrusted files to disk prior to verification creates Time-of-Check to Time-of-Use (TOCTOU) race conditions and disk pollution vectors.
- **Decision:** Buffer file uploads in RAM using `multer.memoryStorage()` subject to a 5MB size limit. Validate files via `file-type` by inspecting binary magic bytes in the memory buffer against an explicit MIME whitelist (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`). Cross-reference the detected MIME type against the file's extension to detect and reject extension spoofing before saving to disk.
- **Consequences:** Eliminates CWE-434 (Unrestricted Upload of File with Dangerous Type). Invalid or spoofed files never touch the filesystem, reducing I/O overhead and preventing malicious payloads from ever reaching disk.

---

## ADR 018: Strict Filename Path Traversal Sanitization with Multer Path Preservation
- **Status:** Accepted
- **Context:** Attackers exploit directory traversal sequences (`../`, `..\`) in multipart filename headers to overwrite arbitrary operating system files (e.g. `/etc/cron.d/`, system startup scripts) or escape designated storage roots (CWE-22). Some multipart parsers strip path prefixes automatically, but relying on implicit behavior without explicit validation leaves systems vulnerable when parsing logic differs across proxies or runtimes.
- **Decision:** Enable `preservePath: true` in Multer configuration to expose raw client-supplied paths. Explicitly validate `req.file.originalname` to reject any occurrence of `..`, `/`, or `\`, logging an `UPLOAD_FAILED` audit event with status `DENIED` and returning HTTP 400.
- **Consequences:** Enforces defense-in-depth protection against Path Traversal and Arbitrary File Overwrite. All traversal attempts are recorded in immutable audit logs for threat monitoring.

---

## ADR 019: Decoupled UUID-Based File Storage Outside Web Root with SHA-256 Cryptographic Fingerprint
- **Status:** Accepted
- **Context:** Storing uploaded files using their original filenames or inside web-accessible document roots (`public/`, `static/`) enables Remote Code Execution (RCE) via direct URL invocation, filename collision overwrites, and metadata leaks. Additionally, lacking cryptographic integrity records allows silent tampering or corruption of stored documents.
- **Decision:** Persist files strictly inside a dedicated directory outside the web root (`storage/documents`), generating a cryptographically random UUID v4 (`crypto.randomUUID()`) as the physical filename with no extension. Calculate and store a SHA-256 cryptographic digest (`crypto.createHash('sha256')`) along with metadata in the `Document` database record.
- **Consequences:** Stored files cannot be directly executed by web servers or reached via static URL routing. Disk overwrites from identical user filenames are mathematically impossible. The SHA-256 fingerprint provides cryptographic non-repudiation and integrity verification.

---

## ADR 020: Document Service Layer Chokepoint & Total Elimination of Direct Route Queries (Rule 2)
- **Status:** Accepted
- **Context:** Rule 2 specifies: *"Every document access goes through authorize(user, doc, action) in src/authz.js. Routes never query the documents collection directly."* Allowing Express route handlers to directly call `Document.find()`, `Document.findById()`, or `Document.deleteOne()` invites authorization check omissions, inconsistent error responses, and duplicated business logic across controllers.
- **Decision:** Encapsulate all Mongoose `Document` queries exclusively within `src/services/documentService.js`. Every document retrieval or modification method (`getDocumentById`, `getDownloadStream`, `updateDocumentMetadata`, `deleteDocument`, `listDocuments`) acts as a mandatory Policy Enforcement Point (PEP) that invokes `authorize(user, doc, action)` in `src/authz.js` before returning data or committing writes. Route handlers in `src/routes/documents.js` interact solely through `documentService`.
- **Consequences:** Architectural guarantee that no document operation can bypass centralized authorization. Centralizes error translation (converting denial exceptions to standardized 404 responses), eliminates code duplication, and enforces strict adherence to Rule 2.

---

## ADR 021: Database-Level Permission-Filtered Search & Listing (Rule 6)
- **Status:** Accepted
- **Context:** Rule 6 mandates: *"Search is permission-filtered inside the database query, never in JS after fetching."* Fetching unconstrained document lists and filtering in application memory causes memory bloat, high database I/O, pagination corruption, and timing leakage risks.
- **Decision:** In `listDocuments(user)`, query the normalized `Permission` collection to resolve all `documentId` records where `userId === user._id`. Construct a compound MongoDB query: `{ $or: [{ ownerId: user._id }, { _id: { $in: grantedDocIds } }] }` sorted by `{ createdAt: -1 }`. Re-verify each document with `authorize(user, doc, 'read')` for defense-in-depth before serialization.
- **Consequences:** Database queries return strictly authorized records via indexed evaluations, conserving network bandwidth and memory. Requesters without explicit ownership or grants (including administrators) receive an empty list without leaking document existence.

---

## ADR 022: Streamed File Download with Strict `Content-Disposition: attachment` & MIME Enforcement
- **Status:** Accepted
- **Context:** Serving uploaded user files using `Content-Disposition: inline` or static web handlers allows browsers to parse active content (e.g. malicious JavaScript embedded in SVG images or HTML disguised as documents), resulting in Same-Origin Cross-Site Scripting (XSS). Furthermore, reading whole files into RAM via `fs.readFile()` before sending exhausts server memory during concurrent downloads of large files.
- **Decision:** Implement document downloads via Node.js read streams (`fs.createReadStream().pipe(res)`), streaming bytes directly from the decoupled `storage/documents/<uuid>` disk path. Explicitly set `Content-Disposition: attachment; filename="<originalFileName>"` and specify the stored `Content-Type: <mimeType>`.
- **Consequences:** Forces user agents to treat the payload as a downloaded attachment rather than executing or rendering it in the application's DOM context, eliminating Same-Origin XSS. Streaming provides an $O(1)$ memory footprint regardless of file size, and emits a `DOCUMENT_DOWNLOAD` audit event upon successful access.

---

## ADR 023: Cascading Deletion of Physical Storage & Associated Permissions
- **Status:** Accepted
- **Context:** Deleting a document record in MongoDB without removing its physical disk counterpart leaves orphaned files, creating storage bloat and potential forensic leaks. Leaving lingering `Permission` records risks accidental privilege resurrection if ObjectIds collide or corrupts ACL statistics.
- **Decision:** In `deleteDocument()`, enforce that only the document owner can delete the file (`authorize(user, doc, 'delete')`). Upon authorization, synchronously coordinate the deletion of the physical file in `storage/documents/<uuid>` via `fs.promises.unlink`, purge all permission records via `Permission.deleteMany({ documentId: doc._id })`, and remove the document via `Document.deleteOne({ _id: doc._id })`.
- **Consequences:** Guarantees complete and clean teardown of both physical disk assets and database access control entries, preventing orphaned storage leaks. Logs an immutable `DOCUMENT_DELETE` audit event.

---

## ADR 024: Soft Deletion via Tombstone (`deletedAt`) with Audit Trail Preservation and Universal 404 Access Denial
- **Status:** Accepted (Supersedes ADR 023 for document deletion semantics)
- **Context:** Hard-deleting document records via `Document.deleteOne()` destroys database referential integrity for historical `AuditEvent` records, causing `.populate('documentId')` queries to return `null`. Regulatory compliance and enterprise forensic standards mandate that audit trails retain referenceable document metadata, while simultaneously ensuring that deleted assets become completely inaccessible to all actors.
- **Decision:** Replace hard document deletion with soft deletion by setting `doc.deletedAt = new Date()`. Centralize access rejection in `src/authz.js`: any document with `deletedAt !== null` immediately evaluates to `deny(user, doc, action, 'Document has been deleted')`, returning HTTP 404 (never 403 per Rule 3) for everyone—including the document's owner, viewers, and administrators—across all routes (`GET /:id/download`, `PATCH /:id`, `PUT /:id`, `DELETE /:id`). In database queries (`listDocuments` and `searchDocuments`), enforce `{ deletedAt: null }` at the MongoDB query layer per Rule 6. Retain the underlying MongoDB document record so audit logs can continue referencing `documentId`.
- **Consequences:** Audit logs maintain unbroken referential integrity and can query or populate `documentId` at any time. Deleted documents are completely invisible in list and search, and any attempted route access returns 404, preventing resource existence enumeration while maintaining compliance auditability.

---

## ADR 025: Admin User Management Routes, Non-Admin 404 Cloaking Gate, and Immediate Multi-Session Invalidation
- **Status:** Accepted
- **Context:** Managing user lifecycles (creation, role promotion/demotion, account deactivation) requires strict access control. Exposing admin endpoints or returning HTTP 403 Forbidden to non-admin or unauthenticated callers creates an enumeration oracle (CWE-200), signaling the existence of administrative surfaces. Furthermore, simply setting `user.isActive = false` in the database without destroying in-flight sessions leaves an active vulnerability window where disabled users can continue accessing cached sessions until expiry.
- **Decision:** Implement dedicated admin routes mounted at `/admin/users` and `/api/admin/users`. Enforce a strict authorization middleware `requireAdmin`: any request from an unauthenticated user, a non-admin user (`role: 'user'`), or a deactivated user unconditionally returns HTTP 404 `Not Found` (never 403 or 401 per Rule 3), making administrative endpoints invisible. When an admin disables a user (`POST /admin/users/:id/disable`), synchronously set `user.isActive = false` and execute `endUserSessions()`, which immediately destroys all active sessions matching `userId` across the Express session store and MongoDB `sessions` collection.
- **Consequences:** Complete cloaking of administrative routes against non-administrators, preventing privilege enumeration and reconnaissance. Immediate, zero-window session revocation upon account suspension, ensuring revoked accounts cannot perform any subsequent authenticated actions.

---

## ADR 026: Granular Document Permission Granting and Revocation, Owner Exclusivity, and Zero-Cache Direct Database Evaluation
- **Status:** Accepted
- **Context:** Secure document sharing requires fine-grained access delegation (`read` vs `edit`). Typical ACL implementations introduce security vulnerabilities when:
  1. Permissions are cached in application memory, user sessions, or JWTs, creating a stale authorization window where revoked users can continue accessing documents until cache expiration.
  2. Non-owners (such as viewers or administrators) are able to grant or revoke document permissions, violating data ownership boundaries.
  3. Requesters with granted permissions escalate privileges to unassigned actions (e.g., read grants attempting metadata edits, or edit grants attempting document deletion or permission granting).
  4. Denied permission attempts return HTTP 403 Forbidden, leaking the existence of documents and access control lists.
- **Decision:** Implement `grantPermission()` and `revokePermission()` inside `src/services/documentService.js`, exposed via RESTful endpoints `/documents/:id/permissions` and `/documents/:id/permissions/:userId` (with `/grant` and `/revoke` aliases):
  1. **Owner Exclusivity:** Permission management is strictly restricted to document owners via `authorize(user, doc, 'grant')`. Attempts by non-owners (viewers, admins without ownership, unrelated users) fail-closed with HTTP 404 (never 403 per Rule 3 & 4).
  2. **Zero-Cache Dynamic Database Evaluation:** In `src/authz.js`, permission lookups execute directly against MongoDB via `Permission.findOne({ documentId: doc._id, userId: user._id })` on every single request with zero in-memory caching. Revocation via `Permission.deleteOne()` takes effect immediately: the viewer's very next request finds no database record and returns HTTP 404.
  3. **Strict Privilege Ceilings:** Permission levels are strictly constrained to `['read', 'edit']`. A user with a `read` grant is rejected with 404 on `edit` (`PATCH /documents/:id`), `delete`, and `grant`. A user with an `edit` grant can update document metadata (`PATCH /documents/:id`), but is strictly blocked with 404 on `delete` and `grant`.
  4. **Audit Trail Compliance:** Every grant and revoke operation emits an immutable audit event (`PERMISSION_GRANT` and `PERMISSION_REVOKE`) with status `SUCCESS`, and denied attempts emit `ACCESS_DENIED`.
- **Consequences:** Eliminates stale authorization windows entirely; enforces the principle of least privilege across all permission levels; guarantees that non-owners cannot manipulate access control lists; and maintains universal 404 error cloaking against enumeration attacks.

---

## ADR 027: Cryptographically Chained Audit Trail, Concurrency Fork Resistance, and Database-Level Least-Privilege App User
- **Status:** Accepted
- **Context:** Audit log integrity is essential for regulatory compliance, threat forensics, and non-repudiation. Conventional database-backed logging architectures suffer from three critical security vulnerabilities:
  1. **Silent Log Tampering & Repudiation (CWE-778 / CWE-353):** If an adversary gains database access, they can modify historical log entries (e.g., changing status from `'DENIED'` to `'SUCCESS'` or clearing timestamps) without detection.
  2. **Concurrency Race Conditions and Chain Forking:** Under concurrent request spikes, multiple worker threads attempting to log events simultaneously can read the same previous record and branch the sequence, causing divergent or orphaned chains.
  3. **Over-Privileged Database Connections (CWE-250):** If application code connects to MongoDB with general read/write permissions, an application-level vulnerability (e.g. NoSQL injection or malicious dependency) allows an attacker to execute `deleteMany()` or `updateOne()` on audit collections.
- **Decision:** Implement a cryptographically chained audit subsystem in `src/audit.js` and `src/models/AuditEvent.js`:
  1. **Linear Cryptographic Chain:** Each audit event records an integer `sequenceNumber`, a `previousHash` (pointing to the prior event's hash, with genesis initialized to 64 zeros), and a computed `hash = SHA256(previousHash + ":" + canonicalContent)`. Canonical content deterministically normalizes timestamps, ObjectIds, and recursively sorted metadata keys.
  2. **Unique Index Fork Prevention with Concurrency Retry:** Enforce a strict unique index `{ sequenceNumber: 1 }` on `auditevents`. When concurrent writes compete for sequence $N+1$, one succeeds and all other writes fail with duplicate key error `E11000`. The failed writes enter a jittered backoff retry loop, fetch the newly committed head of the chain, and link as $N+2$, making forks mathematically and physically impossible.
  3. **Verification Engine (`verifyChain()`):** Implemented an automated verification function that scans the linear chain from sequence 1 to $N$, validating strict sequence continuity, previousHash pointer fidelity, and recomputing hashes against content. Any row alteration or deletion is flagged immediately.
  4. **Database-Level Least Privilege App User:** Create a dedicated MongoDB user (`audit_app_user`) bound to a custom role (`auditInsertFindOnly`) restricted strictly to `['insert', 'find']` on the `auditevents` collection. At the MongoDB database engine level, any `update` or `delete` command is blocked with `CommandNotAuthorized`.
  5. **Comprehensive Event Coverage:** Systematically log all domain events: upload, download, metadata edit, file replacement (capturing both `oldSha256` and `newSha256`), delete, permission grant, permission revoke, user creation, role change, user disable, and every denied access attempt.
- **Consequences:** Complete non-repudiation and tamper-evidence for historical audit trails; zero probability of concurrent chain forks; and database-level defense-in-depth preventing update and delete operations even if application code is compromised.

---

## ADR 028: Multi-Criteria Document Search with In-Database Permission Filtering and Anti-Leakage Result Count Guarantees
- **Status:** Accepted
- **Context:** Enterprise document search interfaces frequently introduce subtle data and metadata leakage vectors:
  1. **Post-Query In-Memory Filtering (Rule 6 Violation):** Naive implementations fetch all documents matching search terms (e.g. `Document.find({ name: /term/ })`) into Node.js application memory and subsequently filter out records the requesting user lacks permission to view (`docs.filter(d => canAccess(user, d))`). This creates severe security and performance hazards:
     - Memory bloat and DoS under high volumes of unshared records.
     - Side-channel timing differences between queries matching thousands of ungranted documents versus queries matching few.
     - Massive vulnerability to unauthorized data residency in memory dumps or APM traces.
  2. **Information Leakage via Total Match Counters (Metadata Enumeration):** Many search APIs return both paginated results and an overall match count (e.g., `{ count: 3, totalMatchesInDatabase: 40 }`). Returning an unfiltered total match count discloses the existence and volume of confidential documents to unauthorized viewers, even when individual document bodies are hidden.
  3. **Multi-Criteria Search Fragmentation:** End users require filtering across document attributes: `name` (filename/title), `owner` (email or User ID), `category`, `date range` (`startDate`/`endDate`, `from`/`to`), and general query terms.
- **Decision:** Implement multi-criteria document search directly inside MongoDB via `documentService.searchDocuments()` and `documentService.listDocuments()` fulfilling Rule 6 ("Search is permission-filtered inside the database query, never in JS after fetching"):
  1. **Permission Clause Ingestion in DB Query:** Before executing any document search query, fetch the user's active permissions (`Permission.find({ userId: user._id }).select('documentId').lean()`). Merge the permission filter into a single top-level `$and` array passed directly to `Document.find()`:
     ```javascript
     const conditions = [
       { deletedAt: null },
       {
         $or: [
           { owner: user._id },
           { ownerId: user._id },
           { _id: { $in: grantedDocIds } }
         ]
       }
     ];
     ```
  2. **Multi-Criteria Query Composition:**
     - **Name / Title:** Case-insensitive escaped regex applied across `name`, `title`, and `originalFileName`.
     - **Owner:** If provided as an email address, resolve to `User._id` (or a non-matching dummy ObjectId if user is non-existent); if an ObjectId, match on `owner` or `ownerId`.
     - **Category:** Case-insensitive exact category matching.
     - **Date Range:** Evaluate `createdAt` using `$gte` (from `startDate` / `from` / `createdAfter`) and `$lte` (from `endDate` / `to` / `createdBefore`).
     - **General Query:** Substring matching across title, name, description, category, tags, and original filename.
  3. **Strict Result Count Anti-Leakage:** Both `results` and the returned `count` (`count`, `total`, `resultCount`) strictly reflect the count of documents returned by the permission-filtered database query (`documents.length`). Unshared documents are never fetched, counted, or visible in any response attribute.
- **Consequences:** Search queries are completely immune to metadata leakage; unshared documents cannot be enumerated; performance scales with indexed MongoDB operations; and soft-deleted documents remain strictly invisible.

---

## ADR 029: Dedicated Administration Console, Metadata-Only Audit Activity Stream, and Cryptographic Chain Verification Gate
- **Status:** Accepted
- **Context:** Enterprise security platforms must provide administrators with visibility into system state, user activity, and authorization events. However, naive admin dashboards often introduce severe security vulnerabilities:
  1. **Violation of Least Privilege & Content Disclosure (Rule 4 Violation):** Granting administrators full read access to document contents or providing document download links breaches data segregation. In TrustVault, Rule 4 states: *"Admin has no automatic access to document contents."* An admin dashboard must provide compliance oversight while strictly preventing access to confidential document payloads.
  2. **Administrative Surface Enumeration (Rule 3 Violation):** Returning HTTP 401 or 403 when non-admin users navigate to `/admin` leaks the existence of administrative interfaces and invites targeted brute-force or privilege escalation attacks.
  3. **Audit Trail Verifiability:** Administrators need the ability to verify that audit logs have not been tampered with or altered in database storage.
- **Decision:** Implement a dedicated Administration Console and supporting backend services:
  1. **Strict 404 Cloaking Gate:** All administrative dashboard routes (`/admin`, `/admin/activity`, `/admin/permissions/history`, `/admin/verify-chain`) enforce `requireAdmin`. Unauthenticated requests or requests from non-admin users unconditionally return HTTP 404 `Not Found` (never 403 or 401 per Rule 3), keeping administrative endpoints completely invisible to unauthorized users.
  2. **Zero Content Access & Metadata-Only Stream:** The activity feed endpoint and permission history endpoint return only operational metadata (`eventType`, `action`, `status`, `userId`, `userEmail`, `documentId`, `documentName`, `documentCategory`, `timestamp`, `hash`, `previousHash`, and sanitized `metadata`). Fields referencing physical file locations (`storagePath`, `fileStorageName`, `filePath`) or binary content (`fileBuffer`, `content`) are stripped. The administrative web page contains zero document download links or file content viewers.
  3. **Interactive Cryptographic Verification via `verifyChain()`:** The admin dashboard exposes `POST /admin/verify-chain` which executes `verifyChain()`. The interface provides real-time verification of the SHA-256 hash chain, reporting block height, verification status, and detecting any database-level row alterations or sequence gaps.
  4. **Multi-Criteria Feed Filtering:** Administrators can filter the activity feed and permission-change history across `user` (email or ObjectId), `document` (name keyword or ObjectId), `date` / date ranges (`from`/`to`), and event categories (`PERMISSION_GRANT`, `PERMISSION_REVOKE`, `ACCESS_DENIED`, etc.).
- **Consequences:** Provides administrators with comprehensive audit and compliance oversight; strictly enforces Rule 4 by preventing document content leakage; protects the administrative surface behind a universal 404 cloaking gate; and enables on-demand cryptographic verification of audit trail integrity.

---

## ADR 030: Comprehensive Security Controls — Helmet Baseline, Login Rate Limiting, Double-Submit CSRF Protection, Cross-User Isolation, and Mandatory authorize() Route Verification
- **Status:** Accepted
- **Context:** Enterprise document management systems face multi-vector threats:
  1. **Transport & Header Vulnerabilities:** Web clients are vulnerable to MIME-sniffing, clickjacking via iframes, and cross-site scripting without hardened HTTP headers. Exposing server fingerprints (`X-Powered-By`) assists adversary scanning.
  2. **Credential Brute-Force & Credential Stuffing:** The `/auth/login` endpoint is the gateway for identity verification. Without rate limiting, automated bots can execute credential stuffing and password guessing at line speed.
  3. **Cross-Site Request Forgery (CSRF):** Since session cookies (`trustvault.sid`) are automatically attached by browsers to cross-site requests, an attacker tricking an authenticated user into visiting a malicious site could forge document uploads, edits, permissions grants, or deletions.
  4. **Cross-User Insecure Direct Object References (IDOR):** In multi-tenant environments, malicious or compromised users (User B) attempt to guess or extract document IDs belonging to other users (User A) to inspect, download, overwrite, or delete confidential files.
  5. **Authorization Bypasses via Direct Collection Queries:** If routes or controllers bypass the centralized policy decision point (`authorize(user, doc, action)`) by directly querying Mongoose models, subtle bugs can inadvertently expose documents to unprivileged users.
- **Decision:**
  1. **Helmet Defense-in-Depth Baseline:** Apply `helmet()` in `src/app.js` configured with `Content-Security-Policy` (`defaultSrc: ["'self'"]`, `scriptSrc: ["'self'", "'unsafe-inline'"]`, `styleSrc: ["'self'", "'unsafe-inline'"]`), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN`. Strictly maintain `app.disable('x-powered-by')`.
  2. **Login Rate Limiter (5 Attempts per Minute):** Implement `express-rate-limit` targeting `/auth/login` and `/api/auth/login` with `windowMs: 60 * 1000` (1 minute), `max: 5`, returning HTTP 429 `Too Many Requests` on the 6th attempt with a standardized JSON error message. Configure `validate: false` to avoid false IPv6 validation errors.
  3. **Double-Submit CSRF Protection via `csrf-csrf`:** Configure `doubleCsrf` in `src/config/csrf.js` using a secure 32-byte token, cookie name `trustvault.x-csrf-token`, lax same-site policy, and token extraction via `x-csrf-token` header. Expose `GET /auth/csrf-token` for frontend client consumption. Intercept invalid tokens with HTTP 403 `Forbidden`. Skip enforcement in test environments unless explicitly requested via `x-test-csrf: true`.
  4. **Strict Cross-User Isolation & Invariance:** Verify through automated tests that User B cannot read, download, edit (PATCH/PUT), or delete User A's document. Every unauthorized attempt returns HTTP 404 (Rule 3), leaves database state completely untouched, and writes an `ACCESS_DENIED` audit event (Rule 7).
  5. **Mandatory Policy Decision Point Verification:** Implement automated tests verifying that all document routes dispatch through `authz.authorize(user, doc, action)` in `src/authz.js` and that no document route queries the `Document` collection directly.
- **Consequences:** Provides an enterprise-grade defense-in-depth security perimeter. Thwarts credential stuffing, CSRF, clickjacking, MIME sniffing, and IDOR while enforcing strict policy decision point compliance on all document operations.










