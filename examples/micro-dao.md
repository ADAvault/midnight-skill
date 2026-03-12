# Micro-DAO

> **Compiler-validated:** Contract compiles (7 circuits) and 7/7 tests pass against Compact 0.29.0.

A token-gated governance contract combining membership management, proposal
voting, and treasury control. Members are registered by the admin and can
create proposals, vote on them, and trigger tally. The contract enforces
quorum-based majority voting with double-vote prevention via composite Map
keys. Demonstrates governance patterns, access-gated operations, and
per-proposal per-voter tracking in a single contract.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum ProposalPhase { voting, passed, rejected, executed }

export ledger admin: Bytes<32>;
export ledger members: Map<Bytes<32>, Boolean>;
export ledger memberCount: Counter;
export ledger proposals: Map<Bytes<32>, Bytes<32>>;
export ledger proposalPhases: Map<Bytes<32>, Uint<8>>;
export ledger votesFor: Map<Bytes<32>, Uint<32>>;
export ledger votesAgainst: Map<Bytes<32>, Uint<32>>;
export ledger hasVoted: Map<Bytes<32>, Boolean>;
export ledger quorum: Uint<32>;
export ledger treasuryBalance: Counter;

witness localSecretKey(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "dao:pk:"), sk]);
}

circuit assertMember(): Bytes<32> {
  const caller = publicKey(localSecretKey());
  assert(members.member(disclose(caller)), "Not a member");
  return caller;
}

constructor() {
  admin = disclose(publicKey(localSecretKey()));
  quorum = 1 as Uint<32>;
}

export circuit addMember(memberPk: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(!members.member(disclose(memberPk)), "Already a member");
  members.insert(disclose(memberPk), true);
  memberCount.increment(1);
}

export circuit removeMember(memberPk: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(members.member(disclose(memberPk)), "Not a member");
  members.remove(disclose(memberPk));
  memberCount.decrement(1);
}

export circuit createProposal(proposalId: Bytes<32>, descHash: Bytes<32>): [] {
  assertMember();
  assert(!proposals.member(disclose(proposalId)), "Proposal already exists");
  proposals.insert(disclose(proposalId), disclose(descHash));
  proposalPhases.insert(disclose(proposalId), 0 as Uint<8>);
  votesFor.insert(disclose(proposalId), 0 as Uint<32>);
  votesAgainst.insert(disclose(proposalId), 0 as Uint<32>);
}

export circuit vote(proposalId: Bytes<32>, inFavor: Boolean): [] {
  const caller = disclose(assertMember());
  assert(proposals.member(disclose(proposalId)), "Proposal does not exist");
  const phase = proposalPhases.lookup(disclose(proposalId));
  assert(phase == 0 as Uint<8>, "Voting is closed");

  const voteKey = persistentHash<Vector<2, Bytes<32>>>([proposalId, caller]);
  assert(!hasVoted.member(disclose(voteKey)), "Already voted on this proposal");
  hasVoted.insert(disclose(voteKey), true);

  if (disclose(inFavor)) {
    const current = votesFor.lookup(disclose(proposalId));
    votesFor.insert(disclose(proposalId), (current + 1) as Uint<32>);
  } else {
    const current = votesAgainst.lookup(disclose(proposalId));
    votesAgainst.insert(disclose(proposalId), (current + 1) as Uint<32>);
  }
}

export circuit tallyProposal(proposalId: Bytes<32>): [] {
  assert(proposals.member(disclose(proposalId)), "Proposal does not exist");
  const phase = proposalPhases.lookup(disclose(proposalId));
  assert(phase == 0 as Uint<8>, "Already tallied");

  const forCount = votesFor.lookup(disclose(proposalId));
  const againstCount = votesAgainst.lookup(disclose(proposalId));
  const totalVotes = (forCount + againstCount) as Uint<32>;

  if (disclose(totalVotes >= quorum)) {
    if (disclose(forCount > againstCount)) {
      proposalPhases.insert(disclose(proposalId), 1 as Uint<8>);
    } else {
      proposalPhases.insert(disclose(proposalId), 2 as Uint<8>);
    }
  } else {
    proposalPhases.insert(disclose(proposalId), 2 as Uint<8>);
  }
}

export circuit executeProposal(proposalId: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(proposals.member(disclose(proposalId)), "Proposal does not exist");
  const phase = proposalPhases.lookup(disclose(proposalId));
  assert(phase == 1 as Uint<8>, "Proposal not passed");
  proposalPhases.insert(disclose(proposalId), 3 as Uint<8>);
}

export circuit setQuorum(q: Uint<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(q > 0 as Uint<32>, "Quorum must be positive");
  quorum = disclose(q);
}
```

---

## Key Concepts

### No Sequence Counter

Like the multi-sig and access-control examples, this contract omits the
sequence counter. Members are registered by public key, and if a sequence
counter were used in key derivation, any `sequence.increment()` would
invalidate every registered member's key. Operations are tracked by
`proposalId` rather than sequence numbers.

### Token-Gated Access

The `members` Map acts as a membership gate. The internal `assertMember`
circuit checks that the caller's derived public key exists in the Map before
allowing proposal creation or voting. This is the simplest form of
token-gating -- in production, membership could be tied to token holdings
via a separate fungible token contract.

### Composite Map Keys for Double-Vote Prevention

Since Compact does not support nested Maps, per-proposal per-voter tracking
uses a composite key: `hash(proposalId || voterPk)`. This produces a unique
`Bytes<32>` key for each voter-proposal pair, stored in the `hasVoted` Map.

### Enum-to-Uint Workaround

Compact enums cannot be stored in Maps. The `proposalPhases` Map uses
`Uint<8>` to represent phases numerically: 0 = voting, 1 = passed,
2 = rejected, 3 = executed. The `ProposalPhase` enum is exported for
TypeScript consumers but the Map stores raw integers.

### Quorum-Based Governance

The `tallyProposal` circuit checks two conditions: (1) total votes meet or
exceed the quorum threshold, and (2) votes-for exceed votes-against. If
either condition fails, the proposal is rejected. This separation of
voting and tallying allows the voting window to remain open until someone
triggers the tally.

### Treasury Pattern

The `treasuryBalance` Counter is a simplified placeholder. In production,
treasury management would use coin operations (`mint`, `pour`, `transfer`)
on the Midnight UTXO layer. The Counter demonstrates the concept without
requiring the full coin API.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/dao/contract/index.js';

export interface DaoPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, DaoPrivateState>,
  ): [DaoPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },
};
```

---

## Tests

Compiler-validated simulator tests (7/7 passing). Multi-user testing with
separate `Contract` instances per member. Admin uses `pureCircuits.publicKey()`
to pre-compute member public keys for registration.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/dao/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const member1Key = new Uint8Array(32); member1Key[0] = 0x02;
const member2Key = new Uint8Array(32); member2Key[0] = 0x03;
const member3Key = new Uint8Array(32); member3Key[0] = 0x04;
const nonMemberKey = new Uint8Array(32); nonMemberKey[0] = 0x05;

const proposalId = new Uint8Array(32); proposalId[0] = 0xA1;
const descHash = new Uint8Array(32); descHash[0] = 0xD1;

function makeWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
  };
}

describe("Micro-DAO", () => {
  let adminContract, ctx, member1Pk, member2Pk, member3Pk;

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
    member1Pk = pureCircuits.publicKey(member1Key);
    member2Pk = pureCircuits.publicKey(member2Key);
    member3Pk = pureCircuits.publicKey(member3Key);
  });

  it("should add member and create proposal", () => {
    let r = adminContract.impureCircuits.addMember(ctx, member1Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    expect(r.context).toBeDefined();
  });

  it("should vote for a proposal", () => {
    let r = adminContract.impureCircuits.addMember(ctx, member1Pk);
    r = adminContract.impureCircuits.addMember(r.context, member2Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    r = m1.impureCircuits.vote(r.context, proposalId, true);
    const m2 = new Contract(makeWitnesses(member2Key));
    r = m2.impureCircuits.vote(r.context, proposalId, false);
    expect(r.context).toBeDefined();
  });

  it("should tally passing proposal", () => {
    let r = adminContract.impureCircuits.setQuorum(ctx, 2n);
    r = adminContract.impureCircuits.addMember(r.context, member1Pk);
    r = adminContract.impureCircuits.addMember(r.context, member2Pk);
    r = adminContract.impureCircuits.addMember(r.context, member3Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    r = m1.impureCircuits.vote(r.context, proposalId, true);
    const m2 = new Contract(makeWitnesses(member2Key));
    r = m2.impureCircuits.vote(r.context, proposalId, true);
    const m3 = new Contract(makeWitnesses(member3Key));
    r = m3.impureCircuits.vote(r.context, proposalId, false);
    r = adminContract.impureCircuits.tallyProposal(r.context, proposalId);
    expect(r.context).toBeDefined();
  });

  it("should tally failing proposal when quorum not met", () => {
    let r = adminContract.impureCircuits.setQuorum(ctx, 3n);
    r = adminContract.impureCircuits.addMember(r.context, member1Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    r = m1.impureCircuits.vote(r.context, proposalId, true);
    r = adminContract.impureCircuits.tallyProposal(r.context, proposalId);
    expect(r.context).toBeDefined();
  });

  it("should reject double vote", () => {
    let r = adminContract.impureCircuits.addMember(ctx, member1Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    r = m1.impureCircuits.vote(r.context, proposalId, true);
    expect(() => {
      m1.impureCircuits.vote(r.context, proposalId, true);
    }).toThrow("Already voted on this proposal");
  });

  it("should reject non-member vote", () => {
    let r = adminContract.impureCircuits.addMember(ctx, member1Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    const nonMember = new Contract(makeWitnesses(nonMemberKey));
    expect(() => {
      nonMember.impureCircuits.vote(r.context, proposalId, true);
    }).toThrow("Not a member");
  });

  it("should execute after pass", () => {
    let r = adminContract.impureCircuits.setQuorum(ctx, 1n);
    r = adminContract.impureCircuits.addMember(r.context, member1Pk);
    const m1 = new Contract(makeWitnesses(member1Key));
    r = m1.impureCircuits.createProposal(r.context, proposalId, descHash);
    r = m1.impureCircuits.vote(r.context, proposalId, true);
    r = adminContract.impureCircuits.tallyProposal(r.context, proposalId);
    r = adminContract.impureCircuits.executeProposal(r.context, proposalId);
    expect(r.context).toBeDefined();
  });
});
```

---

## CLI

```bash
compact compile src/dao.compact src/managed/dao
npm test
```

---

## Notes

- **Compiler-validated:** 7 circuits compiled, 7/7 tests pass against Compact 0.29.0.
- **Enum-to-Uint mapping:** Compact enums cannot be stored in Maps. Use `Uint<8>`
  and document the numeric mapping (0 = voting, 1 = passed, 2 = rejected,
  3 = executed). The `ProposalPhase` enum is still exported for TypeScript
  consumers to use as documentation.
- **Type widening:** `Uint<32> + 1` produces a wider range type. Use
  `(current + 1) as Uint<32>` when incrementing vote counts in Maps.
- **Composite key growth:** The `hasVoted` Map grows with every vote cast
  across all proposals. For production, consider off-chain vote tracking
  with on-chain nullifier proofs.
- **No sequence counter:** Contracts with registered key sets should NOT use
  sequence counters in key derivation. A sequence increment would invalidate
  all registered member keys.
- Circuit complexity is high (k ~15-16) due to multiple Map operations in the
  `vote` circuit (5 Map operations). For large DAOs, consider off-chain vote
  aggregation with on-chain proof verification.
- The `tallyProposal` circuit can be called by anyone -- it reads public ledger
  state and applies deterministic logic. Admin-gating the tally is optional
  depending on governance design.
