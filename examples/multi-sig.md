# Multi-Sig

M-of-N authorization where multiple signers must approve an operation before it
executes. Each signer proves their identity via the standard authentication
pattern without revealing their secret key. The contract tracks authorized
signers in a Map, counts approvals per operation using a Counter-style approach,
and prevents double-approval via a composite key. Demonstrates multi-party
authorization with privacy-preserving signatures.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger signers: Map<Bytes<32>, Boolean>;
export ledger signerCount: Counter;
export ledger threshold: Uint<32>;
export ledger approvalCounts: Map<Bytes<32>, Uint<32>>;
export ledger approvalRecords: Map<Bytes<32>, Boolean>;
export ledger executed: Set<Bytes<32>>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "multisig:pk:"), seq, sk]);
}

constructor() {
  admin = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  sequence.increment(1);
}

// Admin configures the multisig threshold
export circuit setThreshold(m: Uint<32>): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
         "Only admin");
  assert(m > 0 as Uint<32>, "Threshold must be positive");
  threshold = m;
}

// Admin adds a signer
export circuit addSigner(signerPk: Bytes<32>): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
         "Only admin");
  assert(!signers.member(signerPk), "Already a signer");
  signers.insert(signerPk, true);
  signerCount.increment(1);
}

// Admin removes a signer
export circuit removeSigner(signerPk: Bytes<32>): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
         "Only admin");
  assert(signers.member(signerPk), "Not a signer");
  signers.remove(signerPk);
  signerCount.decrement(1);
}

// Signer approves an operation identified by operationId
export circuit approve(operationId: Bytes<32>): [] {
  assert(!executed.member(operationId), "Operation already executed");

  const caller = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  assert(signers.member(caller), "Not an authorized signer");

  // Prevent double-approval: key = hash(operationId || signer)
  const approvalKey = persistentHash<Vector<2, Bytes<32>>>([operationId, caller]);
  assert(!approvalRecords.member(disclose(approvalKey)), "Already approved this operation");
  approvalRecords.insert(disclose(approvalKey), true);

  // Increment approval count for this operation
  if (approvalCounts.member(operationId)) {
    const current = approvalCounts.lookup(operationId);
    approvalCounts.insert(operationId, current + 1);
  } else {
    approvalCounts.insert(operationId, 1 as Uint<32>);
  }
}

// Execute an operation once threshold approvals are met
export circuit execute(operationId: Bytes<32>): [] {
  assert(!executed.member(operationId), "Already executed");
  assert(approvalCounts.member(operationId), "No approvals recorded");

  const count = approvalCounts.lookup(operationId);
  assert(count >= threshold, "Insufficient approvals");

  // Mark as executed
  executed.insert(operationId);

  // Clean up approval count (optional -- saves ledger space)
  approvalCounts.remove(operationId);

  // NOTE: The actual operation logic goes here.
  // In a real contract, this would call internal circuits
  // to perform the authorized action (e.g., transfer funds,
  // update configuration, etc.)
  sequence.increment(1);
}

// Query: check how many approvals an operation has
export circuit getApprovalCount(operationId: Bytes<32>): Uint<32> {
  if (approvalCounts.member(operationId)) {
    return approvalCounts.lookup(operationId);
  }
  return 0 as Uint<32>;
}
```

---

## Key Concepts

- **M-of-N pattern:** The `threshold` variable defines M (minimum approvals
  required). The `signers` Map defines N (authorized signers). Any M of the N
  signers can authorize an operation.
- **Double-approval prevention:** A composite key `hash(operationId || signer)`
  uniquely identifies each signer's approval per operation. The `approvalRecords`
  Map tracks these to prevent any signer from approving twice.
- **Operation abstraction:** Operations are identified by a `Bytes<32>` ID. The
  ID can be a hash of the operation parameters (e.g., `hash(recipient || amount)`),
  ensuring signers approve a specific action, not just a generic authorization.
- **Privacy-preserving signatures:** Each signer proves identity via the standard
  authentication pattern -- they demonstrate knowledge of the secret key that
  produces the registered public key, without revealing the secret itself.
- **Approval counting via Map:** Since Compact has no array of counters, approvals
  are tracked as `Map<operationId, count>`. Each approval reads, increments, and
  reinserts the count.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/multisig/contract/index.cjs';

export interface MultiSigPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, MultiSigPrivateState>,
  ): [MultiSigPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },
};

// Helper: derive operationId from operation parameters
export function deriveOperationId(
  action: string,
  params: Record<string, string | bigint>,
): Uint8Array {
  // In production, use a proper SHA-256 implementation
  const encoder = new TextEncoder();
  const payload = encoder.encode(JSON.stringify({ action, params }));
  // Hash the payload to produce a Bytes<32> operationId
  // This ensures signers approve specific parameters, not just an action type
  return sha256(payload);
}
```

---

## Tests

```
describe('Multi-Sig', () => {

  1. 2-of-3 approval and execute (happy path)
     - Add 3 signers, set threshold=2
     - Signer A approves, signer B approves, execute
     - Assert execution succeeds

  2. Insufficient approvals (should fail)
     - Add 3 signers, set threshold=2
     - Only signer A approves, attempt execute
     - Assert "Insufficient approvals" error

  3. Double-approval prevention (should fail)
     - Signer A approves, signer A attempts second approval
     - Assert "Already approved this operation" error

  4. Non-signer cannot approve (should fail)
     - Unregistered key attempts to approve
     - Assert "Not an authorized signer" error

  5. Re-execution prevention (should fail)
     - Execute an operation, attempt to execute again
     - Assert "Already executed" error

  6. Admin can add and remove signers
     - Add signer, verify signerCount, remove signer
     - Assert removed signer cannot approve
});
```

---

## Notes

- Circuit complexity is high (k ~14-15) due to multiple Map operations per
  circuit call. The `approve` circuit performs 4 Map operations (member check on
  signers, member + insert on approvalRecords, member + lookup/insert on
  approvalCounts). For large signer sets, consider off-chain signature aggregation
  where witnesses collect all signatures off-chain and submit a single proof.
- **Approval record cleanup:** The `approvalRecords` Map grows indefinitely. For
  production, add a cleanup circuit that removes approval records for executed
  operations. This requires maintaining a list of approval keys per operation
  (another Map or off-chain tracking).
- **Signer rotation:** If the admin key is compromised, the entire multisig is
  compromised. Consider making admin itself a multisig operation, or use a
  time-delayed admin transfer pattern.
- **Operation ID design:** The `operationId` should be a hash of all operation
  parameters, not a simple counter. This ensures signers approve specific actions.
  Use the `deriveOperationId` helper in the TypeScript layer.
- This contract does not include the actual action logic in `execute`. In a real
  contract, the execute circuit would call internal circuits to perform the
  authorized action (transfer funds, change settings, etc.). Keep the action
  logic in an internal `circuit` to avoid k-value explosion.
- The `getApprovalCount` circuit generates a ZK proof just to read a Map value.
  For read-only queries, use the indexer's public data provider to read the
  `approvalCounts` ledger state directly, avoiding proof generation overhead.
