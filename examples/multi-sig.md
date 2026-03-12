# Multi-Sig

> **Compiler-validated:** Contract compiles (6 circuits) and 6/6 tests pass against Compact 0.29.0.

M-of-N authorization where multiple signers must approve an operation before it
executes. Each signer proves their identity via the standard authentication
pattern without revealing their secret key. The contract tracks authorized
signers in a Map, counts approvals per operation, and prevents double-approval
via a composite key hash. Demonstrates multi-party authorization with
privacy-preserving signatures.

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

witness localSecretKey(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "multisig:pk:"), sk]);
}

constructor() {
  admin = disclose(publicKey(localSecretKey()));
}

export circuit setThreshold(m: Uint<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(m > 0 as Uint<32>, "Threshold must be positive");
  threshold = disclose(m);
}

export circuit addSigner(signerPk: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(!signers.member(disclose(signerPk)), "Already a signer");
  signers.insert(disclose(signerPk), true);
  signerCount.increment(1);
}

export circuit removeSigner(signerPk: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(signers.member(disclose(signerPk)), "Not a signer");
  signers.remove(disclose(signerPk));
  signerCount.decrement(1);
}

export circuit approve(operationId: Bytes<32>): [] {
  assert(!executed.member(disclose(operationId)), "Operation already executed");
  const caller = disclose(publicKey(localSecretKey()));
  assert(signers.member(caller), "Not an authorized signer");
  const approvalKey = persistentHash<Vector<2, Bytes<32>>>([operationId, caller]);
  assert(!approvalRecords.member(disclose(approvalKey)), "Already approved this operation");
  approvalRecords.insert(disclose(approvalKey), true);
  if (approvalCounts.member(disclose(operationId))) {
    const current = approvalCounts.lookup(disclose(operationId));
    approvalCounts.insert(disclose(operationId), (current + 1) as Uint<32>);
  } else {
    approvalCounts.insert(disclose(operationId), 1 as Uint<32>);
  }
}

export circuit execute(operationId: Bytes<32>): [] {
  assert(!executed.member(disclose(operationId)), "Already executed");
  assert(approvalCounts.member(disclose(operationId)), "No approvals recorded");
  const count = approvalCounts.lookup(disclose(operationId));
  assert(count >= threshold, "Insufficient approvals");
  executed.insert(disclose(operationId));
  approvalCounts.remove(disclose(operationId));
}

export circuit getApprovalCount(operationId: Bytes<32>): Uint<32> {
  if (approvalCounts.member(disclose(operationId))) {
    return approvalCounts.lookup(disclose(operationId));
  }
  return 0 as Uint<32>;
}
```

---

## Key Concepts

### No Sequence Counter

This contract omits the sequence counter found in the bulletin-board pattern.
With a sequence counter, any `sequence.increment()` would invalidate ALL
registered signer keys (since keys are derived from the sequence value). For
contracts with registered key sets, deterministic keys (derived only from the
secret key) are the correct design. Operations are tracked by `operationId`
rather than sequence numbers.

### M-of-N Pattern

The `threshold` variable defines M (minimum approvals). The `signers` Map
defines N (authorized signers). Any M of the N signers can authorize an
operation.

### Double-Approval Prevention

A composite key `hash(operationId || signer)` uniquely identifies each signer's
approval per operation. The `approvalRecords` Map tracks these to prevent any
signer from approving twice.

### Type Widening Fix

`Uint<N> + literal` produces a wider type that exceeds `Uint<N>`. For example,
`Uint<32> + 1` produces `Uint<0..4294967297>`. The fix is an explicit cast:
`(current + 1) as Uint<32>`.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/multisig/contract/index.js';

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
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Multi-user testing with
separate `Contract` instances per signer. Admin uses `pureCircuits.publicKey()`
to pre-compute signer public keys for registration.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/multisig/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const signer1Key = new Uint8Array(32); signer1Key[0] = 0x02;
const signer2Key = new Uint8Array(32); signer2Key[0] = 0x03;
const signer3Key = new Uint8Array(32); signer3Key[0] = 0x04;
const nonSignerKey = new Uint8Array(32); nonSignerKey[0] = 0x05;

const operationId = new Uint8Array(32); operationId[0] = 0xFF;

function makeWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
  };
}

describe("Multi-Sig", () => {
  let adminContract, ctx, signer1Pk, signer2Pk, signer3Pk;

  beforeEach(() => {
    adminContract = new Contract(makeWitnesses(adminKey));
    const addr = sampleContractAddress();
    const initial = adminContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
    signer1Pk = pureCircuits.publicKey(signer1Key);
    signer2Pk = pureCircuits.publicKey(signer2Key);
    signer3Pk = pureCircuits.publicKey(signer3Key);
  });

  it("should complete 2-of-3 approval and execute", () => {
    let r = adminContract.impureCircuits.setThreshold(ctx, 2n);
    r = adminContract.impureCircuits.addSigner(r.context, signer1Pk);
    r = adminContract.impureCircuits.addSigner(r.context, signer2Pk);
    r = adminContract.impureCircuits.addSigner(r.context, signer3Pk);
    const s1 = new Contract(makeWitnesses(signer1Key));
    r = s1.impureCircuits.approve(r.context, operationId);
    const s2 = new Contract(makeWitnesses(signer2Key));
    r = s2.impureCircuits.approve(r.context, operationId);
    r = adminContract.impureCircuits.execute(r.context, operationId);
    expect(r.context).toBeDefined();
  });

  it("should reject insufficient approvals", () => {
    let r = adminContract.impureCircuits.setThreshold(ctx, 2n);
    r = adminContract.impureCircuits.addSigner(r.context, signer1Pk);
    r = adminContract.impureCircuits.addSigner(r.context, signer2Pk);
    const s1 = new Contract(makeWitnesses(signer1Key));
    r = s1.impureCircuits.approve(r.context, operationId);
    expect(() => {
      adminContract.impureCircuits.execute(r.context, operationId);
    }).toThrow("Insufficient approvals");
  });

  it("should prevent double approval", () => {
    let r = adminContract.impureCircuits.setThreshold(ctx, 2n);
    r = adminContract.impureCircuits.addSigner(r.context, signer1Pk);
    const s1 = new Contract(makeWitnesses(signer1Key));
    r = s1.impureCircuits.approve(r.context, operationId);
    expect(() => {
      s1.impureCircuits.approve(r.context, operationId);
    }).toThrow("Already approved this operation");
  });

  it("should reject non-signer approval", () => {
    let r = adminContract.impureCircuits.setThreshold(ctx, 1n);
    const ns = new Contract(makeWitnesses(nonSignerKey));
    expect(() => {
      ns.impureCircuits.approve(r.context, operationId);
    }).toThrow("Not an authorized signer");
  });

  it("should prevent re-execution", () => {
    let r = adminContract.impureCircuits.setThreshold(ctx, 1n);
    r = adminContract.impureCircuits.addSigner(r.context, signer1Pk);
    const s1 = new Contract(makeWitnesses(signer1Key));
    r = s1.impureCircuits.approve(r.context, operationId);
    r = adminContract.impureCircuits.execute(r.context, operationId);
    expect(() => {
      adminContract.impureCircuits.execute(r.context, operationId);
    }).toThrow("Already executed");
  });

  it("should add and remove signers", () => {
    let r = adminContract.impureCircuits.setThreshold(ctx, 1n);
    r = adminContract.impureCircuits.addSigner(r.context, signer1Pk);
    r = adminContract.impureCircuits.removeSigner(r.context, signer1Pk);
    const s1 = new Contract(makeWitnesses(signer1Key));
    expect(() => {
      s1.impureCircuits.approve(r.context, operationId);
    }).toThrow("Not an authorized signer");
  });
});
```

---

## Notes

- **Compiler-validated:** 6 circuits compiled, 6/6 tests pass against Compact 0.29.0.
- **Type widening gotcha:** `Uint<N> + integer_literal` produces a wider range
  type. Use `(expr + 1) as Uint<N>` to narrow back to the expected type. This
  applies to any arithmetic on typed integers stored in Maps.
- Circuit complexity is high (k ~14-15) due to multiple Map/Set operations per
  circuit. The `approve` circuit performs 4 Map operations. For large signer sets,
  consider off-chain signature aggregation.
- **No sequence counter:** Contracts with registered key sets (multi-sig,
  access-control) should NOT use sequence counters in key derivation. A sequence
  increment would invalidate all registered keys.
- The `getApprovalCount` circuit generates a ZK proof for a read-only query. For
  off-chain reads, use the indexer's public data provider to read `approvalCounts`
  directly.
- **Approval record cleanup:** The `approvalRecords` Map grows indefinitely. For
  production, add cleanup after execution.
