# TrustVault Technical Architecture & Security Interview Guide

> This guide provides in-depth, interview-ready answers to the four foundational security architecture questions in TrustVault: how `authorize()` works, why unauthorized access returns 404 instead of 403, how the cryptographic hash chain detects tampering, and how document search prevents metadata and count leakage.
>
> Use the **"60-Second Spoken Pitch"** for concise verbal answers, and refer to the **"Architectural Deep-Dive"** for comprehensive technical discussions.

---

## Table of Contents
1. [Question 1: How does `authorize()` work?](#question-1-how-does-authorize-work)
2. [Question 2: Why return HTTP 404 instead of 403?](#question-2-why-return-http-404-instead-of-403)
3. [Question 3: How does the cryptographic hash chain detect tampering?](#question-3-how-does-the-cryptographic-hash-chain-detect-tampering)
4. [Question 4: How does document search avoid leaking counts?](#question-4-how-does-document-search-avoid-leaking-counts)
5. [Spoken Rehearsal Cheatsheet](#spoken-rehearsal-cheatsheet)

---

## Question 1: How does `authorize()` work?

### 60-Second Spoken Pitch (Say Out Loud):
> *"In TrustVault, `authorize(user, doc, action)` serves as our centralized Policy Decision Point (PDP) in `src/authz.js`. Instead of scattering authorization checks across routes or controllers, every single document read, edit, delete, or grant request must dispatch through this single function.*
>
> *First, it validates the action and ensures the document has not been soft-deleted—if `doc.deletedAt` is set, it immediately denies access. Next, it verifies that the user is authenticated and active. If the user owns the document, they receive immediate authorization for all actions. If they are not the owner, the function enforces strict constraints: delete and grant actions are rejected immediately because only owners can delete or grant. Furthermore, system administrators have zero automatic access to document contents per our Separation of Duties principle.*
>
> *For non-owners requesting read or edit access, `authorize()` queries MongoDB in real time with zero caching to check the `Permission` collection. If a grant exists, an 'edit' level allows read and edit, while a 'read' level permits read only. If any check fails, it writes an immutable `ACCESS_DENIED` audit event and throws a 404 `AuthorizationError`, making unauthorized files completely invisible."*

---

### Architectural Deep-Dive

#### 1. The Centralized Policy Decision Point Pattern (Rule 2)
In distributed MVC architectures, authorization vulnerabilities (such as IDOR or broken object-level authorization) frequently arise when access control logic is duplicated or inconsistently implemented across different controllers. 

TrustVault enforces **Rule 2**: *Routes never query the `Document` collection directly.* All HTTP controllers dispatch requests to `src/services/documentService.js`, which uniformly calls `authorize(user, doc, action)` in `src/authz.js` before returning data or mutating state.

```
Incoming Request
       │
       ▼
Express Route Handler (e.g. GET /documents/:id)
       │
       ▼
Document Service (src/services/documentService.js)
       │
       ▼
Policy Decision Point: authorize(user, doc, action) in src/authz.js
       ├─► Validates Action & Soft-Delete (deletedAt)
       ├─► Validates User Authentication & Active Status
       ├─► Evaluates Ownership (Owner has full rights)
       ├─► Enforces Non-Owner Restrictions (Delete & Grant strictly owner-only)
       ├─► Enforces Admin Content Restriction (Rule 4: Zero automatic access)
       └─► Real-Time Permission Lookup in MongoDB (Rule 6: No caching)
               │
      ┌────────┴────────┐
   Approved           Denied
      │                 │
      ▼                 ▼
Execute Operation   logAuditEvent(ACCESS_DENIED)
& Log SUCCESS       throw new AuthorizationError(404)
```

#### 2. Detailed Step-by-Step Pipeline in `src/authz.js`

1. **Action Validation (`SUPPORTED_ACTIONS`):**
   - Restricts `action` strictly to the immutable frozen array: `['read', 'edit', 'delete', 'grant']`. Unsupported actions immediately fail.
2. **Document & Soft-Delete Validation:**
   - Verifies that `doc` exists and contains valid ownership metadata (`doc.owner` or `doc.ownerId`).
   - Checks `if (doc.deletedAt)`: If a document has been soft-deleted, it immediately calls `deny()`. Soft-deleted documents return 404 to everyone—including the document owner.
3. **User Authentication & Active Lifecycle Validation:**
   - Verifies `user` object existence and confirms `user.isActive !== false`. Deactivated accounts are rejected instantly.
4. **Owner Authorization (Rule 4):**
   - Compares `user._id` with `doc.owner` / `doc.ownerId` using `areIdsEqual()` (safely comparing MongoDB `ObjectId` instances or strings).
   - If the user is the owner, authorization returns `true` immediately for any supported action.
5. **Non-Owner Constraints (Rule 4):**
   - `if (action === 'delete' || action === 'grant')`: Non-owners are unconditionally denied. Viewers can never delete a document, nor can they delegate permissions to other users.
6. **Administrator Access Barrier (Rule 4):**
   - Even if `user.role === 'admin'`, the function grants no special privilege. Administrators have zero automatic access to document contents. To access a document, an administrator must be the explicit document owner or hold an explicit permission grant.
7. **Real-Time Permission Lookup (Rule 6):**
   - Queries `Permission.findOne({ documentId: doc._id, userId: user._id })`.
   - **Zero Caching:** To prevent stale permission windows when an owner revokes access, this lookup hits MongoDB directly on every request.
8. **Grant Level Evaluation:**
   - **`level === 'edit'`**: Permits both `'read'` and `'edit'` actions.
   - **`level === 'read'`**: Permits `'read'` only; rejects `'edit'` with 404.
9. **The Denial Mechanism (`deny()`):**
   - Calls `logAuditEvent()` with `eventType: 'ACCESS_DENIED'`, `status: 'DENIED'`, capturing `userId`, `documentId`, `action`, and `reason`.
   - Throws `AuthorizationError`, which carries `status: 404` and `statusCode: 404`.

---

## Question 2: Why return HTTP 404 instead of 403?

### 60-Second Spoken Pitch (Say Out Loud):
> *"In TrustVault, we follow Rule 3: 'Unauthorized access returns 404, never 403.' We do this to eliminate information leakage and reconnaissance.*
>
> *When an API returns HTTP 403 Forbidden, it confirms to an attacker that the resource ID exists, that the endpoint is active, and that they've simply hit a permission boundary. This allows attackers to enumerate valid document IDs, map internal company structure, or confirm the presence of hidden administrative portals.*
>
> *By returning HTTP 404 Not Found, an unauthorized request for another user's document looks completely identical to a request for a completely bogus, non-existent UUID. The attacker learns nothing: they cannot tell if the file exists, who owns it, or whether they guessed a valid ID. It transforms an Insecure Direct Object Reference (IDOR) reconnaissance surface into an opaque black box."*

---

### Architectural Deep-Dive

#### 1. The Vulnerability of HTTP 403 (Information Exposure / CWE-200)
In standard REST conventions:
- `401 Unauthorized` means: *"You must authenticate first."*
- `403 Forbidden` means: *"I know who you are, the document exists, but you do not have permission to touch it."*

While semantically standard, returning `403` in a multi-tenant or confidential storage system creates severe security vulnerabilities:

1. **IDOR Enumeration & Identifier Guessing (CWE-639):**
   - An attacker probing `/documents/6adc5e7e9cd2971f24af5a72` who receives `403 Forbidden` knows with 100% certainty that document `6adc5e7e9cd2971f24af5a72` exists in the system.
   - If they probe `/documents/000000000000000000000000` and receive `404 Not Found`, they can differentiate existing documents from non-existent ones, enabling binary enumeration sweeps.
2. **Administrative Surface Reconnaissance (CWE-200):**
   - When non-admin users navigate to `/admin` or `/admin/users`, returning `403 Forbidden` confirms the presence of an administrative dashboard. Attackers can then focus targeted privilege escalation or CSRF attacks against that known interface.
3. **Targeted Social Engineering & Phishing:**
   - Confirming the existence of confidential filenames or document IDs gives adversaries intelligence for targeted spear-phishing (e.g. knowing a confidential acquisition project code exists).

#### 2. Universal 404 Cloaking Gate (Rule 3)
TrustVault implements universal 404 cloaking at both the route middleware level and the authorization engine level:

```javascript
// src/authz.js
class AuthorizationError extends Error {
  constructor(message = 'Not Found') {
    super(message);
    this.name = 'AuthorizationError';
    this.status = 404;       // Strictly 404, never 403
    this.statusCode = 404;
  }
}
```

- **Resource Cloaking:** If User B attempts to read, download, edit, or delete User A's document, TrustVault returns HTTP 404. User B cannot distinguish User A's real document from an imaginary document ID.
- **Administrative Surface Cloaking:** In `src/routes/admin.js` and `src/routes/adminDashboard.js`, the `requireAdmin` middleware checks user role. If the requester is unauthenticated or not an admin, it immediately returns HTTP 404 `Not Found`. To regular users and external vulnerability scanners, `/admin` does not exist.
- **Deleted Document Cloaking:** When a document is soft-deleted, it returns HTTP 404 across all endpoints for everyone, including its original owner.

---

## Question 3: How does the cryptographic hash chain detect tampering?

### 60-Second Spoken Pitch (Say Out Loud):
> *"TrustVault implements a tamper-evident, append-only cryptographic audit ledger in `src/audit.js`. It functions like a blockchain: each audit event stores an auto-incrementing monotonic sequence number with a unique index, and a SHA-256 hash calculated over the previous event's hash combined with the current event's canonical content.*
>
> *Our `verifyChain()` function validates log integrity through three mathematical checks: First, it verifies sequence continuity from block 1 to tip, ensuring no events were deleted. Second, it verifies pointer continuity, checking that event N's `previousHash` matches event N-1's stored `hash`. Third, it deterministically re-serializes the canonical payload of each event and recomputes the SHA-256 hash. If any database administrator or attacker altered a historical record—such as changing an ACCESS_DENIED status to SUCCESS—the recomputed hash diverges immediately, pinpointing the exact sequence number where the chain was severed.*
>
> *We back this up with defense-in-depth: Mongoose pre-hooks reject updates and deletes, and a dedicated MongoDB application user is restricted strictly to insert and find privileges."*

---

### Architectural Deep-Dive

#### 1. The Structure of an Audit Event
Every audit record in the `AuditEvent` collection represents an immutable block linked cryptographically to its predecessor:

$$\text{hash}_i = \text{SHA-256}\Big(\text{previousHash}_i \mathbin{\Vert} \text{canonicalContent}_i\Big)$$

```
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│          AuditEvent #1          │       │          AuditEvent #2          │
├─────────────────────────────────┤       ├─────────────────────────────────┤
│ sequenceNumber: 1               │       │ sequenceNumber: 2               │
│ previousHash: "000000...0000"   │       │ previousHash: "a7f3e9... (Hash1)│
│ content: { eventType: "LOGIN" } │       │ content: { eventType: "UPLOAD" }│
│ hash: "a7f3e9..."               │◄──────┤ hash: "c2b1d4..."               │
└─────────────────────────────────┘       └─────────────────────────────────┘
```

#### 2. Canonical Serialization
Hashing raw JSON strings is non-deterministic because object key ordering and date formats can vary across environments. TrustVault implements `canonicalizeContent(event)` in `src/audit.js`:
- Standardizes timestamps to ISO strings (`createdAt.toISOString()`).
- Normalizes MongoDB `ObjectId` values to hex strings.
- Sorts all nested `metadata` keys alphabetically using `Object.keys().sort()`.
- Produces a deterministic string representation:
  `canonicalContent = JSON.stringify({ sequenceNumber, eventType, userId, documentId, action, status, reason, ipAddress, userAgent, metadata, createdAt })`.

#### 3. How `verifyChain()` Validates Integrity
The `verifyChain()` utility iterates through the entire collection sorted by `sequenceNumber: 1`:

```javascript
// src/audit.js: verifyChain()
for (let i = 0; i < events.length; i++) {
  const current = events[i];
  const expectedSeq = i + 1;

  // 1. Sequence Continuity Check: Detects dropped or deleted records
  if (current.sequenceNumber !== expectedSeq) {
    return { valid: false, error: `Sequence gap at index ${i}: expected ${expectedSeq}, got ${current.sequenceNumber}` };
  }

  // 2. Hash Pointer Check: Detects inserted or reordered records
  if (current.previousHash !== expectedPreviousHash) {
    return { valid: false, error: `Broken pointer at sequence ${current.sequenceNumber}` };
  }

  // 3. Payload Integrity Check: Detects field modification / tampering
  const canonical = canonicalizeContent(current);
  const recomputedHash = crypto.createHash('sha256')
    .update(current.previousHash + canonical)
    .digest('hex');

  if (recomputedHash !== current.hash) {
    return { valid: false, error: `Hash mismatch at sequence ${current.sequenceNumber}: record altered in database` };
  }

  expectedPreviousHash = current.hash;
}
```

#### 4. The 4 Specific Tampering Scenarios Detected
| Attack Scenario | How `verifyChain()` Catches It |
|---|---|
| **Altering Historical Data**<br>Attacker modifies a record (e.g. changing `status: "DENIED"` to `"SUCCESS"` or swapping a user ID). | `recomputedHash !== current.hash`. Re-hashing the modified content produces a completely different SHA-256 digest, detecting the exact altered sequence number. |
| **Deleting an Event**<br>Attacker drops a row to hide an unauthorized action. | **Sequence Gap:** `current.sequenceNumber !== expectedSeq` (e.g., sequence jumps from 14 to 16). Additionally, the subsequent record's `previousHash` will not match the preceding event's hash. |
| **Inserting a Fabricated Event**<br>Attacker inserts a fake approval block between events 5 and 6. | **Pointer Mismatch:** The fabricated event cannot have both a valid `previousHash` matching event 5 *and* an output `hash` matching event 6's pre-existing `previousHash`. |
| **Concurrent Forking / Race Conditions**<br>Concurrent processes attempt to append conflicting events simultaneously. | **MongoDB Unique Compound Index:** The unique index on `{ sequenceNumber: 1 }` causes MongoDB to reject the duplicate sequence write with `E11000 duplicate key error`. |

#### 5. Defense-in-Depth Protection Layers
1. **Application Layer (Mongoose Pre-Hooks):** `AuditEventSchema` intercepts `updateOne`, `updateMany`, `findOneAndUpdate`, and `save` (when `!isNew`), throwing an error to prevent application-level modifications.
2. **Database Engine Layer (Least Privilege):** Seeding provisions a dedicated MongoDB user (`trustvault_app`) whose roles on `auditevents` are restricted strictly to `["insert", "find"]`. Even if an attacker achieves arbitrary query injection in the application, the database engine itself rejects `update` and `delete` commands.

---

## Question 4: How does document search avoid leaking counts?

### 60-Second Spoken Pitch (Say Out Loud):
> *"In multi-tenant secure vaults, document search is a dangerous metadata leakage vector. If a user searches for a term like 'merger' and the API returns 'total: 40 documents matched, but you only have access to 3,' you've just leaked that 37 confidential merger documents exist in the company.*
>
> *TrustVault eliminates this leakage through a strict query-level permission filter executed directly inside MongoDB. First, we resolve the requesting user's explicit grants from the `Permission` collection. Then, we construct an `$and` query combining the user's search terms with an `$or` ownership and grant filter: `{ $or: [{ owner: user._id }, { _id: { $in: grantedDocIds } }] }` along with `{ deletedAt: null }`.*
>
> *Crucially, we never fetch unfiltered documents into Node.js and filter permissions in JavaScript. Because the database engine only evaluates and returns documents the user is authorized to see, both the results array and the total result count reflect only accessible files. When 40 documents match the keyword and the user has access to 3, the response contains exactly 3 results and a count of 3. Zero metadata leaks."*

---

### Architectural Deep-Dive

#### 1. The Two Deadly Sins of Secure Search
When building search over permission-controlled resources, developers routinely make two critical mistakes:

1. **The In-Memory Filtering Pitfall (Post-Query Filtering):**
   ```javascript
   // BAD: Flawed search implementation
   const allMatches = await Document.find({ $text: { $search: query } });
   const accessible = [];
   for (const doc of allMatches) {
     if (await authorize(user, doc, 'read')) accessible.push(doc); // Filtered in Node.js
   }
   return { totalMatches: allMatches.length, results: accessible }; // LEAKS METADATA!
   ```
   - **Vulnerability 1 (Metadata Leakage):** Exposing `totalMatches: 40` reveals the existence and quantity of confidential files the user cannot see.
   - **Vulnerability 2 (Denial of Service):** Fetching 50,000 documents from MongoDB into Node.js memory just to filter them down to 3 documents exhausts server heap space and CPU.
2. **The Separate Count Query Pitfall:**
   - Running `Document.countDocuments({ name: regex })` without appending the permission filter leaks the global count in pagination metadata (`total`, `pageCount`, `resultCount`).

#### 2. TrustVault's Zero-Leakage Architecture (Rule 6 & ADR 028)

In `src/services/documentService.js`, `searchDocuments()` implements a strict **two-phase query compilation** that guarantees zero leakage:

```
Step 1: Permission Pre-Resolution
Query Permission collection for requesting user:
Permission.find({ userId: user._id }, 'documentId') ──► [ id1, id2, id3 ]

Step 2: Single Atomic MongoDB Query
Document.find({
  $and: [
    { deletedAt: null },                             // Cloak soft-deleted docs
    {
      $or: [
        { owner: user._id },                         // User owns the document
        { ownerId: user._id },                       // Legacy owner field alias
        { _id: { $in: grantedDocIds } }              // Explicitly granted to user
      ]
    },
    { name: { $regex: escapedSearch, $options: 'i' } } // User's search filter
  ]
})
```

#### 3. Strict Count Invariance (The 40 vs 3 Test)
TrustVault's automated test suite includes a strict leakage test in [`tests/search.test.js`](file:///c:/Users/jithe/coding/TrustValut/tests/search.test.js):
- **Setup:** 40 documents are uploaded containing the word `"Financial"` in their title.
- **Grants:** User A owns all 40. User B (the viewer) is granted read permission to exactly 3 documents.
- **Execution:** User B searches for `"Financial"`.
- **Verification:**
  ```javascript
  expect(res.body.documents.length).toBe(3);
  expect(res.body.count).toBe(3);
  expect(res.body.total).toBe(3);
  expect(res.body.resultCount).toBe(3);
  ```
  The response is completely invariant: User B cannot distinguish whether 3 matching documents exist in the vault or 3,000,000. Soft-deleted documents and documents belonging to other users are completely excluded at the storage engine level.

---

## Spoken Rehearsal Cheatsheet

Use these quick bullet points to rehearse answering out loud before an interview:

### 1. `authorize(user, doc, action)`
- **Role:** Centralized Policy Decision Point (PDP) in `src/authz.js`; all routes dispatch through it via `documentService`.
- **Inputs:** `user`, `doc`, `action` (`read`, `edit`, `delete`, `grant`).
- **Steps:**
  1. Validates action against frozen list.
  2. Rejects soft-deleted documents (`doc.deletedAt`) with 404.
  3. Verifies active user status (`user.isActive`).
  4. Authorizes owner unconditionally for all actions.
  5. Denies non-owners for `delete` and `grant` (owner-only).
  6. Enforces admin restriction (admins have zero automatic access to contents).
  7. Queries MongoDB `Permission` collection directly on every request with zero caching.
  8. Permits `edit` grant to read/edit; permits `read` grant to read only.
  9. On any denial: logs `ACCESS_DENIED` audit event and throws 404 `AuthorizationError`.

### 2. Why 404 instead of 403?
- **The Core Reason:** Universal 404 Cloaking eliminates reconnaissance and IDOR enumeration.
- **The 403 Flaw:** `403 Forbidden` confirms that a document ID exists and that an administrative route is real.
- **The 404 Fix:** Returning `404 Not Found` makes unauthorized documents and `/admin` routes completely indistinguishable from invalid or non-existent URLs. Attackers cannot probe or map the system.

### 3. Hash Chain Tamper Detection
- **Structure:** Append-only ledger in `src/audit.js`. Each event has a unique monotonic `sequenceNumber`, `previousHash`, and `hash = SHA256(previousHash + canonicalContent)`.
- **Serialization:** Deterministic canonicalization (ISO timestamps, string ObjectIds, sorted metadata keys).
- **Verification (`verifyChain()`):**
  1. Monotonic sequence continuity (detects deleted records).
  2. Hash pointer continuity (detects inserted or swapped records).
  3. Recomputed content hashing (detects altered database fields).
- **Defense in Depth:** Mongoose schema pre-hooks block mutations; dedicated MongoDB user (`trustvault_app`) restricted to `insert` and `find` only.

### 4. Search Anti-Leakage
- **The Leakage Threat:** Revealing total match counts or filtering in Node.js exposes confidential documents owned by others.
- **The Solution:** Two-phase atomic query in MongoDB:
  1. Fetch granted document IDs for the user from `Permission`.
  2. Execute a single MongoDB query filtering by search criteria AND `{ $or: [owner, grantedDocIds] }` AND `{ deletedAt: null }`.
- **Result:** Filtering occurs inside the database engine; both results and `count` strictly reflect accessible documents (3 out of 40 guarantee).
