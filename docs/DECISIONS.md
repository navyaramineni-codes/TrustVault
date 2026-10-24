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


