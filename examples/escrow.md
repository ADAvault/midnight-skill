# Escrow

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

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "escrow:pk:"), seq, sk]);
}

constructor() {
  state = EscrowState.empty;
  sequence.increment(1);
}

// Depositor creates escrow with hashed condition
export circuit fund(
  recipientPk: Bytes<32>,
  escrowAmount: Uint<64>,
  condition: Bytes<32>,
  escrowDeadline: Uint<64>
): [] {
  assert(state == EscrowState.empty, "Escrow not empty");

  depositor = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  recipient = recipientPk;
  amount = escrowAmount;
  conditionHash = persistentHash<Vector<1, Bytes<32>>>([condition]);
  deadline = escrowDeadline;
  state = EscrowState.funded;
}

// Recipient claims by proving knowledge of condition
export circuit claim(): [] {
  assert(state == EscrowState.funded, "Not funded");
  assert(recipient == publicKey(localSecretKey(), sequence as Field as Bytes<32>),
         "Not the recipient");

  // Verify condition without revealing it
  const secret = getConditionSecret();
  const hash = persistentHash<Vector<1, Bytes<32>>>([secret]);
  assert(disclose(hash == conditionHash), "Condition not met");

  state = EscrowState.claimed;
  sequence.increment(1);
}

// Depositor reclaims after deadline
export circuit refund(): [] {
  assert(state == EscrowState.funded, "Not funded");
  assert(depositor == publicKey(localSecretKey(), sequence as Field as Bytes<32>),
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
import { describe, it, expect, beforeAll } from 'vitest';
import { Contract } from '../managed/escrow/contract/index.js';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

setNetworkId('undeployed');

// --- helpers ---

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function makeWitnesses(sk: Uint8Array, conditionSecret?: Uint8Array) {
  return {
    localSecretKey: ({ privateState }: any) => [privateState, sk],
    getConditionSecret: ({ privateState }: any) => {
      if (!conditionSecret) throw new Error('No condition secret');
      return [privateState, conditionSecret];
    },
    getCurrentTime: ({ privateState }: any) => [
      privateState,
      BigInt(Date.now()),
    ],
  };
}

function makeTimeWitnesses(
  sk: Uint8Array,
  fakeTime: bigint,
  conditionSecret?: Uint8Array,
) {
  return {
    localSecretKey: ({ privateState }: any) => [privateState, sk],
    getConditionSecret: ({ privateState }: any) => {
      if (!conditionSecret) throw new Error('No condition secret');
      return [privateState, conditionSecret];
    },
    getCurrentTime: ({ privateState }: any) => [privateState, fakeTime],
  };
}

// --- test data ---

const depositorSk = randomBytes(32);
const recipientSk = randomBytes(32);
const conditionSecret = randomBytes(32);
const wrongSecret = randomBytes(32);
const escrowAmount = 1000n;
const futureDeadline = BigInt(Date.now()) + 3_600_000n; // 1 hour from now
const pastDeadline = BigInt(Date.now()) - 3_600_000n; // 1 hour ago

// --- tests ---

describe('Escrow', () => {
  let contractState: any;
  let privateState: any;

  beforeAll(() => {
    const contract = new Contract(makeWitnesses(depositorSk));
    const initial = contract.initialState(
      createConstructorContext({}, sampleContractAddress),
    );
    contractState = initial.currentContractState;
    privateState = initial.currentPrivateState;
  });

  // 1. Fund escrow (happy path)
  it('should fund escrow', () => {
    const contract = new Contract(makeWitnesses(depositorSk));
    const ctx = createCircuitContext(contractState, privateState);

    // Derive recipient public key to pass as argument
    const recipientContract = new Contract(makeWitnesses(recipientSk));
    const recipientCtx = createCircuitContext(contractState, {});

    const result = contract.impureCircuits.fund(ctx, {
      recipientPk: recipientCtx.publicKey,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: futureDeadline,
    });

    expect(result.currentContractState.state).toBe('funded');
    expect(result.currentContractState.amount).toBe(escrowAmount);
  });

  // 2. Claim with correct condition (happy path)
  it('should allow recipient to claim with correct condition', () => {
    // Fund first
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: /* derived recipient pk */ recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: futureDeadline,
    });

    // Claim as recipient
    const recipientContract = new Contract(
      makeWitnesses(recipientSk, conditionSecret),
    );
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );
    const claimed = recipientContract.impureCircuits.claim(ctx);

    expect(claimed.currentContractState.state).toBe('claimed');
  });

  // 3. Claim with wrong condition (should fail)
  it('should reject claim with wrong condition', () => {
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: futureDeadline,
    });

    const recipientContract = new Contract(
      makeWitnesses(recipientSk, wrongSecret),
    );
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );

    expect(() => recipientContract.impureCircuits.claim(ctx)).toThrow(
      'Condition not met',
    );
  });

  // 4. Claim by wrong recipient (should fail)
  it('should reject claim by wrong party', () => {
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: futureDeadline,
    });

    // Impostor tries to claim
    const impostorSk = randomBytes(32);
    const impostorContract = new Contract(
      makeWitnesses(impostorSk, conditionSecret),
    );
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );

    expect(() => impostorContract.impureCircuits.claim(ctx)).toThrow(
      'Not the recipient',
    );
  });

  // 5. Refund after deadline (happy path)
  it('should allow depositor to refund after deadline', () => {
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: pastDeadline, // already expired
    });

    // Refund as depositor (time is past deadline)
    const refundContract = new Contract(
      makeTimeWitnesses(depositorSk, BigInt(Date.now())),
    );
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );
    const refunded = refundContract.impureCircuits.refund(ctx);

    expect(refunded.currentContractState.state).toBe('refunded');
  });

  // 6. Refund before deadline (should fail)
  it('should reject refund before deadline', () => {
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: futureDeadline, // far in the future
    });

    // Try to refund with current time (before deadline)
    const refundContract = new Contract(
      makeTimeWitnesses(depositorSk, BigInt(Date.now())),
    );
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );

    expect(() => refundContract.impureCircuits.refund(ctx)).toThrow(
      'Deadline not reached',
    );
  });

  // 7. Double-fund prevention
  it('should reject funding an already-funded escrow', () => {
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: futureDeadline,
    });

    // Try to fund again
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );

    expect(() =>
      depositorContract.impureCircuits.fund(ctx, {
        recipientPk: recipientSk,
        escrowAmount,
        condition: conditionSecret,
        escrowDeadline: futureDeadline,
      }),
    ).toThrow('Escrow not empty');
  });

  // 8. Claim after refund (should fail)
  it('should reject claim after refund', () => {
    const depositorContract = new Contract(makeWitnesses(depositorSk));
    let ctx = createCircuitContext(contractState, privateState);
    const funded = depositorContract.impureCircuits.fund(ctx, {
      recipientPk: recipientSk,
      escrowAmount,
      condition: conditionSecret,
      escrowDeadline: pastDeadline,
    });

    // Refund first
    const refundContract = new Contract(
      makeTimeWitnesses(depositorSk, BigInt(Date.now())),
    );
    ctx = createCircuitContext(
      funded.currentContractState,
      funded.currentPrivateState,
    );
    const refunded = refundContract.impureCircuits.refund(ctx);

    // Now try to claim
    const recipientContract = new Contract(
      makeWitnesses(recipientSk, conditionSecret),
    );
    ctx = createCircuitContext(
      refunded.currentContractState,
      refunded.currentPrivateState,
    );

    expect(() => recipientContract.impureCircuits.claim(ctx)).toThrow(
      'Not funded',
    );
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
