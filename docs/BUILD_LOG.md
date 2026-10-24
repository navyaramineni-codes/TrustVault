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
   - Centralizing document access guarantees uniform error behavior (always throwing `NotFoundError` returning 404 per Rule 3 & 4) and guarantees that every denied attempt emits an immutable security audit event via `src/audit.js`.





