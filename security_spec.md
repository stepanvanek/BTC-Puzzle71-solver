# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Address-Keyed Session Identity**: Every `/sessions/{btcAddress}` document ID must match its `btcAddress` field (`^[a-zA-Z0-9]{25,90}$`) and cannot be listed (`allow list: if false`).
2. **Atomic Share-Token Pairing**: Creating `/sessions/{btcAddress}` requires atomically creating `/share_tokens/{shareToken}` in the same transaction (`existsAfter` + `getAfter`), and `shareToken` mappings are immutable once created.
3. **Zero Full-Address Exposure on Public Leaderboard**: `/leaderboard/{addressHash}` is keyed by 64-char SHA-256 hex digest (`^[0-9a-f]{64}$`) and stores only masked prefixes/suffixes (`maskedAddress`), never full addresses or share tokens.
4. **Monotonic Keyspace & Terminal Block Locking**: `totalKeysChecked`, `completedBlocksCount`, `block.progressOffset`, and `block.powOffsets.size()` are strictly non-decreasing; once a block reaches `status == 'completed'`, it is permanently immutable.
5. **Proof-of-Work Enforcement**: Full `2^29` blocks cannot exceed 60% progress with zero PoW shares and cannot transition to `status == 'completed'` without `powCount >= 6` (or `>= 1` for smaller test blocks) and `progressOffset == totalKeys`.
6. **Temporal & Structural Integrity**: All `createdAt`, `updatedAt`, `leasedAt`, `heartbeatAt`, `completedAt`, `lastSeenAt`, and `lastActivityAt` fields must equal `request.time`; shadow fields are rejected via `keys().hasAll(...) && keys().hasOnly(...)` and `affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with `PERMISSION_DENIED`)
1. **Session List Scraping**: `LIST /sessions` attempting to enumerate all active Bitcoin payout addresses -> denied (`allow list: if false`).
2. **Share Token List Scraping**: `LIST /share_tokens` attempting to enumerate all `?u=` URLs -> denied (`allow list: if false`).
3. **Orphaned Session Without Share Token**: `CREATE /sessions/1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU` without atomic `share_tokens/{shareToken}` creation -> denied (`existsAfter` fails).
4. **Shadow Field Injection on Session Create**: `CREATE /sessions/{btcAddress}` with extra field `isAdmin: true` -> denied (`keys().hasOnly(...)` fails).
5. **Immutable Session Hijack**: `UPDATE /sessions/{btcAddress}` changing `shareToken` or `btcAddress` -> denied (`incoming().shareToken == existing().shareToken` + `affectedKeys().hasOnly` fail).
6. **Fake Client Timestamp**: `CREATE /sessions/{btcAddress}` with client-supplied `createdAt: new Date(0)` instead of `request.time` -> denied.
7. **Unbounded ID Poisoning**: `CREATE /sessions/{btcAddress}/devices/bad!id` or >80 char ID -> denied (`isValidId` fails).
8. **Block Progress Rollback**: `UPDATE /sessions/{btcAddress}/blocks/10` decreasing `progressOffset` below `existing().progressOffset` -> denied.
9. **60% PoW Bypass**: `UPDATE /sessions/{btcAddress}/blocks/10` setting `progressOffset: 500000000` with `powCount: 0` on a `2^29` block -> denied.
10. **Fake Block Completion Without PoW**: `UPDATE /sessions/{btcAddress}/blocks/10` setting `status: 'completed'` with `powCount: 2` (`< 6`) -> denied.
11. **Post-Completion Tampering**: `UPDATE /sessions/{btcAddress}/blocks/10` on an already `completed` block -> denied (`existing().status == 'leased'` fails).
12. **Leaderboard Full-Address or Counter Reset**: `CREATE /leaderboard/1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU` (non-SHA256 ID) or `UPDATE` decreasing `totalKeysChecked` -> denied.
