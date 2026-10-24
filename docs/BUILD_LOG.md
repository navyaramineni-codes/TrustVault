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

---

## Build Entry: Authentication (Argon2), Secure Sessions (HttpOnly/SameSite), and Seed Script
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Implemented full login, logout, and session verification endpoints using Argon2id password hashing and stateful sessions.
- Configured `express-session` with `connect-mongo` storing session state in MongoDB and issuing cryptographically signed cookies with `HttpOnly`, `SameSite=Lax`, and `Secure` attributes.
- Implemented `src/audit.js` satisfying Rule 7 ("Every state change and every denied attempt writes an audit event via src/audit.js"), logging `USER_LOGIN` (SUCCESS), `AUTH_FAILED` (DENIED), and `USER_LOGOUT` (SUCCESS).
- Built database seed script (`scripts/seed.js` / `npm run seed`) that idempotently seeds three baseline security roles: an Administrator (`admin@trustvault.local`), a Document Owner (`owner@trustvault.local`), and a Document Viewer (`viewer@trustvault.local`).
- Added timing attack mitigation using a static dummy Argon2 verification when a non-existent email is queried.
- Added session fixation prevention via `req.session.regenerate()` upon successful authentication.
- Implemented automated integration tests in `tests/auth.test.js` covering login success/failure, cookie attributes, session persistence, logout cleanup, and audit logging (8 tests, 25 total project tests passing).
- Recorded architecture decisions ADR 009 through ADR 012 in `docs/DECISIONS.md`.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `src/routes/auth.js` | Created | Authentication router handling `POST /login`, `POST /logout`, and `GET /me` (with timing attack defense and session regeneration). |
| `src/audit.js` | Created | Audit service providing `logAuditEvent()` to record state changes and denied attempts per Rule 7. |
| `scripts/seed.js` | Created | Database seeder provisioning admin, owner, and viewer accounts with Argon2-hashed passwords and audit tracking. |
| `src/app.js` | Modified | Configured `express-session` with `HttpOnly`/`SameSite` cookies and mounted auth routes at `/auth` and `/api/auth`. |
| `package.json` | Modified | Added `@node-rs/argon2`, `express-session`, `connect-mongo`, and `"seed"` run script. |
| `.env.example` & `.env` | Modified | Documented `SESSION_SECRET` and optional seed password environment variables. |
| `tests/auth.test.js` | Created | Automated test suite validating Argon2 login, session cookie attributes, session fixation prevention, and audit event logging. |
| `docs/DECISIONS.md` | Modified | Appended ADRs 009, 010, 011, and 012. |
| `docs/BUILD_LOG.md` | Modified | Appended this build log entry. |

---

### 3. Why This Design
- **Argon2id over Bcrypt/Scrypt:** Argon2id is the winner of the Password Hashing Competition (PHC). It provides superior memory hardness, rendering mass-parallelized GPU/ASIC dictionary attacks economically unviable, while simultaneously protecting against side-channel cache-timing attacks.
- **Stateful Sessions in HttpOnly Cookies vs Client-Side JWTs:** Storing authentication tokens in browser `localStorage` leaves tokens vulnerable to instantaneous exfiltration if any XSS vulnerability exists anywhere in the web app. Server-side session management with `HttpOnly` cookies completely isolates session tokens from JavaScript access. Furthermore, stateful sessions allow instantaneous server-side revocation on logout, password reset, or account suspension—a capability stateless JWTs lack without complex distributed blocklists.
- **Session Regeneration on Privilege Escalation:** When a user transitions from an anonymous state to an authenticated state, retaining the pre-authentication session ID creates a severe Session Fixation vulnerability. Invoking `req.session.regenerate()` ensures a completely new session identifier is minted.
- **Constant-Time Evaluation on Failed Logins:** If an application immediately returns `401 User Not Found` when a database lookup fails, the request finishes in $<2\text{ms}$. If the user exists and Argon2 runs, it takes $\sim50-70\text{ms}$. Attackers measure this delta to enumerate registered users. Running a dummy Argon2 verification against non-existent users equalizes response latency.
- **Centralized Audit Logging (`src/audit.js`):** Encapsulates audit recording behind a clean utility function ensuring consistent schema mapping, metadata isolation, and graceful error handling that prevents audit failures from breaking core user flows.

---

### 4. What Attacks This Design Prevents
1. **Cross-Site Scripting (XSS) Session Hijacking (CWE-79 / CWE-522):**
   - The session cookie is flagged with `HttpOnly: true`. Even if an attacker executes arbitrary JavaScript in the victim's browser context, `document.cookie` cannot read the session ID, neutralizing automated session token theft.
2. **Cross-Site Request Forgery (CSRF) (CWE-352):**
   - The session cookie is configured with `SameSite: 'lax'`. Browsers will not attach the cookie to cross-origin subresource requests (e.g., cross-site `<img>` or `fetch` POST requests), preventing unauthorized state-changing actions initiated by external malicious sites.
3. **Session Fixation Attacks (CWE-384):**
   - Calling `req.session.regenerate()` replaces the session ID immediately upon successful login. An attacker who forces or observes a pre-login session ID cannot use that ID to access the user's authenticated session.
4. **User Enumeration via Timing Analysis (CWE-208 / CWE-200):**
   - By running a dummy Argon2 hash verification when an email does not exist and returning an identical generic error message (`"Invalid email or password"`), timing discrepancies and response variations are eliminated, preventing attackers from discovering registered email addresses.
5. **GPU/ASIC Offline Password Cracking (CWE-916):**
   - Argon2id demands significant RAM allocation ($\sim19\text{MB}$ per hash) and multi-pass CPU computation, preventing attackers who obtain a database dump from using high-density GPU cracking rigs (e.g., Hashcat) to crack passwords at scale.

---

### 5. Technical Interview Questions & Answers

#### Question 1: How does Argon2id differ from bcrypt, and why are memory-hard password hashing functions crucial against modern offline cracking attacks?
**Answer:**
Bcrypt was introduced in 1999 and relies on Blowfish key scheduling. While computationally intensive, bcrypt has a fixed, small memory footprint (only 4 KB of RAM).
1. **The GPU/ASIC Threat:** Modern password cracking attacks do not run on standard CPUs; they run on massive clusters of GPUs or custom FPGA/ASIC chips. Because bcrypt requires only 4 KB of memory, thousands of parallel cracking cores can be embedded on a single GPU die without running into memory bandwidth or cache limitations, enabling billions of guesses per second.
2. **Argon2's Memory Hardness:** Argon2 was designed specifically to defeat GPU/ASIC parallelism by being "memory-hard." It requires a configurable amount of physical RAM (e.g. 19 MB to 64 MB) for *each* hashing operation. Because GPUs have limited fast memory per core, allocating tens of megabytes per thread forces memory thrashing and memory bus saturation, effectively crippling GPU cracking efficiency.
3. **Argon2id Hybrid Defense:** Argon2 exists in three variants:
   - **Argon2d:** Data-dependent memory access. Highest resistance against GPU cracking, but vulnerable to side-channel cache-timing attacks.
   - **Argon2i:** Data-independent memory access. Immune to side-channel timing attacks, but slightly less resistant to GPU memory trade-offs.
   - **Argon2id:** A hybrid that begins with data-independent passes to prevent side-channel leaks, followed by data-dependent passes to maximize resistance against GPU cracking. This makes Argon2id the gold standard for password hashing.

#### Question 2: Why are HttpOnly, SameSite cookies combined with server-side sessions structurally more secure than storing JSON Web Tokens (JWTs) in browser `localStorage`?
**Answer:**
Storing authentication credentials in browser `localStorage` or `sessionStorage` introduces critical architectural vulnerabilities:
1. **No Access Restrictions (XSS Exposure):** Any JavaScript executing within the browser origin—including code injected via DOM-based XSS, compromised third-party npm packages, or malicious browser extensions—can access `window.localStorage` and exfiltrate all stored JWTs to an attacker-controlled server in a single line of code.
2. **Inability to Revoke:** Pure stateless JWTs remain valid until their expiration timestamp (`exp`). If a user clicks "Logout", or if their account is compromised, the server cannot unilaterally invalidate the token without maintaining a distributed token blacklist, which negates the stateless benefits of JWTs.
3. **Defense via HttpOnly & SameSite Cookies:**
   - **`HttpOnly`:** Instructs the browser that the cookie must never be accessible via client-side scripts (`document.cookie`), completely preventing script-based token exfiltration.
   - **`SameSite=Lax`:** Instructs the browser not to send the cookie on cross-site state-changing requests, mitigating CSRF attacks.
   - **Immediate Revocation:** Because sessions are stateful and stored in a database (e.g., MongoDB), calling `req.session.destroy()` purges the session record immediately. Any subsequent request presenting that session ID is rejected instantly.

#### Question 3: What is a Session Fixation attack, how does an attacker execute it, and why is `req.session.regenerate()` the necessary defense in Express?
**Answer:**
A Session Fixation attack occurs when an attacker forces a victim to use a known session identifier, and the application fails to renew that identifier upon authentication.

**Attack Execution Flow:**
1. The attacker visits the target application and obtains an unauthenticated session ID (e.g., `trustvault.sid = "XYZ-123"`).
2. The attacker induces the victim to use this session ID—for example, via a phishing link containing the cookie parameter, HTTP header injection, or physical access.
3. The victim opens the link and enters their valid credentials to log in.
4. *Vulnerability:* If the server simply attaches `userId` and `role` to the existing session object (`XYZ-123`) without changing the ID, the previously unauthenticated session is now elevated to an authenticated session.
5. The attacker, who already knows the session ID `XYZ-123`, sends a request with `Cookie: trustvault.sid=XYZ-123` and immediately gains full unauthorized access to the victim's account without ever knowing their password.

**Defense via `req.session.regenerate()`:**
When `req.session.regenerate(callback)` is executed:
- Express destroys the old session ID on the server and replaces it with a completely new, cryptographically random identifier.
- The new ID is transmitted to the client in a fresh `Set-Cookie` header.
- The old session ID known to the attacker becomes invalid and abandoned, completely neutralizing the attack.

---

## Build Entry: TDD Parametrized Matrix for `authorize()` (No Implementation)
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Formulated an exhaustive, multi-dimensional parametrized Jest test suite in `tests/authz.test.js` specifying the exact authorization contract for `authorize(user, doc, action)` in strict accordance with `RULES.md`.
- Modeled 35 test cases spanning all permission boundaries and edge conditions:
  - **Owner rights:** Complete authority to `read`, `edit`, `delete`, and `grant`.
  - **Viewer (Edit) rights:** Permission to `read` and `edit`; strictly denied for `delete` and `grant`.
  - **Viewer (Read) rights:** Permission to `read`; strictly denied for `edit`, `delete`, and `grant`.
  - **Unrelated users:** Denied all actions with HTTP 404 (never 403).
  - **Admin accounts:** Verified that administrators have no automatic access to document contents, while still retaining full owner rights on documents they personally own.
  - **Anonymous / Unauthenticated:** Denied all actions with HTTP 404 (never 403).
  - **Deactivated accounts:** Inactive users denied all document actions regardless of ownership or grants.
  - **Missing documents & Invalid actions:** Rejected with HTTP 404.
- Implemented database fixture provisioning for test execution (seeding standard permissions into MongoDB for `viewer_edit` and `viewer_read`).
- Preserved strict Test-Driven Development (TDD) discipline: **zero implementation code** was written in `src/authz.js`.
- Recorded architecture decisions ADR 013 and ADR 014 in `docs/DECISIONS.md`.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/authz.test.js` | Created | Complete 35-case parametrized Jest authorization test suite modeling all rules from `RULES.md`. |
| `docs/DECISIONS.md` | Modified | Recorded ADRs 013 (Parametrized Matrix) and 014 (404-Only Denial Policy). |
| `docs/BUILD_LOG.md` | Modified | Appended this build log entry. |

---

### 3. Why This Design
- **Exhaustive Matrix Over Ad-Hoc Tests:** Authorization vulnerabilities typically lurk in edge-case interactions (e.g. an administrator attempting to delete another user's document, or an edit-viewer attempting to grant permissions). Defining an explicit $N \times M$ matrix testing every permutation guarantees complete boundary coverage.
- **TDD Contract-First Approach (Rule 8):** Rule 8 mandates: *"Write tests first for auth, authz, audit and upload."* Authoring the test matrix prior to implementation prevents developer bias, locks in security invariants, and provides an immediate regression safety net during the subsequent implementation phase.
- **Strict 404 Verification (Rule 3):** The matrix explicitly checks `expect(status).toBe(404)` and `expect(status).not.toBe(403)` on every denial path. This ensures that the implementation can never accidentally leak HTTP 403 status codes.
- **Dynamic Adaptability for Testing:** The test suite parses and registers all test descriptions cleanly. When `src/authz.js` is implemented in the subsequent task, the matrix automatically activates and executes against the implementation without requiring test refactoring.

---

### 4. What Attacks This Design Prevents
1. **Insecure Direct Object Reference (IDOR) & Horizontal Privilege Escalation (CWE-639 / CWE-284):**
   - The matrix validates that users attempting to access, modify, or delete documents belonging to other users are rejected, even if they guess or know valid document ObjectIds.
2. **Vertical Privilege Escalation via Viewer Over-Privilege (CWE-269):**
   - Viewers granted `edit` permissions might attempt to perform administrative actions such as deleting the document or granting access to third parties. The matrix explicitly validates that `delete` and `grant` are denied for all viewer tiers.
3. **Administrative Privilege Abuse / Document Privacy Breaches (CWE-285):**
   - In traditional RBAC, `admin` users frequently bypass authorization checks automatically. Rule 4 strictly establishes: *"Admin has no automatic access to document contents."* The matrix enforces that admins cannot read, edit, delete, or grant permissions on documents they do not own or have not been explicitly granted.
4. **Metadata Enumeration and Resource Discovery (CWE-200 / CWE-209):**
   - Standard APIs return HTTP 403 Forbidden when an unauthorized user queries an existing resource, and HTTP 404 Not Found when a resource does not exist. Attackers exploit this distinction to enumerate confidential document IDs. Enforcing HTTP 404 for all unauthorized attempts completely eliminates this discovery channel.
5. **Zombie Account Privilege Abuse (CWE-287):**
   - Deactivated or suspended users whose sessions or tokens remain active must not be authorized to perform actions. The matrix tests that `isActive: false` users are rejected across all actions.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why should an application return HTTP 404 Not Found instead of HTTP 403 Forbidden for unauthorized access attempts in high-security multi-tenant systems?
**Answer:**
Returning HTTP 403 Forbidden creates an information disclosure vulnerability known as "Resource Existence Oracle" or metadata leakage:
1. **The IDOR Enumeration Threat:** If an attacker sends requests to `/documents/101`, `/documents/102`, and `/documents/103`:
   - If `/documents/101` returns `404 Not Found`, the attacker learns that document 101 does not exist.
   - If `/documents/102` returns `403 Forbidden`, the attacker confirms that document 102 exists, is confidential, and belongs to another user.
2. **Eliminating the Oracle:** By returning `404 Not Found` for *both* missing documents and unauthorized access attempts, the server presents identical responses regardless of whether the document exists. The attacker cannot determine if the resource is real, thwarting brute-force ID scanning, competitive intelligence gathering, and targeted social engineering attacks.

#### Question 2: Why is "Admin has no automatic access to document contents" a vital architectural principle in zero-trust platforms, and how does it change traditional RBAC models?
**Answer:**
1. **Principle of Least Privilege (PoLP):** In traditional Role-Based Access Control (RBAC), the `admin` role is treated as a "super-user" with a blanket wildcard (`*.*`) over all system resources. This creates a catastrophic single point of failure: if any administrator account is compromised (via credential stuffing, phishing, or session theft), the attacker gains instantaneous access to every sensitive customer file in the system.
2. **Separation of System Administration from Data Ownership:** In modern zero-trust and confidential storage architectures (e.g., TrustVault):
   - Administrators manage *system infrastructure* (e.g., user provisioning, account lifecycle, billing, system health, and viewing audit trails).
   - Document owners manage *data privacy* (reading, updating, deleting, and sharing specific files).
3. **Compliance & Insider Threat Mitigation:** Regulations like HIPAA, SOC 2, and GDPR mandate that personal and sensitive data only be accessible on a strict "need-to-know" basis. Preventing administrators from reading document contents without explicit owner grants eliminates insider data snooping and limits the blast radius of administrative credential breaches.

#### Question 3: What are the advantages of writing a parametrized test matrix (TDD) before implementing complex authorization logic (`authorize(user, doc, action)`), and what common security flaws does it catch?
**Answer:**
1. **Combinatorial Completeness:** Authorization decisions depend on multiple independent variables: actor role, ownership status, explicit grant level, account state, and requested action. When writing implementation code first, developers typically test only the primary "happy paths" (e.g., owner can read, viewer can read) and miss cross-cutting edge conditions. A parametrized matrix forces systematic evaluation of all $N \times M$ combinations.
2. **Elimination of Implementation Bias:** When developers write tests after writing code, they subconsciously write assertions that conform to their implementation's assumptions and quirks. Writing the matrix against `RULES.md` independently establishes an unbiased, executable security contract.
3. **Flaws Caught by the Matrix:**
   - **Privilege Leaks on Secondary Actions:** Ensuring that an `edit` grant does not accidentally permit `delete` or `grant`.
   - **Default Permissive Fallthroughs:** Catching unrecognized action strings (e.g. `'execute'`, `'publish'`) that might bypass weak switch/if statements.
   - **State Bypass:** Catching deactivated accounts (`isActive: false`) that possess valid ownership or permissions.
   - **Status Code Leaks:** Ensuring no code path accidentally throws or returns a 403 instead of the mandated 404.


