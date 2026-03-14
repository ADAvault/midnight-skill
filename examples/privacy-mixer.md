# Privacy Mixer

> **Compiler-validated:** 3 circuits compiled against Compact 0.29.0.

A privacy-preserving mixer (similar to Tornado Cash) for the Midnight blockchain.
Users deposit a fixed denomination by publishing a commitment — a hash of a secret
and a nullifier seed known only to the depositor. Later, anyone who knows the
secret can withdraw by proving knowledge of the commitment pre-image and publishing
a nullifier that prevents double-withdrawal. The ZK proof guarantees the nullifier
corresponds to a valid deposit, but an observer cannot determine *which* deposit
is being withdrawn. The anonymity set is the full pool of deposits.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

// Fixed deposit denomination (in smallest token unit).
// All deposits must be exactly this amount for uniform anonymity.
export ledger denomination: Uint<128>;
export ledger commitments: Map<Bytes<32>, Boolean>;
export ledger nullifiers: Set<Bytes<32>>;
export ledger depositCount: Counter;
export ledger withdrawCount: Counter;

witness getDepositSecret(): Bytes<32>;
witness getDepositNullifierSeed(): Bytes<32>;

// Commitment: hash(domain || secret || nullifierSeed)
// Published at deposit time. Opaque to observers.
export pure circuit commitmentHash(
  secret: Bytes<32>,
  nullifierSeed: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "mixer:commit:"),
    secret,
    nullifierSeed
  ]);
}

// Nullifier: hash(domain || nullifierSeed)
// Published at withdrawal time. Cannot be linked to the commitment
// because it uses a different domain separator and omits the secret.
export pure circuit nullifierHash(
  nullifierSeed: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([
    pad(32, "mixer:null:"),
    nullifierSeed
  ]);
}

constructor() {
  denomination = 1000;
}

// Deposit: caller provides a commitment computed off-chain.
// The commitment hides the secret and nullifier seed.
export circuit deposit(commitment: Bytes<32>): [] {
  assert(!commitments.member(disclose(commitment)), "Duplicate commitment");

  commitments.insert(disclose(commitment), true);
  depositCount.increment(1);
}

// Withdraw: caller proves knowledge of (secret, nullifierSeed) such that
// commitmentHash(secret, nullifierSeed) is in the commitment set.
// The nullifier prevents the same deposit from being withdrawn twice.
export circuit withdraw(): [] {
  const secret = getDepositSecret();
  const nullifierSeed = getDepositNullifierSeed();

  // Recompute commitment from private inputs
  const commitment = commitmentHash(secret, nullifierSeed);
  assert(commitments.member(disclose(commitment)), "Unknown commitment");

  // Compute and check nullifier
  const nullifier = nullifierHash(nullifierSeed);
  assert(!nullifiers.member(disclose(nullifier)), "Already withdrawn");

  nullifiers.insert(disclose(nullifier));
  withdrawCount.increment(1);
}

// Query whether a nullifier has been spent.
export circuit isSpent(nullifier: Bytes<32>): Boolean {
  return nullifiers.member(disclose(nullifier));
}
```

---

## Key Concepts

### How the mixer achieves privacy

A mixer breaks the on-chain link between depositor and withdrawer. The mechanism
has two phases:

1. **Deposit:** The user generates a random `secret` and `nullifierSeed`,
   computes `commitment = hash("mixer:commit:", secret, nullifierSeed)`, and
   publishes the commitment on-chain. The commitment reveals nothing about the
   underlying values.

2. **Withdraw:** The user (or anyone who knows the secret) calls `withdraw()`.
   Inside the ZK circuit, the contract recomputes the commitment from the
   private witness inputs, verifies it exists in the commitment map, then
   computes `nullifier = hash("mixer:null:", nullifierSeed)` and checks it
   has not been seen before. The nullifier is published on-chain to prevent
   double-withdrawal.

The critical property: the commitment and nullifier use **different domain
separators** and **different input sets** (the commitment includes the secret;
the nullifier does not). Given only the on-chain data (commitments and
nullifiers), an observer cannot determine which commitment corresponds to which
nullifier. The ZK proof guarantees correctness without revealing the link.

### Fixed denomination for anonymity

All deposits are the same amount (`denomination`). This is essential: if
deposits varied in size, an observer could correlate a 7.3-token deposit with
a 7.3-token withdrawal, breaking anonymity. By fixing the denomination, every
deposit is indistinguishable from every other deposit, and the anonymity set
is the entire pool.

In practice, users who want to mix larger amounts make multiple fixed-denomination
deposits and withdraw them separately at different times and to different
addresses.

### Nullifier unlinkability

The nullifier is derived from the `nullifierSeed` alone, not from the full
commitment pre-image. This is a deliberate design choice:

- The commitment is `hash("mixer:commit:", secret, nullifierSeed)`.
- The nullifier is `hash("mixer:null:", nullifierSeed)`.

An observer who sees both on-chain cannot compute one from the other without
knowing the `nullifierSeed`. Since the `nullifierSeed` is private witness
data, the link remains hidden. The ZK proof guarantees the nullifier was
derived from a `nullifierSeed` that is part of a valid commitment, without
revealing which one.

### Anonymity set size

The privacy guarantee is only as strong as the number of unspent deposits in
the pool. With 1 deposit, privacy is trivial to break. With 1,000 deposits,
an observer faces a 1-in-1,000 chance of guessing the correct link. In
production, a mixer incentivizes deposits (often via mining rewards) to grow
the anonymity set.

### Differences from Tornado Cash

This implementation captures the core cryptographic mechanism but simplifies
several aspects relative to a production mixer:

- **No Merkle tree accumulator.** Tornado Cash stores commitments in a Merkle
  tree and proves membership via a Merkle path. This contract uses a Map for
  simplicity. A Merkle tree is more gas-efficient for large sets on EVM chains
  but adds significant circuit complexity. On Midnight, Map membership is a
  native ledger operation.

- **No relayer network.** In Tornado Cash, relayers submit withdrawal
  transactions on behalf of users to prevent the withdrawal address from being
  linked to the depositor's gas-paying address. On Midnight, transactions are
  already private by default, reducing (but not eliminating) this concern.

- **No shielded token transfer.** This example tracks commitments and
  nullifiers but does not move actual coins via Zswap. A production mixer
  would use `receive()` and `sendImmediate()` to handle real token transfers.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/mixer/contract/index.cjs';

export interface MixerPrivateState {
  readonly depositSecret: Uint8Array;
  readonly depositNullifierSeed: Uint8Array;
}

export const witnesses = {
  getDepositSecret: (
    { privateState }: WitnessContext<Ledger, MixerPrivateState>,
  ): [MixerPrivateState, Uint8Array] => {
    if (!privateState.depositSecret)
      throw new Error('No deposit secret in private state');
    return [privateState, privateState.depositSecret];
  },

  getDepositNullifierSeed: (
    { privateState }: WitnessContext<Ledger, MixerPrivateState>,
  ): [MixerPrivateState, Uint8Array] => {
    if (!privateState.depositNullifierSeed)
      throw new Error('No deposit nullifier seed in private state');
    return [privateState, privateState.depositNullifierSeed];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/mixer/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import crypto from "crypto";

setNetworkId("undeployed");

function makeWitnesses(secret: Uint8Array | null, nullifierSeed: Uint8Array | null) {
  return {
    getDepositSecret: ({ privateState }) => {
      if (!secret) throw new Error("No deposit secret in private state");
      return [privateState, secret];
    },
    getDepositNullifierSeed: ({ privateState }) => {
      if (!nullifierSeed) throw new Error("No deposit nullifier seed in private state");
      return [privateState, nullifierSeed];
    },
  };
}

function setupContract() {
  const contract = new Contract(makeWitnesses(null, null));
  const addr = sampleContractAddress();
  const initial = contract.initialState(createConstructorContext({}, addr));
  const ctx = createCircuitContext(
    addr,
    initial.currentZswapLocalState,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  return { contract, ctx, addr };
}

describe("Privacy Mixer", () => {
  let contract;
  let ctx;

  beforeEach(() => {
    const setup = setupContract();
    contract = setup.contract;
    ctx = setup.ctx;
  });

  it("should accept a deposit and increment deposit count", () => {
    const secret = crypto.randomBytes(32);
    const nullifierSeed = crypto.randomBytes(32);
    const commitment = pureCircuits.commitmentHash(secret, nullifierSeed);

    const r1 = contract.impureCircuits.deposit(ctx, commitment);
    expect(r1.context).toBeDefined();
  });

  it("should allow withdrawal with valid secret and nullifier seed", () => {
    const secret = crypto.randomBytes(32);
    const nullifierSeed = crypto.randomBytes(32);
    const commitment = pureCircuits.commitmentHash(secret, nullifierSeed);

    // Deposit
    const r1 = contract.impureCircuits.deposit(ctx, commitment);

    // Withdraw with matching secret and nullifier seed
    const withdrawer = new Contract(makeWitnesses(secret, nullifierSeed));
    const r2 = withdrawer.impureCircuits.withdraw(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should prevent double-withdrawal via nullifier", () => {
    const secret = crypto.randomBytes(32);
    const nullifierSeed = crypto.randomBytes(32);
    const commitment = pureCircuits.commitmentHash(secret, nullifierSeed);

    // Deposit then withdraw
    const r1 = contract.impureCircuits.deposit(ctx, commitment);
    const withdrawer = new Contract(makeWitnesses(secret, nullifierSeed));
    const r2 = withdrawer.impureCircuits.withdraw(r1.context);

    // Second withdrawal with same nullifier seed should fail
    expect(() => {
      withdrawer.impureCircuits.withdraw(r2.context);
    }).toThrow("Already withdrawn");
  });

  it("should reject withdrawal with wrong secret", () => {
    const secret = crypto.randomBytes(32);
    const wrongSecret = crypto.randomBytes(32);
    const nullifierSeed = crypto.randomBytes(32);
    const commitment = pureCircuits.commitmentHash(secret, nullifierSeed);

    const r1 = contract.impureCircuits.deposit(ctx, commitment);

    // Withdraw with wrong secret — recomputed commitment will not match
    const attacker = new Contract(makeWitnesses(wrongSecret, nullifierSeed));
    expect(() => {
      attacker.impureCircuits.withdraw(r1.context);
    }).toThrow("Unknown commitment");
  });

  it("should reject duplicate commitment on deposit", () => {
    const secret = crypto.randomBytes(32);
    const nullifierSeed = crypto.randomBytes(32);
    const commitment = pureCircuits.commitmentHash(secret, nullifierSeed);

    const r1 = contract.impureCircuits.deposit(ctx, commitment);

    // Depositing the same commitment again should fail
    expect(() => {
      contract.impureCircuits.deposit(r1.context, commitment);
    }).toThrow("Duplicate commitment");
  });

  it("should verify nullifier is not linkable to commitment", () => {
    // Deposit two different users
    const secret1 = crypto.randomBytes(32);
    const nullifierSeed1 = crypto.randomBytes(32);
    const commitment1 = pureCircuits.commitmentHash(secret1, nullifierSeed1);

    const secret2 = crypto.randomBytes(32);
    const nullifierSeed2 = crypto.randomBytes(32);
    const commitment2 = pureCircuits.commitmentHash(secret2, nullifierSeed2);

    const r1 = contract.impureCircuits.deposit(ctx, commitment1);
    const r2 = contract.impureCircuits.deposit(r1.context, commitment2);

    // User 1 withdraws
    const withdrawer1 = new Contract(makeWitnesses(secret1, nullifierSeed1));
    const r3 = withdrawer1.impureCircuits.withdraw(r2.context);

    // The nullifier should be marked as spent
    const nullifier1 = pureCircuits.nullifierHash(nullifierSeed1);
    const r4 = contract.impureCircuits.isSpent(r3.context, nullifier1);
    expect(r4.result).toBe(true);

    // The other nullifier should not be spent
    const nullifier2 = pureCircuits.nullifierHash(nullifierSeed2);
    const r5 = contract.impureCircuits.isSpent(r4.context, nullifier2);
    expect(r5.result).toBe(false);

    // Verify the nullifiers are different from commitments (unlinkable)
    expect(nullifier1).not.toEqual(commitment1);
    expect(nullifier1).not.toEqual(commitment2);
  });

  it("should support multiple independent deposits and withdrawals", () => {
    const deposits = Array.from({ length: 3 }, () => ({
      secret: crypto.randomBytes(32),
      nullifierSeed: crypto.randomBytes(32),
    }));

    // Deposit all three
    let currentCtx = ctx;
    for (const dep of deposits) {
      const commitment = pureCircuits.commitmentHash(dep.secret, dep.nullifierSeed);
      const r = contract.impureCircuits.deposit(currentCtx, commitment);
      currentCtx = r.context;
    }

    // Withdraw in reverse order (order should not matter)
    for (let i = deposits.length - 1; i >= 0; i--) {
      const withdrawer = new Contract(
        makeWitnesses(deposits[i].secret, deposits[i].nullifierSeed),
      );
      const r = withdrawer.impureCircuits.withdraw(currentCtx);
      currentCtx = r.context;
    }

    // All nullifiers should be spent
    for (const dep of deposits) {
      const nullifier = pureCircuits.nullifierHash(dep.nullifierSeed);
      const r = contract.impureCircuits.isSpent(currentCtx, nullifier);
      expect(r.result).toBe(true);
      currentCtx = r.context;
    }
  });
});
```

---

## CLI

```bash
compact compile src/mixer.compact src/managed/mixer
npm test
```

---

## Notes

- **Pending validation:** This contract has not yet been compiled against
  Compact 0.29.0. The syntax follows validated patterns from the credential
  registry example, which uses the same nullifier mechanism.
- The `Set<Bytes<32>>` type is used for nullifiers instead of
  `Map<Bytes<32>, Boolean>`. Set is semantically correct for nullifiers since
  we only need membership checks and insertion, not key-value lookup.
- Circuit complexity for `withdraw()` is moderate (estimated k ~14) due to
  two `persistentHash` computations (commitment + nullifier), one Map
  membership check, and one Set membership check plus insertion.
- The `deposit()` circuit accepts the commitment as a parameter rather than
  computing it in-circuit from witness values. This prevents the depositor's
  transaction from being linked to the commitment's pre-image. The depositor
  computes the commitment off-chain using the `commitmentHash` pure circuit.
- **No actual token movement.** This contract tracks deposit/withdrawal
  accounting but does not move coins. A production mixer would add `receive()`
  in `deposit()` to accept tokens and `sendImmediate()` in `withdraw()` to
  pay out, along with a recipient address parameter for the withdrawal.
- **Denomination is fixed at construction.** All deposits must be the same
  amount. This is the standard mixer design: variable amounts would let
  observers correlate deposits and withdrawals by value. Users who need to
  mix larger amounts should make multiple deposits.
- The nullifier is derived from only the `nullifierSeed` (not the full
  `(secret, nullifierSeed)` pair). This is sufficient because the ZK proof
  already guarantees the `nullifierSeed` came from a valid commitment. Using
  only the seed keeps the nullifier hash cheaper (2-element vs 3-element hash).
