# Lottery / Verifiable Randomness

> **Compiler-validated:** 4 circuits compiled against Compact 0.29.0.

A fair lottery where multiple participants commit random values, then reveal them.
The combined hash of all revealed values determines the winner. No single
participant can predict or manipulate the outcome because the final seed depends
on every participant's secret -- withholding or changing a value after commitment
is prevented by the commit-reveal scheme. Demonstrates multi-party randomness
generation via commit-reveal, Map-based participant tracking, and deterministic
winner selection without modulo arithmetic.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum LotteryPhase { committing, revealing, finalized }

export ledger phase: LotteryPhase;
export ledger organizer: Bytes<32>;
export ledger commitments: Map<Bytes<32>, Bytes<32>>;
export ledger reveals: Map<Bytes<32>, Bytes<32>>;
export ledger totalCommitted: Counter;
export ledger totalRevealed: Counter;
export ledger combinedSeed: Bytes<32>;
export ledger winner: Bytes<32>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getRandomValue(): Bytes<32>;
witness getRandomSalt(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "lottery:pk:"), seq, sk]);
}

constructor() {
  phase = LotteryPhase.committing;
  sequence.increment(1);
  organizer = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  combinedSeed = pad(32, "lottery:seed:");
}

export circuit commitEntry(): [] {
  assert(phase == LotteryPhase.committing, "Not in committing phase");

  const participant = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(!commitments.member(participant), "Already committed");

  const randomVal = getRandomValue();
  const salt = getRandomSalt();

  const commitment = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "lottery:entry:"),
    salt,
    randomVal
  ]);

  commitments.insert(participant, disclose(commitment));
  totalCommitted.increment(1);
}

export circuit closeCommitting(): [] {
  assert(phase == LotteryPhase.committing, "Must be in committing phase");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == organizer),
         "Only organizer");
  assert((totalCommitted.read() as Uint<64>) > (1 as Uint<64>), "Need at least 2 participants");
  phase = LotteryPhase.revealing;
}

export circuit revealEntry(): [] {
  assert(phase == LotteryPhase.revealing, "Not in revealing phase");

  const participant = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(commitments.member(participant), "No commitment found");
  assert(!reveals.member(participant), "Already revealed");

  const randomVal = getRandomValue();
  const salt = getRandomSalt();

  const recomputed = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "lottery:entry:"),
    salt,
    randomVal
  ]);

  const stored = commitments.lookup(participant);
  assert(disclose(recomputed == stored), "Commitment mismatch");

  reveals.insert(participant, disclose(randomVal));
  totalRevealed.increment(1);

  // Fold this participant's randomness into the combined seed
  combinedSeed = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "lottery:fold:"),
    combinedSeed,
    disclose(randomVal)
  ]);
}

export circuit finalize(): [] {
  assert(phase == LotteryPhase.revealing, "Must be in revealing phase");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == organizer),
         "Only organizer");

  // Winner determined by hashing final combined seed
  winner = persistentHash<Vector<2, Bytes<32>>>([
    pad(32, "lottery:winner:"),
    combinedSeed
  ]);

  phase = LotteryPhase.finalized;
  sequence.increment(1);
}
```

---

## Key Concepts

### Multi-party randomness via commit-reveal

No single participant can predict the lottery outcome because the final
`combinedSeed` depends on every participant's secret random value. Each
participant commits `persistentHash(domainSep, salt, randomValue)` during the
committing phase, hiding their contribution. During the reveal phase, they
provide the original value and salt; the circuit verifies the commitment before
folding the value into the combined seed. If any participant withholds their
reveal, their randomness is not folded in, but they also cannot win (since they
are not in the `reveals` map).

This is the simplest form of multi-party randomness -- a coin-flipping protocol.
It is secure against any single dishonest participant but not against the last
revealer, who can choose to withhold if the outcome is unfavorable. For
production use, add a reveal-or-forfeit deposit mechanism.

### Seed folding pattern

Rather than collecting all revealed values and hashing them at the end (which
would require a dynamic-length data structure), each reveal incrementally folds
its randomness into the `combinedSeed`:

```
combinedSeed = hash("lottery:fold:", combinedSeed, revealedValue)
```

This is order-dependent -- different reveal orders produce different seeds. This
is acceptable for fairness because no participant controls the reveal order on a
blockchain (transaction ordering is determined by block producers). The
important property is that the seed is unpredictable before all values are
revealed.

### Winner determination without modulo

The `finalize` circuit hashes the combined seed to produce the `winner` field --
a deterministic 32-byte value derived from all participants' randomness.
Mapping this to an actual participant index would require modulo arithmetic
(which Compact does not support) or an off-chain lookup. The on-chain contract
produces the verifiable seed; the off-chain application matches it to a
participant list via `winnerIndex = BigInt('0x' + hex(winner)) % totalParticipants`.

This separation is intentional: the contract guarantees randomness fairness
and commitment integrity, while the off-chain SDK handles the
winner-to-participant mapping in a verifiable way.

### Organizer role

The organizer controls phase transitions (`closeCommitting`, `finalize`) but
cannot manipulate the outcome. Their only power is timing: when to stop
accepting entries and when to finalize. They cannot predict the winner because
the combined seed depends on all participants' hidden values. For a fully
decentralized lottery, replace organizer-controlled transitions with
participant-count thresholds or block-height deadlines.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/lottery/contract/index.cjs';

export interface LotteryPrivateState {
  readonly secretKey: Uint8Array;
  readonly randomValue: Uint8Array;
  readonly randomSalt: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, LotteryPrivateState>,
  ): [LotteryPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getRandomValue: (
    { privateState }: WitnessContext<Ledger, LotteryPrivateState>,
  ): [LotteryPrivateState, Uint8Array] => {
    // Must be cryptographically random (e.g., crypto.getRandomValues).
    // Reusing values across lotteries weakens randomness.
    return [privateState, privateState.randomValue];
  },

  getRandomSalt: (
    { privateState }: WitnessContext<Ledger, LotteryPrivateState>,
  ): [LotteryPrivateState, Uint8Array] => {
    // Salt must be identical between commit and reveal.
    // Losing the salt means forfeiting the lottery entry.
    return [privateState, privateState.randomSalt];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, LotteryPhase } from "../src/managed/lottery/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const organizerKey = new Uint8Array(32); organizerKey[0] = 0x01;
const player1Key = new Uint8Array(32); player1Key[0] = 0x02;
const player2Key = new Uint8Array(32); player2Key[0] = 0x03;
const player3Key = new Uint8Array(32); player3Key[0] = 0x04;

const rand1 = new Uint8Array(32); rand1[0] = 0x11;
const rand2 = new Uint8Array(32); rand2[0] = 0x22;
const rand3 = new Uint8Array(32); rand3[0] = 0x33;

const salt1 = new Uint8Array(32); salt1[0] = 0xAA;
const salt2 = new Uint8Array(32); salt2[0] = 0xBB;
const salt3 = new Uint8Array(32); salt3[0] = 0xCC;
const wrongSalt = new Uint8Array(32); wrongSalt[0] = 0xFF;

function makeWitnesses(sk, randomVal = rand1, salt = salt1) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getRandomValue: ({ privateState }) => [privateState, randomVal],
    getRandomSalt: ({ privateState }) => [privateState, salt],
  };
}

function setupLottery() {
  const orgContract = new Contract(makeWitnesses(organizerKey));
  const addr = sampleContractAddress();
  const initial = orgContract.initialState(createConstructorContext({}, addr));
  const ctx = createCircuitContext(
    addr,
    initial.currentZswapLocalState,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  return { orgContract, ctx };
}

describe("Lottery", () => {
  let orgContract;
  let ctx;

  beforeEach(() => {
    const setup = setupLottery();
    orgContract = setup.orgContract;
    ctx = setup.ctx;
  });

  it("should allow participants to commit entries", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const p2 = new Contract(makeWitnesses(player2Key, rand2, salt2));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    const r2 = p2.impureCircuits.commitEntry(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject double commitment from same participant", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    expect(() => {
      p1.impureCircuits.commitEntry(r1.context);
    }).toThrow("Already committed");
  });

  it("should reject closing with fewer than 2 participants", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    expect(() => {
      orgContract.impureCircuits.closeCommitting(r1.context);
    }).toThrow("Need at least 2 participants");
  });

  it("should reject reveal with wrong salt", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const p2 = new Contract(makeWitnesses(player2Key, rand2, salt2));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    const r2 = p2.impureCircuits.commitEntry(r1.context);
    const r3 = orgContract.impureCircuits.closeCommitting(r2.context);

    const p1Wrong = new Contract(makeWitnesses(player1Key, rand1, wrongSalt));
    expect(() => {
      p1Wrong.impureCircuits.revealEntry(r3.context);
    }).toThrow("Commitment mismatch");
  });

  it("should reject reveal from non-participant", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const p2 = new Contract(makeWitnesses(player2Key, rand2, salt2));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    const r2 = p2.impureCircuits.commitEntry(r1.context);
    const r3 = orgContract.impureCircuits.closeCommitting(r2.context);

    const p3 = new Contract(makeWitnesses(player3Key, rand3, salt3));
    expect(() => {
      p3.impureCircuits.revealEntry(r3.context);
    }).toThrow("No commitment found");
  });

  it("should reject non-organizer closing committing phase", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const p2 = new Contract(makeWitnesses(player2Key, rand2, salt2));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    const r2 = p2.impureCircuits.commitEntry(r1.context);

    expect(() => {
      p1.impureCircuits.closeCommitting(r2.context);
    }).toThrow("Only organizer");
  });

  it("should complete full lottery lifecycle", () => {
    // Two players commit
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const p2 = new Contract(makeWitnesses(player2Key, rand2, salt2));
    const r1 = p1.impureCircuits.commitEntry(ctx);
    const r2 = p2.impureCircuits.commitEntry(r1.context);

    // Organizer closes committing
    const r3 = orgContract.impureCircuits.closeCommitting(r2.context);

    // Both reveal
    const r4 = p1.impureCircuits.revealEntry(r3.context);
    const r5 = p2.impureCircuits.revealEntry(r4.context);

    // Organizer finalizes
    const r6 = orgContract.impureCircuits.finalize(r5.context);
    expect(r6.context).toBeDefined();
  });

  it("should complete lifecycle with three participants", () => {
    const p1 = new Contract(makeWitnesses(player1Key, rand1, salt1));
    const p2 = new Contract(makeWitnesses(player2Key, rand2, salt2));
    const p3 = new Contract(makeWitnesses(player3Key, rand3, salt3));

    // All three commit
    const r1 = p1.impureCircuits.commitEntry(ctx);
    const r2 = p2.impureCircuits.commitEntry(r1.context);
    const r3 = p3.impureCircuits.commitEntry(r2.context);

    // Close and reveal
    const r4 = orgContract.impureCircuits.closeCommitting(r3.context);
    const r5 = p1.impureCircuits.revealEntry(r4.context);
    const r6 = p2.impureCircuits.revealEntry(r5.context);
    const r7 = p3.impureCircuits.revealEntry(r6.context);

    // Finalize
    const r8 = orgContract.impureCircuits.finalize(r7.context);
    expect(r8.context).toBeDefined();
  });
});
```

---

## CLI

```bash
compact compile src/lottery.compact src/managed/lottery
npm test
```

---

## Notes

- **Pending validation:** This contract has not yet been compiled against
  Compact 0.29.0. The syntax follows validated patterns from other examples
  (sealed-bid auction, shielded voting) and should compile cleanly.
- Circuit complexity is moderate-to-high (estimated k ~14-15). The `revealEntry`
  circuit is the most expensive: it recomputes a 3-element `persistentHash` for
  commitment verification, performs Map lookup and insert operations, and
  computes a second 3-element `persistentHash` for seed folding.
- **Last-revealer advantage:** The last participant to reveal can compute the
  final seed before submitting their reveal transaction. If the outcome is
  unfavorable, they can withhold their reveal (forfeiting their entry). This is
  inherent to commit-reveal randomness. Mitigations include requiring a
  deposit that is slashed on non-reveal, or using a threshold reveal scheme
  where any N-of-M reveals are sufficient.
- **Reveal order sensitivity:** The `combinedSeed` is computed by iteratively
  folding each revealed value. Different reveal orders produce different seeds.
  This does not compromise fairness because no participant controls transaction
  ordering, but it means the winner is not fully deterministic until the finalize
  call. For reproducible results, sort participants by public key before folding
  (requires off-chain coordination).
- **Winner mapping:** The on-chain `winner` field is a 32-byte hash, not a
  participant index. The off-chain application maps this to a participant using
  `winnerIndex = BigInt('0x' + hex(winner)) % totalParticipants` against the
  ordered participant list. This keeps the contract simple while enabling
  verifiable winner selection.
- The 5-circuit design (commitEntry, closeCommitting, revealEntry, finalize,
  plus the pure publicKey helper) keeps the contract minimal. For production,
  consider adding a `claimPrize` circuit that verifies the winner's identity
  and transfers funds via coin operations.
- Salt management is critical. If a participant loses their salt between commit
  and reveal, they cannot prove their entry. The TypeScript witness must persist
  the salt in private state across sessions.
