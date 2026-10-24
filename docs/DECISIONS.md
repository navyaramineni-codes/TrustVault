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
