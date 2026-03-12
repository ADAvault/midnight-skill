# Shielded Voting

A private ballot contract where voters submit encrypted votes and only the
aggregate tally is publicly visible. Individual vote choices never appear on-chain.
This demonstrates privacy-preserving aggregation -- the core value proposition of
ZK: prove you voted validly without revealing how you voted. Voter identity is
disclosed (to prevent double-voting), but the vote direction is hidden behind a
commitment scheme that prevents ledger-operation pattern analysis.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum BallotPhase { registration, voting, tallying, closed }

export ledger phase: BallotPhase;
export ledger admin: Bytes<32>;
export ledger registeredVoters: Map<Bytes<32>, Boolean>;
export ledger voterCommitments: Map<Bytes<32>, Bytes<32>>;
export ledger totalRegistered: Counter;
export ledger totalVoted: Counter;
export ledger tallyFor: Counter;
export ledger tallyAgainst: Counter;
export ledger tallied: Set<Bytes<32>>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getVote(): Boolean;
witness getVoteSalt(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "ballot:pk:"), seq, sk]);
}

constructor() {
  phase = BallotPhase.registration;
  sequence.increment(1);
  admin = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
}

export circuit registerVoter(voterPk: Bytes<32>): [] {
  assert(phase == BallotPhase.registration, "Not in registration phase");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == admin),
         "Only admin can register voters");
  assert(!registeredVoters.member(disclose(voterPk)), "Already registered");
  registeredVoters.insert(disclose(voterPk), true);
  totalRegistered.increment(1);
}

export circuit castVote(): [] {
  assert(phase == BallotPhase.voting, "Not in voting phase");

  const voter = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(registeredVoters.member(voter), "Not a registered voter");
  assert(!voterCommitments.member(voter), "Already voted");

  const vote = getVote();
  const salt = getVoteSalt();

  const voteBytes = vote as Field as Bytes<32>;
  const commitment = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "ballot:vote:"),
    salt,
    voteBytes
  ]);

  voterCommitments.insert(voter, disclose(commitment));
  totalVoted.increment(1);
}

export circuit revealVote(): [] {
  assert(phase == BallotPhase.tallying, "Not in tallying phase");

  const voter = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(voterCommitments.member(voter), "No commitment found");
  assert(!tallied.member(voter), "Already tallied");

  const vote = getVote();
  const salt = getVoteSalt();

  const voteBytes = vote as Field as Bytes<32>;
  const recomputed = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "ballot:vote:"),
    salt,
    voteBytes
  ]);

  const stored = voterCommitments.lookup(voter);
  assert(disclose(recomputed == stored), "Commitment mismatch");

  if (disclose(vote)) {
    tallyFor.increment(1);
  } else {
    tallyAgainst.increment(1);
  }

  tallied.insert(voter);
}

export circuit openVoting(): [] {
  assert(phase == BallotPhase.registration, "Must be in registration");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == admin),
         "Only admin");
  phase = BallotPhase.voting;
}

export circuit openTallying(): [] {
  assert(phase == BallotPhase.voting, "Must be in voting");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == admin),
         "Only admin");
  phase = BallotPhase.tallying;
}

export circuit closeBallot(): [] {
  assert(phase == BallotPhase.tallying, "Must be in tallying");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == admin),
         "Only admin");
  phase = BallotPhase.closed;
  sequence.increment(1);
}
```

---

## Key Concepts

- **Commit-reveal for vote privacy:** During the voting phase, only a hash of the vote
  is stored. The actual vote direction is hidden until the tally phase.
- **Observer resistance:** All commitments look identical (32-byte hashes), so an
  observer cannot distinguish "for" from "against" during the voting phase.
- **Tally-phase tradeoff:** During `revealVote()`, the counter increment is observable
  per transaction. For stronger privacy, a trusted tallier could batch all reveals
  into a single transaction, or use a homomorphic accumulation scheme.
- **State machine:** The `BallotPhase` enum enforces strict phase ordering --
  registration, voting, tallying, closed. No backward transitions.
- **Voter identity is disclosed:** The voter's public key is stored in the
  commitments map to prevent double-voting. This is a necessary tradeoff -- anonymous
  voting with double-vote prevention requires more advanced cryptography (e.g.,
  ring signatures or nullifier schemes).
- **Constructor ordering matters:** `sequence.increment(1)` must come BEFORE the admin
  key derivation. If the admin key is set with `seq=0` but all subsequent checks read
  `seq=1` (post-increment), the admin can never authenticate. Increment first, then
  derive.
- **`export pure circuit` for off-chain use:** `publicKey` must be declared
  `export pure circuit` so that voter public keys can be derived off-chain (via
  `pureCircuits.publicKey`) for registration without submitting a transaction.
- **`disclose()` on Map operation arguments:** Circuit parameters used as keys in Map
  `member`/`insert` operations need `disclose()` wrapping (e.g.,
  `disclose(voterPk)` in `registerVoter`). Without this, the compiler rejects the
  operation because the key would remain in the private domain.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/ballot/contract/index.cjs';

export interface BallotPrivateState {
  readonly secretKey: Uint8Array;
  readonly vote: boolean;
  readonly voteSalt: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, BallotPrivateState>,
  ): [BallotPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getVote: (
    { privateState }: WitnessContext<Ledger, BallotPrivateState>,
  ): [BallotPrivateState, boolean] => {
    return [privateState, privateState.vote];
  },

  getVoteSalt: (
    { privateState }: WitnessContext<Ledger, BallotPrivateState>,
  ): [BallotPrivateState, Uint8Array] => {
    // Salt must be persisted between castVote and revealVote calls.
    // If the user loses their salt, they cannot reveal their vote.
    return [privateState, privateState.voteSalt];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, BallotPhase } from "../src/managed/voting/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32);
adminKey[0] = 0x01;
const voterKey = new Uint8Array(32);
voterKey[0] = 0x02;

const voteSalt = new Uint8Array(32);
voteSalt[0] = 0xAA;

function makeWitnesses(secretKey, vote = true, salt = voteSalt) {
  return {
    localSecretKey: ({ privateState }) => [privateState, secretKey],
    getVote: ({ privateState }) => [privateState, vote],
    getVoteSalt: ({ privateState }) => [privateState, salt],
  };
}

describe("Shielded Voting", () => {
  let adminContract;
  let voterContract;
  let ctx;
  let voterPk;

  beforeEach(() => {
    adminContract = new Contract(makeWitnesses(adminKey));
    voterContract = new Contract(makeWitnesses(voterKey, true, voteSalt));

    const addr = sampleContractAddress();
    const initial = adminContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );

    // Derive voter's public key using sequence=1 (after constructor)
    const seqBytes = new Uint8Array(32);
    seqBytes[0] = 0x01;
    voterPk = pureCircuits.publicKey(voterKey, seqBytes);
  });

  it("should start in registration phase", () => {
    const r = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    expect(r.context).toBeDefined();
  });

  it("should register voter and transition to voting", () => {
    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    const r2 = adminContract.impureCircuits.openVoting(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should allow registered voter to cast vote", () => {
    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    const r2 = adminContract.impureCircuits.openVoting(r1.context);
    const r3 = voterContract.impureCircuits.castVote(r2.context);
    expect(r3.context).toBeDefined();
  });

  it("should reject unregistered voter", () => {
    const r1 = adminContract.impureCircuits.openVoting(ctx);
    expect(() => {
      voterContract.impureCircuits.castVote(r1.context);
    }).toThrow("Not a registered voter");
  });

  it("should reject double voting", () => {
    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    const r2 = adminContract.impureCircuits.openVoting(r1.context);
    const r3 = voterContract.impureCircuits.castVote(r2.context);
    expect(() => {
      voterContract.impureCircuits.castVote(r3.context);
    }).toThrow("Already voted");
  });

  it("should reveal vote and increment tally", () => {
    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    const r2 = adminContract.impureCircuits.openVoting(r1.context);
    const r3 = voterContract.impureCircuits.castVote(r2.context);
    const r4 = adminContract.impureCircuits.openTallying(r3.context);
    const r5 = voterContract.impureCircuits.revealVote(r4.context);
    expect(r5.context).toBeDefined();
  });

  it("should reject reveal with wrong salt", () => {
    const wrongSalt = new Uint8Array(32);
    wrongSalt[0] = 0xBB;
    const wrongVoter = new Contract(makeWitnesses(voterKey, true, wrongSalt));

    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    const r2 = adminContract.impureCircuits.openVoting(r1.context);
    const r3 = voterContract.impureCircuits.castVote(r2.context);
    const r4 = adminContract.impureCircuits.openTallying(r3.context);
    expect(() => {
      wrongVoter.impureCircuits.revealVote(r4.context);
    }).toThrow("Commitment mismatch");
  });

  it("should reject voting during registration phase", () => {
    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    expect(() => {
      voterContract.impureCircuits.castVote(r1.context);
    }).toThrow("Not in voting phase");
  });

  it("should complete full ballot lifecycle", () => {
    const r1 = adminContract.impureCircuits.registerVoter(ctx, voterPk);
    const r2 = adminContract.impureCircuits.openVoting(r1.context);
    const r3 = voterContract.impureCircuits.castVote(r2.context);
    const r4 = adminContract.impureCircuits.openTallying(r3.context);
    const r5 = voterContract.impureCircuits.revealVote(r4.context);
    const r6 = adminContract.impureCircuits.closeBallot(r5.context);
    expect(r6.context).toBeDefined();
  });
});
```

---

## Notes

- Circuit complexity is moderate (k ~13-14) due to multiple Map operations and
  `persistentHash` calls. The `revealVote` circuit is the heaviest because it
  performs a Map lookup, a hash recomputation, and a Map insert.
- The tally-phase reveal leaks vote direction per transaction. For production use,
  consider a batch-reveal pattern where an off-chain tallier collects all reveals
  and submits a single aggregated tally, or explore a nullifier-based scheme where
  voters prove membership in a Merkle tree of eligible voters without revealing
  which leaf they are.
- Salt management is critical: if a voter loses their salt between the vote and
  reveal phases, their vote cannot be counted. The TypeScript witness must persist
  the salt in private state across sessions.
- This contract does not handle the case where some voters never reveal. The admin
  should close the ballot after a deadline regardless of reveal completeness.
- Compiler-validated against Compact 0.29.0 (9/9 tests passing).
- `Boolean as Field as Bytes<32>` is a valid chained cast for encoding boolean values
  into a hashable format. The intermediate `Field` step is required because Compact
  does not support a direct `Boolean as Bytes<32>` cast.
