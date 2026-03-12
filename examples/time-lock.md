# Time Lock

> **Compiler-validated:** Contract compiles and 7/7 tests pass against Compact 0.29.0.

A time-locked vault that holds assets until a specified deadline, with
privacy-preserving ownership and optional early release by the owner.
Demonstrates the core LOK/RELEASE pattern -- the building block for LOKx
lock and escrow primitives.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum LockState { empty, locked, released }

export ledger state: LockState;
export ledger owner: Bytes<32>;
export ledger beneficiary: Bytes<32>;
export ledger unlockTime: Uint<64>;
export ledger description: Opaque<"string">;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "timelock:pk:"), seq, sk]);
}

constructor() {
  state = LockState.empty;
  sequence.increment(1);
}

export circuit lock(
  beneficiaryPk: Bytes<32>,
  deadline: Uint<64>,
  desc: Opaque<"string">
): [] {
  assert(state == LockState.empty, "Already locked");

  owner = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  beneficiary = disclose(beneficiaryPk);
  unlockTime = disclose(deadline);
  description = disclose(desc);
  state = LockState.locked;
}

export circuit release(): [] {
  assert(state == LockState.locked, "Not locked");
  assert(beneficiary == publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>),
         "Not the beneficiary");

  const now = getCurrentTime();
  assert(disclose(now >= unlockTime), "Too early");

  state = LockState.released;
  sequence.increment(1);
}

export circuit earlyRelease(): [] {
  assert(state == LockState.locked, "Not locked");
  assert(owner == publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>),
         "Not the owner");

  state = LockState.released;
  sequence.increment(1);
}
```

---

## Key Concepts

**LOK primitive:** `lock()` stores the beneficiary, deadline, and description. The
asset is logically locked until the deadline or owner intervention.

**RELEASE primitive:** `release()` verifies the caller is the beneficiary and the
deadline has passed. `earlyRelease()` allows the owner to override.

**Time handling limitations:**

- `getCurrentTime()` is a witness -- runs off-chain, not cryptographically enforced
- The network cannot enforce time constraints natively in current Compact
- Newer versions may support `blockTimeGreaterThan` ledger ADT for protocol-enforced time
- For production LOKx: time enforcement will need the protocol-level support

**Privacy design:**

| Value | Visibility | Stored where |
|-------|-----------|--------------
| Secret key | **PRIVATE** | Off-chain, in user's private state. Never leaves the witness. |
| Public key hash | **PUBLIC** | On ledger as `owner`/`beneficiary`. Verifiable by anyone. |
| Unlock time | **PUBLIC** | On ledger for transparency |
| Description | **PUBLIC** | Optional metadata on ledger |

**`disclose()` on all circuit parameters:** Every circuit parameter written to an
`export ledger` field requires `disclose()` wrapping. In `lock()`, this means
`beneficiaryPk`, `deadline`, and `desc` all need `disclose()`. The compiler cannot
statically prove these values are not witness-derived, so it conservatively
requires explicit disclosure.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/timelock/contract/index.js';

export interface TimeLockPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, TimeLockPrivateState>):
    [TimeLockPrivateState, Uint8Array] => [privateState, privateState.secretKey],

  getCurrentTime: ({ privateState }: WitnessContext<Ledger, TimeLockPrivateState>):
    [TimeLockPrivateState, bigint] => [privateState, BigInt(Date.now())],
};
```

---

## Tests

Compiler-validated simulator tests (7/7 passing). Multi-user testing uses separate
`Contract` instances with different witnesses, sharing the context chain. The
`getCurrentTime` witness is injected with controlled timestamps to test time-based
logic deterministically.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, LockState } from "../src/managed/timelock/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const ownerKey = new Uint8Array(32); ownerKey[0] = 0x01;
const beneficiaryKey = new Uint8Array(32); beneficiaryKey[0] = 0x02;
const impostorKey = new Uint8Array(32); impostorKey[0] = 0x03;

const futureTime = BigInt(Date.now()) + 3_600_000n;
const pastTime = BigInt(Date.now()) - 3_600_000n;

function makeWitnesses(sk, time = BigInt(Date.now())) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCurrentTime: ({ privateState }) => [privateState, time],
  };
}

describe("Time Lock", () => {
  let ownerContract;
  let ctx;
  let beneficiaryPk;

  beforeEach(() => {
    ownerContract = new Contract(makeWitnesses(ownerKey));
    const addr = sampleContractAddress();
    const initial = ownerContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
    const seqBytes = new Uint8Array(32); seqBytes[0] = 0x01;
    beneficiaryPk = pureCircuits.publicKey(beneficiaryKey, seqBytes);
  });

  it("should lock with beneficiary and deadline", () => {
    const r = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, futureTime, "Test Lock");
    expect(r.context).toBeDefined();
  });

  it("should allow beneficiary to release after deadline", () => {
    const r1 = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, pastTime, "Past Lock");
    const beneficiary = new Contract(makeWitnesses(beneficiaryKey, BigInt(Date.now())));
    const r2 = beneficiary.impureCircuits.release(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject release before deadline", () => {
    const r1 = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, futureTime, "Future Lock");
    const beneficiary = new Contract(makeWitnesses(beneficiaryKey, BigInt(Date.now())));
    expect(() => {
      beneficiary.impureCircuits.release(r1.context);
    }).toThrow("Too early");
  });

  it("should reject release by non-beneficiary", () => {
    const r1 = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, pastTime, "Test");
    const impostor = new Contract(makeWitnesses(impostorKey, BigInt(Date.now())));
    expect(() => {
      impostor.impureCircuits.release(r1.context);
    }).toThrow("Not the beneficiary");
  });

  it("should allow owner early release", () => {
    const r1 = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, futureTime, "Early");
    const r2 = ownerContract.impureCircuits.earlyRelease(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject early release by non-owner", () => {
    const r1 = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, futureTime, "Test");
    const impostor = new Contract(makeWitnesses(impostorKey));
    expect(() => {
      impostor.impureCircuits.earlyRelease(r1.context);
    }).toThrow("Not the owner");
  });

  it("should reject double lock", () => {
    const r1 = ownerContract.impureCircuits.lock(ctx, beneficiaryPk, futureTime, "First");
    expect(() => {
      ownerContract.impureCircuits.lock(r1.context, beneficiaryPk, futureTime, "Second");
    }).toThrow("Already locked");
  });
});
```

---

## Extending for LOKx

Production LOKx time-lock would add:

- Multiple condition types (time + event + on-demand)
- Actual coin operations for asset transfer
- Condition composition (AND/OR of multiple conditions)
- Event hooks for indexer notification

---

## Notes

- **Compiler-validated:** This contract compiles cleanly and all 7 tests pass
  against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- This pattern is the building block for vesting schedules, payment channels, and timed releases
- For production: combine with coin operations (receive/send) for actual asset locking
- Circuit complexity is low (k ~12-13) -- fast proof generation
- **Time witness limitation:** `getCurrentTime()` is not cryptographically enforced.
  The prover could submit a false timestamp. The on-chain verifier confirms the ZK
  proof is valid but cannot check the timestamp against wall-clock time. For
  production LOKx, protocol-level time enforcement is needed.
- **`export pure circuit publicKey`** enables off-chain key derivation in tests
  (e.g., `pureCircuits.publicKey(beneficiaryKey, seqBytes)` to pre-compute the
  beneficiary's public key for the `lock()` call)
- **`disclose()` on all lock parameters:** `beneficiaryPk`, `deadline`, and `desc`
  all need `disclose()` when written to `export ledger` fields. The compiler cannot
  statically determine whether a circuit parameter might be derived from a witness
  in a calling context, so it conservatively requires explicit disclosure.
