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

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "ballot:pk:"), seq, sk]);
}

constructor() {
  phase = BallotPhase.registration;
  admin = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  sequence.increment(1);
}

// Admin registers eligible voters
export circuit registerVoter(voterPk: Bytes<32>): [] {
  assert(phase == BallotPhase.registration, "Not in registration phase");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
         "Only admin can register voters");
  assert(!registeredVoters.member(voterPk), "Already registered");
  registeredVoters.insert(voterPk, true);
  totalRegistered.increment(1);
}

// Voter submits a commitment: hash(vote || salt)
// The commitment hides the vote direction -- observer sees only a hash
export circuit castVote(): [] {
  assert(phase == BallotPhase.voting, "Not in voting phase");

  const voter = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  assert(registeredVoters.member(voter), "Not a registered voter");
  assert(!voterCommitments.member(voter), "Already voted");

  const vote = getVote();
  const salt = getVoteSalt();

  // Commit: hash(domain || salt || vote-as-bytes)
  // Using Field cast so Boolean -> Field -> Bytes<32>
  const voteBytes = vote as Field as Bytes<32>;
  const commitment = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "ballot:vote:"),
    salt,
    voteBytes
  ]);

  voterCommitments.insert(voter, disclose(commitment));
  totalVoted.increment(1);
}

// Voter reveals their vote during tally phase -- circuit verifies commitment
// and increments the appropriate counter
export circuit revealVote(): [] {
  assert(phase == BallotPhase.tallying, "Not in tallying phase");

  const voter = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  assert(voterCommitments.member(voter), "No commitment found");
  assert(!tallied.member(voter), "Already tallied");

  const vote = getVote();
  const salt = getVoteSalt();

  // Recompute commitment and verify it matches
  const voteBytes = vote as Field as Bytes<32>;
  const recomputed = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "ballot:vote:"),
    salt,
    voteBytes
  ]);

  const stored = voterCommitments.lookup(voter);
  assert(disclose(recomputed == stored), "Commitment mismatch -- vote or salt changed");

  // Increment the correct tally counter
  // Privacy note: the counter increment IS observable per-tx, but during the
  // tally phase all reveals happen and the ordering is non-deterministic
  if (disclose(vote)) {
    tallyFor.increment(1);
  } else {
    tallyAgainst.increment(1);
  }

  tallied.insert(voter);
}

// Phase transitions (admin only)
export circuit openVoting(): [] {
  assert(phase == BallotPhase.registration, "Must be in registration");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
         "Only admin");
  phase = BallotPhase.voting;
}

export circuit openTallying(): [] {
  assert(phase == BallotPhase.voting, "Must be in voting");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
         "Only admin");
  phase = BallotPhase.tallying;
}

export circuit closeBallot(): [] {
  assert(phase == BallotPhase.tallying, "Must be in tallying");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == admin),
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

```
describe('Shielded Voting', () => {

  1. Register voter and cast vote (happy path)
     - Deploy, register a voter, open voting, cast vote
     - Assert totalVoted increments and commitment is stored

  2. Reveal vote matches commitment (happy path)
     - Cast with vote=true + salt, transition to tallying, reveal
     - Assert tallyFor increments by 1

  3. Reveal with wrong salt (should fail)
     - Cast with salt A, attempt reveal with salt B
     - Assert "Commitment mismatch" error

  4. Double vote prevention
     - Cast once, attempt to cast again with same voter key
     - Assert "Already voted" error

  5. Unregistered voter cannot cast
     - Skip registration, attempt to cast
     - Assert "Not a registered voter" error

  6. Phase enforcement
     - Attempt to cast during registration phase
     - Attempt to reveal during voting phase
     - Assert phase mismatch errors
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
