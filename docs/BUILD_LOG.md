# TrustVault Build Log

## Build Entry: Foundation - Express Project, Docker Compose MongoDB & /health Route
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Initialized the TrustVault backend workspace using Node.js (v24), Express (v4.21), and Mongoose (v8.9).
- Created a containerized MongoDB service via Docker Compose (`docker-compose.yml`) using MongoDB 7.0 with persistent volume storage, root authentication, and health checks.
- Implemented a dedicated, lightweight `/health` route reporting uptime, timestamp, and database connectivity.
- Configured automated testing with Jest and Supertest, writing unit and security baseline tests.
- Established security defaults: `helmet` security headers, disabled `X-Powered-By` framework banner, payload size restrictions, and centralized sanitized error handlers.
- Recorded architecture decision records in `docs/DECISIONS.md`.

---

### 2. Which Files Were Created
| File | Purpose |
|---|---|
| `package.json` | Project metadata, scripts (`start`, `dev`, `test`), and dependencies (`express`, `mongoose`, `dotenv`, `helmet`, `jest`, `supertest`, `nodemon`). |
| `docker-compose.yml` | Container specification for MongoDB 7.0 with `127.0.0.1` binding, authentication, data persistence, and health checks. |
| `.env.example` | Template documenting environment variables required for running the application. |
| `.env` | Local development environment configuration with database credentials. |
| `.gitignore` | Excludes `node_modules/`, `.env`, coverage reports, and system files from version control. |
| `src/config/db.js` | Database connection module handling connection events, credential-safe logging, and clean disconnects. |
| `src/routes/health.js` | Router providing the `GET /health` endpoint utilizing in-memory Mongoose connection state. |
| `src/app.js` | Express application instance defining middleware stack, route mounting, 404 handler, and error sanitizer. |
| `src/server.js` | Application entry point initiating database connection, starting the HTTP listener, and managing graceful shutdown signals (`SIGINT`, `SIGTERM`). |
| `tests/health.test.js` | Automated test suite verifying 200 OK responses, JSON structure, anti-fingerprinting headers, and 404 fallbacks. |
| `docs/DECISIONS.md` | Architecture Decision Records (ADRs 001–004). |
| `docs/BUILD_LOG.md` | This technical build log. |

---

### 3. Why This Design
- **Separation of Concerns (`app.js` vs `server.js`):** Exporting the configured Express application from `src/app.js` without calling `listen()` allows Supertest in `tests/health.test.js` to execute tests against ephemeral, in-memory servers. This eliminates port-binding collisions (`EADDRINUSE`) during parallel test runs and decouples routing logic from process hosting.
- **Non-blocking Health Probes:** Rather than executing database operations (`db.adminCommand('ping')` or mock queries) during each HTTP health check, `/health` reads `mongoose.connection.readyState`. This in-memory check executes in microseconds with zero database round-trips, preventing orchestrator probes from consuming database connections or worsening downtime under high traffic.
- **Redacted Logging:** Database connection strings often contain passwords or sensitive internal hostnames. `src/config/db.js` specifically extracts and logs only `host`, `port`, and `name` from the active connection object, guaranteeing credentials never leak into console logs or log aggregation services.
- **Defensive Defaults:** Applying `app.disable('x-powered-by')` and `helmet()` before any routes are registered establishes a secure baseline where every endpoint inherits protection from clickjacking, MIME sniffing, and technology profiling.

---

### 4. What Attacks This Design Prevents
1. **Information Exposure via Framework Fingerprinting (CWE-200):**
   - Express sets `X-Powered-By: Express` by default. Attackers scan targets with automated tools (e.g., Shodan, Nmap, Nikto) to discover the underlying stack and find known CVEs. Disabling this header and using Helmet strips technological identifiers from responses.
2. **Information Exposure Through Error Messages (CWE-209):**
   - Default unhandled error handlers in Express print full stack traces, including internal file paths, framework versions, and database query structures. The centralized error handler in `src/app.js` catches all uncaught route errors and returns a generic `{ "error": "Internal Server Error" }`, keeping internals hidden.
3. **Unauthorized Database Access via Network Exposure (CWE-284):**
   - In Docker Compose, specifying `ports: - "27017:27017"` instructs the Docker daemon to bind port 27017 to `0.0.0.0` (all network interfaces), bypassing typical host firewall configurations (such as Linux `ufw`). Specifying `127.0.0.1:27017:27017` guarantees MongoDB is accessible strictly from `localhost`, preventing attackers on the same local network or internet from accessing the database port.
4. **Denial of Service via Health Check Resource Starvation (CWE-400 / CWE-770):**
   - If an orchestration layer (e.g., Kubernetes liveness probe or AWS ALB) sends requests every 5 seconds, an endpoint performing database queries would monopolize connection pool slots. Reading `mongoose.connection.readyState` uses zero database socket I/O, preventing health monitoring from triggering cascading server failure. Additionally, `express.json({ limit: '10kb' })` prevents memory exhaustion attacks from oversized JSON request payloads.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why should an Express application separate `app.js` from `server.js`, and what practical problems does this solve in testing and production?
**Answer:**
In a production Node.js application, separating `app.js` (application configuration) from `server.js` (HTTP server listening and environment bootstrapping) solves three major architectural challenges:
1. **Integration Testing Efficiency:** Automated testing libraries like Supertest accept the Express `app` instance directly (`request(app).get('/...')`). Supertest binds to an ephemeral, temporary port in memory without invoking `server.listen()`. If `app.listen()` is executed upon module import, running tests in parallel triggers `EADDRINUSE` (Address Already in Use) port conflicts.
2. **Lifecycle and Environment Decoupling:** `app.js` remains a pure, testable function that defines middleware, security policies, and routing. `server.js` is responsible for side effects: parsing environment variables (`dotenv`), establishing database connection pools, configuring TLS certificates, and attaching `process.on('SIGTERM')` listeners for graceful teardown.
3. **Execution Context Portability:** Decoupling the app allows it to be exported and hosted within different execution environments without modifying application logic—for instance, wrapping the Express app in a serverless adapter (like AWS Lambda / Serverless Express) or running it inside a Node.js cluster worker pool (`cluster.fork()`).

#### Question 2: In a Docker Compose configuration, what is the critical security difference between `- "27017:27017"` and `- "127.0.0.1:27017:27017"`, particularly on Linux host environments?
**Answer:**
When specifying `- "27017:27017"` in Docker Compose, the Docker daemon binds the container port to `0.0.0.0` (INADDR_ANY), exposing it on all network interfaces of the host, including Ethernet, Wi-Fi, and public IP interfaces.
On Linux operating systems, Docker directly manipulates `iptables` by inserting forwarding rules into the `DOCKER` routing chain. This chain is evaluated *before* common user-configured host firewalls such as `UFW` (Uncomplicated Firewall). As a result:
1. An engineer might believe their host firewall blocks port 27017, but Docker's `iptables` rules bypass UFW and expose the database directly to external networks.
2. If the database lacks strong authentication or uses default credentials, automated internet-wide scanners (such as Shodan or masscan) can identify the open MongoDB port, read sensitive data, or deploy automated database-wiping ransomware.
3. Specifying `- "127.0.0.1:27017:27017"` instructs Docker to bind the host port strictly to the loopback interface. Only processes running on the local host can connect, completely neutralizing remote network discovery and lateral movement attacks.

#### Question 3: How should health checks be designed to distinguish between "liveness" and "readiness", and how can an improperly designed health endpoint cause a cascading failure?
**Answer:**
In modern distributed architectures, health monitoring is split into two distinct probes:
1. **Liveness Probe:** Checks if the Node.js process is alive, running the event loop, and able to respond to HTTP requests. If the liveness probe fails (returns 5xx or times out), the orchestrator (e.g., Kubernetes) restarts the container.
2. **Readiness Probe:** Checks if the application is ready to accept user traffic (e.g., database connection pool initialized, cache warmed). If the readiness probe fails, the orchestrator temporarily removes the container from the load balancer rotation without killing the process.

**Cascading Failure Mechanism:**
If a health check performs synchronous or resource-heavy operations (e.g., executing a query against MongoDB) on a combined liveness/readiness endpoint:
- When the database experiences transient latency or high connection load, health check queries start queuing or timing out.
- The orchestrator detects liveness check timeouts and begins aggressively restarting healthy Node.js containers.
- When new containers boot simultaneously, they attempt to establish fresh connection pools and run startup queries, creating a "thundering herd" effect that overwhelms the already-struggling database.
- This creates an irreversible cascading failure loop where the entire cluster fails even though the application code is functional.

**Solution:**
A resilient `/health` design performs in-memory state inspection (e.g., reading Mongoose's cached `readyState`) rather than active query execution. This guarantees constant-time ($O(1)$) responses that consume no socket or thread pool resources.

---

## Build Entry: Core Data Models - User, Document, Permission, AuditEvent
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Designed and implemented four production-grade Mongoose models matching the security requirements in `RULES.md`:
  - `User`: Identity management with strict email validation, role enumeration (`user`, `admin`), and zero-leakage password hash protection.
  - `Document`: File metadata management with ownership references, search indexes, and decoupled UUID storage filenames.
  - `Permission`: Normalized access control records with unique compound index constraints and restricted permission levels (`read`, `edit`).
  - `AuditEvent`: Append-only, tamper-resistant audit logging model capturing all system state changes and denied access attempts.
- Created `src/models/index.js` as a unified barrel export.
- Implemented comprehensive model constraint and security tests in `tests/models.test.js`, validating required fields, index uniqueness, credential suppression, and audit immutability.
- Recorded architecture decisions ADR 005 through ADR 008 in `docs/DECISIONS.md`.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `src/models/User.js` | Created | User schema with `email`, `passwordHash` (hidden by default via `select: false` and `toJSON`), `role` (`user`, `admin`), and `isActive`. |
| `src/models/Document.js` | Created | Document schema with `title`, `description`, `fileStorageName` (UUID), `originalFileName`, `mimeType`, `sizeBytes`, `ownerId` (ref: `User`), and search indexes. |
| `src/models/Permission.js` | Created | Permission schema with `documentId`, `userId`, `level` (`read`, `edit`), `grantedBy`, compound unique index `{ documentId: 1, userId: 1 }`, and search index `{ userId: 1, level: 1, documentId: 1 }`. |
| `src/models/AuditEvent.js` | Created | AuditEvent schema capturing timestamp, event type, actor, document, action, status (`SUCCESS`, `DENIED`, `FAILURE`), IP, User-Agent, and metadata, protected by immutability hooks. |
| `src/models/index.js` | Created | Barrel export module for all Mongoose models. |
| `src/config/db.js` | Modified | Added top-level `dotenv.config()` and authenticated fallback URI for test environments. |
| `tests/models.test.js` | Created | Automated test suite verifying schema validations, role guards, compound index uniqueness, and audit update prevention. |
| `docs/DECISIONS.md` | Modified | Appended ADRs 005, 006, 007, and 008. |
| `docs/BUILD_LOG.md` | Modified | Appended this build log entry. |

---

### 3. Why This Design
- **Normalized `Permission` Collection vs Embedded Array:** Embedding permissions in `Document` documents (e.g. `document.permissions = []`) causes document growth, BSON memory fragmentation, document write lock contention, and runs into MongoDB's 16MB document size limit for broadly shared files. Storing permissions in a dedicated collection allows independent atomic grants, unique compound indexing `{ documentId: 1, userId: 1 }` to prevent duplicates, and enables index-covered database-level filtering for search queries (`Rule 6`).
- **Enforcing Permission Boundaries at Schema Level:** Rule 5 specifies that viewers can only be granted `read` or `edit`, and can never be granted `delete` or `grant`. Enforcing this via Mongoose schema `enum: ['read', 'edit']` guarantees that even a compromised or buggy route cannot insert unauthorized permission levels into the database.
- **Physical vs Logical Filename Decoupling:** Per Rule 8, uploaded files are stored outside the web root under random UUID filenames (`fileStorageName`). The user-provided filename (`originalFileName`) is preserved strictly as descriptive metadata. This breaks the link between HTTP input and local filesystem paths.
- **Defense-in-Depth Credential Protection:** Password hashes should never appear in application logs or API responses. Combining `select: false` with `toJSON` / `toObject` transform functions ensures that even if a developer forgets to sanitize a query or directly calls `res.json(user)`, the password hash is stripped before serialization.
- **Application-Layer Immutability on `AuditEvent`:** Rule 7 mandates that every state change and denied attempt writes an audit event. Audit logs lose forensic and compliance integrity if records can be altered or erased. By attaching pre-hooks that intercept `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, and instance `save()` on existing records, audit entries are rendered strictly append-only.

---

### 4. What Attacks This Design Prevents
1. **Accidental Credential Exposure / Information Leakage (CWE-200 / CWE-532):**
   - By setting `select: false` on `passwordHash` and stripping it in `toJSON`/`toObject`, normal Mongoose queries (`find`, `findById`) exclude the hash from the projection. If a user document is serialized to JSON or logged, the password hash is excluded, preventing credential harvesting.
2. **Path Traversal & Arbitrary File Overwrites (CWE-22 / CWE-434):**
   - Storing user uploads under their raw uploaded filenames creates path traversal risks (e.g. `../../etc/cron.d/malicious`). Using server-generated UUIDs (`fileStorageName`) stored outside the web root neutralizes filename manipulation attacks entirely.
3. **Privilege Escalation via Permission Injection (CWE-269 / CWE-284):**
   - Enforcing `enum: ['read', 'edit']` on `Permission.level` prevents privilege escalation where an attacker attempts to grant themselves `'admin'` or `'owner'` status via the permission collection. The unique compound index on `{ documentId: 1, userId: 1 }` prevents race condition attacks attempting to register multiple conflicting permission states for the same user.
4. **Audit Log Tampering and Repudiation (CWE-778 / CWE-117):**
   - Attackers who gain unauthorized access frequently attempt to update audit records to change timestamps, erase user IDs, or replace `'DENIED'` statuses with `'SUCCESS'` to hide intrusion attempts. Pre-hook immutability guards reject all update and replacement operations at the model layer.

---

### 5. Technical Interview Questions & Answers

#### Question 1: In MongoDB, what are the architectural and performance trade-offs between embedding permissions as an array within a `Document` schema versus storing them in a separate `Permission` collection?
**Answer:**
1. **Document Size & Memory Fragmentation:** MongoDB documents have a hard 16MB BSON limit. If a document is shared with thousands of users, an embedded array of permission objects can substantially inflate the document size. Furthermore, repeatedly pushing items to an array causes the document to grow beyond its allocated memory slot on disk (Power of 2 / WiredTiger allocation), causing data movement, memory fragmentation, and write amplification. A separate `Permission` collection stores fixed-size rows that never alter the parent document structure.
2. **Concurrency & Lock Contention:** Modifying an embedded array requires updating the parent document. If two users are concurrently granted permissions, or if one user edits the document while another is granted access, write conflicts and update collisions occur. With a normalized `Permission` collection, permission grants write independent records with zero write contention on the `Document` collection.
3. **Database-Level Search Filtering (Rule 6):** When executing search queries where users must only view documents they have rights to, a normalized collection allows an efficient `$lookup` or a two-step indexed query: `Permission.find({ userId, level: { $in: ['read', 'edit'] } }).distinct('documentId')` followed by `Document.find({ _id: { $in: docIds } })`. This query uses compound indexes on both collections with minimal RAM usage.

#### Question 2: Why is Mongoose's `select: false` on sensitive fields like `passwordHash` insufficient on its own for complete data protection, and what complementary patterns are required?
**Answer:**
`select: false` instructs Mongoose to omit the specified field from the default projection when executing queries like `User.findOne()`. However, relying solely on `select: false` creates false confidence because:
1. **Aggregation Pipelines Bypass Schema Projections:** Mongoose schema-level `select: false` only applies to standard Mongoose queries (`find`, `findOne`, `findById`). MongoDB aggregation pipelines (`User.aggregate([...])`) bypass Mongoose schema projections entirely and return the raw MongoDB document, including `passwordHash`.
2. **Explicit Selection Overrides:** If any developer writes `.select('+passwordHash')` for an authentication check and subsequently passes that user instance to a helper function, serializer, or logger, the field remains attached.
3. **Direct Document Cloning:** Using `user.toObject()` or `JSON.stringify(user)` will include the field if it was loaded into memory.

**Complementary Defense-in-Depth:**
- **Schema `toJSON` & `toObject` Transforms:** Explicitly deleting `ret.passwordHash` inside the schema's `transform` function ensures that any serialization (`res.json(user)` or `JSON.stringify(user)`) strips the hash even if it was explicitly selected in memory.
- **DTO (Data Transfer Object) Pattern:** Never return raw database model instances from API controllers; always map results to explicit output transfer objects.

#### Question 3: How can you enforce audit log immutability in MongoDB at the database and application layers, and what are the limitations of Mongoose-level middleware?
**Answer:**
1. **Application Layer (Mongoose Middleware):**
   - Attach pre-hooks for `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, and instance `save()` that throw an error if an update is attempted.
   - Configure schema timestamps with `{ createdAt: true, updatedAt: false }`.
   - *Limitation:* Mongoose middleware only executes when operations pass through Mongoose models. It does not intercept direct MongoDB driver calls (`mongoose.connection.db.collection('auditevents').updateOne(...)`), raw MongoDB shell operations, or direct script executions.
2. **Database Engine Layer (MongoDB RBAC):**
   - In production, configure MongoDB Role-Based Access Control (RBAC). The application's database user should be granted a custom role that possesses only `insert` and `find` actions on the `auditevents` collection, explicitly denying `update` and `remove` actions.
3. **Infrastructure Layer (WORM Storage / Capped Collections / Log Forwarding):**
   - For compliance (e.g., SOC 2, HIPAA), audit events can be streamed in real-time to Write-Once-Read-Many (WORM) storage, or forwarded via an append-only log aggregator (e.g., AWS CloudWatch, Datadog, Elasticsearch with ILM append-only policies) where deletion and modification are physically restricted by access control policies.
