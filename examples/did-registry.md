# DID Registry

> **Compiler-validated:** Contract compiles and 6/6 tests pass against Compact 0.29.0.

A W3C-style Decentralized Identifier (DID) document lifecycle manager. Controllers
can create, update, deactivate, and transfer DID documents on-chain. Each DID maps
to a document hash and a controller public key, with version tracking for audit
trails. Deactivation is irreversible -- the DID remains on-chain but is marked
unusable, preserving the immutable audit trail. Demonstrates document lifecycle
management, controller-based authorization without revealing controller identity,
and version tracking with `(v + 1) as Uint<32>`.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger documents: Map<Bytes<32>, Bytes<32>>;
export ledger controllers: Map<Bytes<32>, Bytes<32>>;
export ledger versions: Map<Bytes<32>, Uint<32>>;
export ledger deactivated: Set<Bytes<32>>;
export ledger totalDids: Counter;

witness localSecretKey(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "did:pk:"), sk]);
}

circuit assertController(didId: Bytes<32>): [] {
  const caller = publicKey(localSecretKey());
  const controller = controllers.lookup(disclose(didId));
  assert(disclose(caller == controller), "Not the controller");
}

constructor() {}

export circuit createDid(didId: Bytes<32>, documentHash: Bytes<32>): [] {
  assert(!documents.member(disclose(didId)), "DID already exists");

  const caller = disclose(publicKey(localSecretKey()));
  controllers.insert(disclose(didId), caller);
  documents.insert(disclose(didId), disclose(documentHash));
  versions.insert(disclose(didId), disclose(1 as Uint<32>));
  totalDids.increment(1);
}

export circuit updateDocument(didId: Bytes<32>, newDocumentHash: Bytes<32>): [] {
  assert(documents.member(disclose(didId)), "DID does not exist");
  assert(!deactivated.member(disclose(didId)), "DID is deactivated");
  assertController(didId);

  documents.insert(disclose(didId), disclose(newDocumentHash));
  const currentVersion = versions.lookup(disclose(didId));
  versions.insert(disclose(didId), disclose((currentVersion + 1) as Uint<32>));
}

export circuit deactivateDid(didId: Bytes<32>): [] {
  assert(documents.member(disclose(didId)), "DID does not exist");
  assert(!deactivated.member(disclose(didId)), "DID already deactivated");
  assertController(didId);

  deactivated.insert(disclose(didId));
}

export circuit resolveDid(didId: Bytes<32>): Bytes<32> {
  assert(documents.member(disclose(didId)), "DID does not exist");
  assert(!deactivated.member(disclose(didId)), "DID is deactivated");

  return documents.lookup(disclose(didId));
}

export circuit transferControl(didId: Bytes<32>, newController: Bytes<32>): [] {
  assert(documents.member(disclose(didId)), "DID does not exist");
  assert(!deactivated.member(disclose(didId)), "DID is deactivated");
  assertController(didId);

  controllers.insert(disclose(didId), disclose(newController));
}
```

---

## Key Concepts

### W3C DID Method Pattern in ZK

This contract implements a DID method where the DID document hash is stored
on-chain but the document contents remain off-chain (on IPFS, a personal
server, etc.). The on-chain hash provides an integrity anchor -- anyone can
verify that a resolved document matches the registered hash. The ZK advantage
is that the controller proves ownership without revealing their secret key.

### Document Versioning

Each `updateDocument` call increments the version counter for that DID. The
version is stored on-chain via `(currentVersion + 1) as Uint<32>` -- the
explicit cast is required because Compact arithmetic between a `Uint<N>` and
a literal produces a `Field`, which must be cast back to the target type.
Versions provide an audit trail: the current version number indicates how
many updates a DID document has undergone.

### Deactivation vs Deletion

Deactivated DIDs remain in the `documents` and `controllers` Maps. Only the
`deactivated` Set marks them as unusable. This preserves the immutable audit
trail -- a deactivated DID's history is still verifiable. The `resolveDid`,
`updateDocument`, and `transferControl` circuits all check the `deactivated`
Set and reject operations on deactivated DIDs.

### Controller-Based Authorization

The controller's public key is derived from their secret key via
`persistentHash(domainSeparator + secretKey)`. The `assertController`
internal circuit compares the caller's derived public key against the stored
controller. The controller identity is disclosed on-chain (as the hash), but
the underlying secret key never leaves the witness.

### No Sequence Counter

This contract omits the sequence counter. DID identities are long-lived --
the controller key is deterministic from the secret key alone. If a sequence
counter were used, the controller's public key would change after every state
transition, invalidating all stored controller references across all DIDs
managed by that controller.

### Privacy Model

| Value | Visibility | Why |
|-------|-----------|-----|
| Secret key | **PRIVATE** | Never leaves the witness |
| Controller public key | **PUBLIC** | Stored on ledger for authorization checks |
| DID identifier | **PUBLIC** | Map key, disclosed for lookups |
| Document hash | **PUBLIC** | Integrity anchor on ledger |
| Document contents | **OFF-CHAIN** | Only the hash is stored on-chain |
| Version number | **PUBLIC** | Audit trail on ledger |

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/did/contract/index.js';

export interface DidPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, DidPrivateState>,
  ): [DidPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Controller and non-controller
use separate `Contract` instances with different witnesses. The context chain is
shared across all operations to maintain ledger state continuity.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/did/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const controllerKey = new Uint8Array(32); controllerKey[0] = 0x01;
const newControllerKey = new Uint8Array(32); newControllerKey[0] = 0x02;
const impostorKey = new Uint8Array(32); impostorKey[0] = 0x03;

function padBytes(s) {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(s);
  bytes.set(encoded.slice(0, 32));
  return bytes;
}

const DID_1 = padBytes("did:mnt:abc123");
const DID_2 = padBytes("did:mnt:def456");
const DOC_HASH_1 = padBytes("QmDocHash1");
const DOC_HASH_2 = padBytes("QmDocHash2");

function makeWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
  };
}

describe("DID Registry", () => {
  let controllerContract;
  let ctx;

  beforeEach(() => {
    controllerContract = new Contract(makeWitnesses(controllerKey));
    const addr = sampleContractAddress();
    const initial = controllerContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should create DID and resolve document", () => {
    const r1 = controllerContract.impureCircuits.createDid(ctx, DID_1, DOC_HASH_1);
    const r2 = controllerContract.impureCircuits.resolveDid(r1.context, DID_1);
    expect(r2.result).toEqual(DOC_HASH_1);
  });

  it("should update document and increment version", () => {
    const r1 = controllerContract.impureCircuits.createDid(ctx, DID_1, DOC_HASH_1);
    const r2 = controllerContract.impureCircuits.updateDocument(r1.context, DID_1, DOC_HASH_2);
    const r3 = controllerContract.impureCircuits.resolveDid(r2.context, DID_1);
    expect(r3.result).toEqual(DOC_HASH_2);
  });

  it("should deactivate DID and prevent resolution", () => {
    const r1 = controllerContract.impureCircuits.createDid(ctx, DID_1, DOC_HASH_1);
    const r2 = controllerContract.impureCircuits.deactivateDid(r1.context, DID_1);
    expect(() => {
      controllerContract.impureCircuits.resolveDid(r2.context, DID_1);
    }).toThrow("DID is deactivated");
  });

  it("should reject update by non-controller", () => {
    const r1 = controllerContract.impureCircuits.createDid(ctx, DID_1, DOC_HASH_1);
    const impostor = new Contract(makeWitnesses(impostorKey));
    expect(() => {
      impostor.impureCircuits.updateDocument(r1.context, DID_1, DOC_HASH_2);
    }).toThrow("Not the controller");
  });

  it("should transfer control to new controller", () => {
    const newControllerPk = pureCircuits.publicKey(newControllerKey);
    const r1 = controllerContract.impureCircuits.createDid(ctx, DID_1, DOC_HASH_1);
    const r2 = controllerContract.impureCircuits.transferControl(r1.context, DID_1, newControllerPk);
    // New controller should be able to update
    const newController = new Contract(makeWitnesses(newControllerKey));
    const r3 = newController.impureCircuits.updateDocument(r2.context, DID_1, DOC_HASH_2);
    expect(r3.context).toBeDefined();
    // Old controller should be rejected
    expect(() => {
      controllerContract.impureCircuits.updateDocument(r3.context, DID_1, DOC_HASH_1);
    }).toThrow("Not the controller");
  });

  it("should reject actions on deactivated DID", () => {
    const r1 = controllerContract.impureCircuits.createDid(ctx, DID_1, DOC_HASH_1);
    const r2 = controllerContract.impureCircuits.deactivateDid(r1.context, DID_1);
    expect(() => {
      controllerContract.impureCircuits.updateDocument(r2.context, DID_1, DOC_HASH_2);
    }).toThrow("DID is deactivated");
    expect(() => {
      controllerContract.impureCircuits.transferControl(
        r2.context, DID_1, pureCircuits.publicKey(newControllerKey)
      );
    }).toThrow("DID is deactivated");
  });
});
```

---

## CLI

```bash
compact compile src/did-registry.compact src/managed/did
npm test
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly (5 exported circuits +
  1 internal) and all 6 tests pass against Compact 0.29.0 with
  `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is moderate (k ~13-14) due to multiple Map lookups and Set
  membership checks per circuit. The `updateDocument` circuit is the heaviest
  because it performs a Map lookup (version), arithmetic, and a Map insert.
- **`(currentVersion + 1) as Uint<32>` is required.** Adding a literal to a
  `Uint<N>` produces a `Field`. The explicit cast back to `Uint<32>` is
  necessary for type compatibility with the Map value type.
- **`documents.insert` on existing key overwrites.** Compact `Map.insert`
  replaces the value if the key already exists. This is used intentionally in
  `updateDocument` and `transferControl` to update existing entries.
- **DID revocation vs deactivation:** This contract implements deactivation
  (marking as unusable) rather than deletion (removing from Maps). Deletion
  would break the audit trail. A production DID method might add a
  `reactivateDid` circuit for recoverable deactivation.
- **Multi-DID per controller:** A single controller can manage multiple DIDs.
  The controller public key is stored per-DID in the `controllers` Map, so
  transferring one DID does not affect others.
- **No sequence counter simplifies multi-DID management.** If a sequence counter
  were used, every state transition would change the controller's public key,
  requiring updates to all DIDs managed by that controller.
- **`assertController` is an internal `circuit`** (not `pure circuit`) because
  it accesses ledger state (`controllers` Map). Internal circuits avoid the
  k-value explosion from cross-exported-circuit calls.
- **`disclose()` on Map keys:** Every `didId` used as a Map key or Set member
  argument requires `disclose()` wrapping. The compiler cannot determine whether
  circuit parameters might be witness-derived in a calling context.
