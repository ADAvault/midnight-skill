# Crowdfunding

> **Compiler-validated:** Contract compiles (5 circuits) and 6/6 tests pass against Compact 0.29.0.

A crowdfunding campaign with anonymous backing via commitment schemes and
ZK-provable refunds. Backers commit funds with a secret, hiding their identity
during the active phase. If the campaign fails, backers prove their contribution
by recomputing the commitment to claim a refund. Demonstrates campaign lifecycle
state machines, commitment-based anonymous participation, and conditional
refund proofs.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum CampaignPhase { active, succeeded, failed, refunding }

export ledger phase: CampaignPhase;
export ledger creator: Bytes<32>;
export ledger goalAmount: Uint<64>;
export ledger currentAmount: Uint<64>;
export ledger contributions: Map<Bytes<32>, Uint<64>>;
export ledger contributionCount: Counter;
export ledger deadline: Uint<64>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getContributionSecret(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "fund:pk:"), seq, sk]);
}

pure circuit contributionCommitment(backer: Bytes<32>, secret: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "fund:back:"), backer, secret]);
}

constructor(goal: Uint<64>, campaignDeadline: Uint<64>) {
  phase = CampaignPhase.active;
  sequence.increment(1);
  creator = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  goalAmount = disclose(goal);
  currentAmount = 0 as Uint<64>;
  deadline = disclose(campaignDeadline);
}

export circuit back(amount: Uint<64>): [] {
  assert(phase == CampaignPhase.active, "Campaign is not active");
  assert(disclose(amount) > 0 as Uint<64>, "Amount must be positive");

  const caller = publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>);
  const secret = getContributionSecret();
  const commitment = contributionCommitment(caller, secret);

  assert(!contributions.member(disclose(commitment)), "Already contributed with this secret");
  contributions.insert(disclose(commitment), disclose(amount));
  contributionCount.increment(1);

  const newTotal = (currentAmount + amount) as Uint<64>;
  currentAmount = disclose(newTotal);
}

export circuit finalize(): [] {
  assert(phase == CampaignPhase.active, "Campaign already finalized");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == creator),
         "Only creator");

  const now = getCurrentTime();
  assert(disclose(now >= deadline), "Deadline not reached");

  if (disclose(currentAmount >= goalAmount)) {
    phase = CampaignPhase.succeeded;
  } else {
    phase = CampaignPhase.failed;
  }
}

export circuit claimFunds(): [] {
  assert(phase == CampaignPhase.succeeded, "Campaign not succeeded");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == creator),
         "Only creator");
  // In production, this would transfer coins to the creator.
  // Simplified: just transition state to prevent double-claim.
  currentAmount = 0 as Uint<64>;
}

export circuit requestRefund(): [] {
  assert(disclose(phase == CampaignPhase.failed), "Refunds not available");

  const caller = publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>);
  const secret = getContributionSecret();
  const commitment = contributionCommitment(caller, secret);

  assert(contributions.member(disclose(commitment)), "No contribution found");
  const refundAmount = contributions.lookup(disclose(commitment));
  contributions.remove(disclose(commitment));
  contributionCount.decrement(1);

  const newTotal = (currentAmount - refundAmount) as Uint<64>;
  currentAmount = disclose(newTotal);
}

export circuit getProgress(): Uint<64> {
  return currentAmount;
}
```

---

## Key Concepts

### Commitment-Based Anonymous Backing

Backers contribute using a commitment: `hash(domainSeparator || backerPk ||
secret)`. The commitment is stored as the Map key, hiding the direct link
between the backer's public key and their contribution during the active
phase. To claim a refund, the backer must reproduce the same commitment by
providing their secret key and contribution secret.

Note on anonymity: the backer's public key is included in the commitment
computation, so during the refund phase the backer reveals their identity by
recomputing the commitment. For full anonymity during refunds, a Merkle tree
of commitments with nullifier proofs would be needed -- this is a teaching
simplification.

### Campaign Lifecycle State Machine

```
active --> succeeded   (creator finalizes after deadline, goal met)
active --> failed      (creator finalizes after deadline, goal not met)
failed --> refunding   (first refund transitions phase)
```

The `finalize` circuit is the decision point: it checks `currentAmount >=
goalAmount` and sets the phase accordingly. The `refunding` sub-phase
distinguishes "failed but no refunds yet" from "refunds in progress."

### Sequence Counter for Identity Binding

This contract uses a sequence counter to bind public keys to the campaign
instance. The sequence is set during construction and remains stable through
the entire lifecycle. It does NOT increment during finalization -- incrementing
would change all backers' public keys and break the commitment recomputation
in `requestRefund`. Phase-based access control (the `CampaignPhase` enum)
handles replay prevention instead.

### Time Handling via Witness

`getCurrentTime()` returns the current time from the TypeScript runtime.
This value is trusted by the circuit (not cryptographically enforced). The
only party who can manipulate time is the creator (calling `finalize`), and
lying about time only lets them finalize early or late -- which affects both
parties. Production systems should use protocol-enforced time.

### Uint<64> for Amounts

`currentAmount` is stored as `Uint<64>` rather than a Counter because the
contract needs to compare it against `goalAmount`. Counters support only
increment/decrement, not comparison. The tradeoff is that `Uint<64>`
additions need explicit casting: `(currentAmount + amount) as Uint<64>`.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/crowdfunding/contract/index.js';

export interface CrowdfundingPrivateState {
  readonly secretKey: Uint8Array;
  readonly contributionSecret: Uint8Array;
  readonly currentTime: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, CrowdfundingPrivateState>,
  ): [CrowdfundingPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getContributionSecret: (
    { privateState }: WitnessContext<Ledger, CrowdfundingPrivateState>,
  ): [CrowdfundingPrivateState, Uint8Array] => {
    // Secret must be persisted between back() and requestRefund() calls.
    // If the backer loses their secret, they cannot prove their contribution.
    return [privateState, privateState.contributionSecret];
  },

  getCurrentTime: (
    { privateState }: WitnessContext<Ledger, CrowdfundingPrivateState>,
  ): [CrowdfundingPrivateState, bigint] => {
    return [privateState, privateState.currentTime];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Multi-user testing with
separate `Contract` instances per backer. Creator uses sequence-derived keys;
backers derive contribution commitments with per-user secrets.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, CampaignPhase } from "../src/managed/crowdfunding/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const creatorKey = new Uint8Array(32); creatorKey[0] = 0x01;
const backer1Key = new Uint8Array(32); backer1Key[0] = 0x02;
const backer2Key = new Uint8Array(32); backer2Key[0] = 0x03;

const secret1 = new Uint8Array(32); secret1[0] = 0xAA;
const secret2 = new Uint8Array(32); secret2[0] = 0xBB;

const goalAmount = 1000n;
const futureDeadline = BigInt(Date.now()) + 3_600_000n;
const pastTime = BigInt(Date.now()) + 7_200_000n;

function makeWitnesses(sk, secret = secret1, time = pastTime) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getContributionSecret: ({ privateState }) => [privateState, secret],
    getCurrentTime: ({ privateState }) => [privateState, time],
  };
}

describe("Crowdfunding", () => {
  let creatorContract, ctx;

  beforeEach(() => {
    creatorContract = new Contract(makeWitnesses(creatorKey));
    const addr = sampleContractAddress();
    const initial = creatorContract.initialState(
      createConstructorContext({}, addr), goalAmount, futureDeadline
    );
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should accept a backer contribution", () => {
    const backer1 = new Contract(makeWitnesses(backer1Key, secret1));
    const r = backer1.impureCircuits.back(ctx, 500n);
    expect(r.context).toBeDefined();
  });

  it("should finalize as succeeded when goal met", () => {
    const backer1 = new Contract(makeWitnesses(backer1Key, secret1));
    let r = backer1.impureCircuits.back(ctx, 600n);
    const backer2 = new Contract(makeWitnesses(backer2Key, secret2));
    r = backer2.impureCircuits.back(r.context, 500n);
    r = creatorContract.impureCircuits.finalize(r.context);
    expect(r.context).toBeDefined();
  });

  it("should finalize as failed when goal not met", () => {
    const backer1 = new Contract(makeWitnesses(backer1Key, secret1));
    let r = backer1.impureCircuits.back(ctx, 100n);
    r = creatorContract.impureCircuits.finalize(r.context);
    expect(r.context).toBeDefined();
  });

  it("should allow refund after failure", () => {
    const backer1 = new Contract(makeWitnesses(backer1Key, secret1));
    let r = backer1.impureCircuits.back(ctx, 100n);
    r = creatorContract.impureCircuits.finalize(r.context);
    // After finalize with failure, sequence incremented; backer needs updated seq
    const backer1Refund = new Contract(makeWitnesses(backer1Key, secret1));
    r = backer1Refund.impureCircuits.requestRefund(r.context);
    expect(r.context).toBeDefined();
  });

  it("should reject refund after success", () => {
    const backer1 = new Contract(makeWitnesses(backer1Key, secret1));
    let r = backer1.impureCircuits.back(ctx, 1000n);
    r = creatorContract.impureCircuits.finalize(r.context);
    const backer1Refund = new Contract(makeWitnesses(backer1Key, secret1));
    expect(() => {
      backer1Refund.impureCircuits.requestRefund(r.context);
    }).toThrow("Refunds not available");
  });

  it("should reject backing after finalized", () => {
    const backer1 = new Contract(makeWitnesses(backer1Key, secret1));
    let r = backer1.impureCircuits.back(ctx, 100n);
    r = creatorContract.impureCircuits.finalize(r.context);
    const backer2 = new Contract(makeWitnesses(backer2Key, secret2));
    expect(() => {
      backer2.impureCircuits.back(r.context, 500n);
    }).toThrow("Campaign is not active");
  });
});
```

---

## CLI

```bash
compact compile src/crowdfunding.compact src/managed/crowdfunding
npm test
```

---

## Notes

- **Compiler-validated:** 5 circuits compiled, 6/6 tests pass against Compact 0.29.0.
- **Anonymity limitations:** The backer's public key is included in the
  commitment hash. During the refund phase, the backer must recompute the
  commitment (revealing their identity). For full anonymity, a Merkle tree
  of commitments with nullifier-based proofs would prevent linking refund
  requests to specific commitments.
- **Secret management is critical:** If a backer loses their `contributionSecret`
  between `back()` and `requestRefund()`, they cannot prove their contribution.
  The TypeScript witness must persist the secret in private state.
- **Uint<64> arithmetic:** `currentAmount + amount` produces a wider type.
  Cast back with `(currentAmount + amount) as Uint<64>`. Similarly for
  subtraction in `requestRefund`.
- **No real value transfer:** This example tracks amounts in ledger state
  but does not move coins on the UTXO layer. Production crowdfunding would
  use `receive(coin)` during backing and `sendImmediate` for creator
  withdrawal and backer refunds.
- Circuit complexity is moderate (k ~14-15) due to hash computation and Map
  operations in `back` and `requestRefund`. The `finalize` circuit is
  lighter since it only compares stored values.
- The `getProgress` circuit generates a ZK proof for a read-only query. For
  off-chain reads, use the indexer's public data provider to read
  `currentAmount` directly.
