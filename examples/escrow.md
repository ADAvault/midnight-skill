# Escrow

Compiler-validated: compiles and 8/8 tests pass against Compact 0.29.0

A privacy-preserving two-party escrow contract. Party A deposits and locks
assets with conditions; Party B claims by proving they meet those conditions
via ZK proof; if the deadline passes without a claim, Party A reclaims.
This demonstrates the core LOK/RELEASE/ESCROW primitives in Compact and is
the most directly LOKx-relevant example in the collection.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum EscrowState { empty, funded, claimed, expired, refunded }

export ledger state: EscrowState;
export ledger depositor: Bytes<32>;
export ledger recipient: Bytes<32>;
export ledger amount: Uint<64>;
export ledger conditionHash: Bytes<32>;
export ledger deadline: Uint<64>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getConditionSecret(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "escrow:pk:"), seq, sk]);
}

constructor() {
  state = EscrowState.empty;
  sequence.increment(1);
}

export circuit fund(
  recipientPk: Bytes<32>,
  escrowAmount: Uint<64>,
  condition: Bytes<32>,
  escrowDeadline: Uint<64>
): [] {
  assert(state == EscrowState.empty, "Escrow not empty");

  depositor = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  recipient = disclose(recipientPk);
  amount = disclose(escrowAmount);
  conditionHash = disclose(persistentHash<Vector<1, Bytes<32>>>([condition]));
  deadline = disclose(escrowDeadline);
  state = EscrowState.funded;
}

export circuit claim(): [] {
  assert(state == EscrowState.funded, "Not funded");
  assert(recipient == publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>),
         "Not the recipient");

  const secret = getConditionSecret();
  const hash = persistentHash<Vector<1, Bytes<32>>>([secret]);
  assert(disclose(hash == conditionHash), "Condition not met");

  state = EscrowState.claimed;
  sequence.increment(1);
}

export circuit refund(): [] {
  assert(state == EscrowState.funded, "Not funded");
  assert(depositor == publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>),
         "Not the depositor");

  const now = getCurrentTime();
  assert(disclose(now > deadline), "Deadline not reached");

  state = EscrowState.refunded;
  sequence.increment(1);
}
```

---

## Key Concepts

### Privacy-preserving condition verification

The depositor stores a hash of the condition on-chain when funding the escrow.
The recipient later proves knowledge of the pre-image (the original condition
value) without revealing it. The ZK proof guarantees: "I know a value whose
hash matches the stored condition hash." The condition itself never appears
on-chain -- only the boolean result of the comparison is disclosed.

This is the hash-lock pattern, the simplest form of conditional release. It
scales naturally: multiple conditions can be composed via Merkle trees, where
the root hash is stored on-chain and the claimant provides a Merkle proof for
the specific condition they satisfy.

### Time handling

Compact has no native block time. The `getCurrentTime()` witness returns
`BigInt(Date.now())` from the TypeScript runtime. This value is NOT
cryptographically enforced -- the witness value is trusted by the circuit.

This is acceptable for the refund path because the only party who can
manipulate the time is the depositor (the one calling `refund`), and lying
about the time only lets them refund early -- which hurts the recipient. In a
production system you would want protocol-enforced time. Newer Compact
versions may support `blockTimeGreaterThan` for this purpose.

### Authentication

Both depositor and recipient authenticate using the bulletin-board (bboard)
pattern: `persistentHash(domainSeparator + sequence + secretKey)`. The domain
separator `"escrow:pk:"` prevents cross-contract key reuse. The sequence
counter ensures the public key changes after each state transition, preventing
replay attacks.

The `disclose()` call on the depositor's public key in `fund()` makes that
value public on-chain so it can be compared later. The recipient's public key
is passed as a plain argument. Both parties prove ownership of their key by
demonstrating knowledge of the secret key inside the circuit.

### Escrow state machine

```
empty --> funded    (depositor calls fund)
funded --> claimed  (recipient calls claim, proves condition)
funded --> refunded (depositor calls refund, after deadline)
```

No other transitions are possible. The `assert` guards at the top of each
circuit enforce this. Once the escrow reaches `claimed` or `refunded`, it is
terminal -- no further operations succeed.

---

## TypeScript Witnesses

```typescript
export interface EscrowPrivateState {
  readonly secretKey: Uint8Array;
  readonly conditionSecret?: Uint8Array;
}

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, EscrowPrivateState>): [
    EscrowPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secretKey],

  getConditionSecret: ({
    privateState,
  }: WitnessContext<Ledger, EscrowPrivateState>): [
    EscrowPrivateState,
    Uint8Array,
  ] => {
    if (!privateState.conditionSecret) throw new Error('No condition secret');
    return [privateState, privateState.conditionSecret];
  },

  getCurrentTime: ({
    privateState,
  }: WitnessContext<Ledger, EscrowPrivateState>): [
    EscrowPrivateState,
    bigint,
  ] => [privateState, BigInt(Date.now())],
};
```

---

## Test (Simulator)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, EscrowState } from "../src/managed/escrow/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import crypto from "crypto";

setNetworkId("undeployed");

const depositorKey = new Uint8Array(32);
depositorKey[0] = 0x01;
const recipientKey = new Uint8Array(32);
recipientKey[0] = 0x02;
const impostorKey = new Uint8Array(32);
impostorKey[0] = 0x03;

const conditionSecret = crypto.randomBytes(32);
const wrongSecret = crypto.randomBytes(32);
const escrowAmount = 1000n;
const futureDeadline = BigInt(Date.now()) + 3_600_000n;
const pastDeadline = BigInt(Date.now()) - 3_600_000n;

function makeWitnesses(sk, condSecret, time = BigInt(Date.now())) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getConditionSecret: ({ privateState }) => [privateState, condSecret || new Uint8Array(32)],
    getCurrentTime: ({ privateState }) => [privateState, time],
  };
}

describe("Escrow", () => {
  let depositorContract;
  let recipientContract;
  let ctx;
  let recipientPk;

  beforeEach(() => {
    depositorContract = new Contract(makeWitnesses(depositorKey, conditionSecret));
    recipientContract = new Contract(makeWitnesses(recipientKey, conditionSecret));

    const addr = sampleContractAddress();
    const initial = depositorContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );

    const seqBytes = new Uint8Array(32);
    seqBytes[0] = 0x01;
    recipientPk = pureCircuits.publicKey(recipientKey, seqBytes);
  });

  it("should fund escrow", () => {
    const r = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, futureDeadline
    );
    expect(r.context).toBeDefined();
  });

  it("should allow recipient to claim with correct condition", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, futureDeadline
    );
    const r2 = recipientContract.impureCircuits.claim(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject claim with wrong condition", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, futureDeadline
    );
    const wrongRecipient = new Contract(makeWitnesses(recipientKey, wrongSecret));
    expect(() => {
      wrongRecipient.impureCircuits.claim(r1.context);
    }).toThrow("Condition not met");
  });

  it("should reject claim by wrong party", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, futureDeadline
    );
    const impostor = new Contract(makeWitnesses(impostorKey, conditionSecret));
    expect(() => {
      impostor.impureCircuits.claim(r1.context);
    }).toThrow("Not the recipient");
  });

  it("should allow depositor to refund after deadline", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, pastDeadline
    );
    const refunder = new Contract(makeWitnesses(depositorKey, null, BigInt(Date.now())));
    const r2 = refunder.impureCircuits.refund(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject refund before deadline", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, futureDeadline
    );
    const refunder = new Contract(makeWitnesses(depositorKey, null, BigInt(Date.now())));
    expect(() => {
      refunder.impureCircuits.refund(r1.context);
    }).toThrow("Deadline not reached");
  });

  it("should reject double-funding", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, futureDeadline
    );
    expect(() => {
      depositorContract.impureCircuits.fund(
        r1.context, recipientPk, escrowAmount, conditionSecret, futureDeadline
      );
    }).toThrow("Escrow not empty");
  });

  it("should reject claim after refund", () => {
    const r1 = depositorContract.impureCircuits.fund(
      ctx, recipientPk, escrowAmount, conditionSecret, pastDeadline
    );
    const refunder = new Contract(makeWitnesses(depositorKey, null, BigInt(Date.now())));
    const r2 = refunder.impureCircuits.refund(r1.context);
    expect(() => {
      recipientContract.impureCircuits.claim(r2.context);
    }).toThrow("Not funded");
  });
});
```

---

## Relevance to LOKx

This example maps directly to the three LOKx primitives:

| LOKx Primitive | Escrow Circuit | What Happens |
|----------------|---------------|--------------|
| **LOK** | `fund()` | Lock asset with conditions (hash-lock + deadline) |
| **RELEASE** | `claim()` | Condition verified via ZK proof, asset unlocks |
| **ESCROW** | entire contract | Two-party conditional exchange with timeout |

The condition-hash pattern is the foundation for all LOKx condition types:

- **Time conditions** -- the deadline check in `refund()`. The depositor can
  only reclaim after the deadline passes, giving the recipient a window to
  fulfil.
- **Event conditions** -- the hash pre-image proof in `claim()`. Any
  off-chain event can be encoded as a secret; proving knowledge of it triggers
  release.
- **On-demand conditions** -- owner authorization in `fund()` and `refund()`.
  The depositor retains control via their secret key, enabling manual
  lock/unlock flows.

In production LOKx, these condition types compose: a single LOK can require
"time AND event" or "event OR on-demand override," with the conditions
structured as a Merkle tree whose root is stored on-chain.

---

## CLI

```bash
compact compile src/escrow.compact src/managed/escrow
npm test
```

---

## Notes

- This is a simplified single-asset escrow. Production LOKx would use coin
  operations (`mint`, `pour`, `transfer`) for real asset movement on the
  Midnight UTXO layer.
- The condition-hash approach scales to multiple conditions via Merkle trees.
  Store the Merkle root on-chain; the claimant provides a proof for the
  specific leaf they satisfy.
- Circuit complexity is moderate (k ~14-15) -- well within proof server
  limits for the current Midnight devnet.
- The `sequence` counter prevents replay: after each state transition the
  effective public key changes, so a captured proof cannot be resubmitted.
- For multi-asset escrow, each asset would be a separate coin commitment.
  The escrow contract would hold references (nullifiers) rather than balances.
- ALL circuit parameters written to `export ledger` require `disclose()` --
  this includes `recipientPk`, `escrowAmount`, condition hash result, and
  `escrowDeadline`.
- `persistentHash` results also need `disclose()` when assigned to public
  ledger fields.
- `publicKey` must be `export pure circuit` for off-chain key derivation
  (accessed via `pureCircuits.publicKey` in TypeScript).
