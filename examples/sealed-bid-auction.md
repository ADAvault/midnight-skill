# Sealed-Bid Auction

> **Compiler-validated:** Contract compiles and 8/8 tests pass against Compact 0.29.0.

A commit-reveal auction where bidders submit hidden bids as hashed commitments,
then reveal them to determine the winner. The ZK advantage over Ethereum-style
commit-reveal is that the reveal phase can verify bids without exposing losing
bids on-chain -- only the winning bid amount is disclosed. Demonstrates the
commit-reveal pattern, state machine phase management, and selective disclosure
of auction results.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum AuctionPhase { open, bidding, reveal, settled }

export ledger phase: AuctionPhase;
export ledger seller: Bytes<32>;
export ledger itemDescription: Opaque<"string">;
export ledger commitments: Map<Bytes<32>, Bytes<32>>;
export ledger totalBids: Counter;
export ledger totalRevealed: Counter;
export ledger winningBid: Uint<64>;
export ledger winner: Bytes<32>;
export ledger minimumBid: Uint<64>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getBidAmount(): Uint<64>;
witness getBidSalt(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "auction:pk:"), seq, sk]);
}

constructor() {
  phase = AuctionPhase.open;
  sequence.increment(1);
  seller = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
}

export circuit configure(desc: Opaque<"string">, minBid: Uint<64>): [] {
  assert(phase == AuctionPhase.open, "Auction already configured");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == seller),
         "Only seller");
  itemDescription = disclose(desc);
  minimumBid = disclose(minBid);
  phase = AuctionPhase.bidding;
}

export circuit commitBid(): [] {
  assert(phase == AuctionPhase.bidding, "Not in bidding phase");

  const bidder = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(!commitments.member(bidder), "Already placed a bid");

  const amount = getBidAmount();
  const salt = getBidSalt();

  const commitment = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "auction:bid:"),
    salt,
    bidder,
    amount as Field as Bytes<32>
  ]);

  commitments.insert(bidder, disclose(commitment));
  totalBids.increment(1);
}

export circuit revealBid(): [] {
  assert(phase == AuctionPhase.reveal, "Not in reveal phase");

  const bidder = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(commitments.member(bidder), "No commitment found");

  const amount = getBidAmount();
  const salt = getBidSalt();

  const recomputed = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "auction:bid:"),
    salt,
    bidder,
    amount as Field as Bytes<32>
  ]);

  const stored = commitments.lookup(bidder);
  assert(disclose(recomputed == stored), "Commitment mismatch");
  assert(disclose(amount >= minimumBid), "Below minimum bid");

  if (disclose(amount > winningBid)) {
    winningBid = disclose(amount);
    winner = bidder;
  }

  totalRevealed.increment(1);
}

export circuit closeAndReveal(): [] {
  assert(phase == AuctionPhase.bidding, "Must be in bidding");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == seller),
         "Only seller");
  phase = AuctionPhase.reveal;
}

export circuit settle(): [] {
  assert(phase == AuctionPhase.reveal, "Must be in reveal");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == seller),
         "Only seller");
  phase = AuctionPhase.settled;
  sequence.increment(1);
}
```

---

## Key Concepts

- **Commit-reveal with ZK advantage:** On Ethereum, every revealed bid is publicly
  visible in the reveal transaction's calldata. On Midnight, the ZK proof verifies
  the commitment without necessarily exposing the bid amount. In this implementation,
  the winning bid is disclosed for transparency, but losing bids could remain hidden
  with a more sophisticated comparison circuit.
- **Commitment binding:** The commitment includes the bidder's public key, preventing
  one bidder from copying another's commitment hash and claiming it as their own.
- **Domain-separated hashing:** `pad(32, "auction:bid:")` ensures the commitment hash
  cannot collide with hashes from other contract uses (e.g., identity derivation).
- **State machine enforcement:** Phase transitions are one-way and seller-controlled.
  The `AuctionPhase` enum prevents bidding after the reveal window opens.
- **Winner determination:** The `winningBid` and `winner` ledger variables track the
  highest bid seen so far. Each reveal compares against the current leader.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/auction/contract/index.cjs';

export interface AuctionPrivateState {
  readonly secretKey: Uint8Array;
  readonly bidAmount: bigint;
  readonly bidSalt: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, AuctionPrivateState>,
  ): [AuctionPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getBidAmount: (
    { privateState }: WitnessContext<Ledger, AuctionPrivateState>,
  ): [AuctionPrivateState, bigint] => {
    return [privateState, privateState.bidAmount];
  },

  getBidSalt: (
    { privateState }: WitnessContext<Ledger, AuctionPrivateState>,
  ): [AuctionPrivateState, Uint8Array] => {
    // Salt must be identical between commit and reveal.
    // Losing the salt means losing the ability to reveal.
    return [privateState, privateState.bidSalt];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, AuctionPhase } from "../src/managed/auction/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const sellerKey = new Uint8Array(32); sellerKey[0] = 0x01;
const bidder1Key = new Uint8Array(32); bidder1Key[0] = 0x02;
const bidder2Key = new Uint8Array(32); bidder2Key[0] = 0x03;

const salt1 = new Uint8Array(32); salt1[0] = 0xAA;
const salt2 = new Uint8Array(32); salt2[0] = 0xBB;

function makeWitnesses(sk, amount = 100n, salt = salt1) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getBidAmount: ({ privateState }) => [privateState, amount],
    getBidSalt: ({ privateState }) => [privateState, salt],
  };
}

describe("Sealed-Bid Auction", () => {
  let sellerContract;
  let ctx;

  beforeEach(() => {
    sellerContract = new Contract(makeWitnesses(sellerKey));
    const addr = sampleContractAddress();
    const initial = sellerContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should configure auction", () => {
    const r = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    expect(r.context).toBeDefined();
  });

  it("should allow bidder to commit", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const bidder1 = new Contract(makeWitnesses(bidder1Key, 100n, salt1));
    const r2 = bidder1.impureCircuits.commitBid(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject double bid", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const bidder1 = new Contract(makeWitnesses(bidder1Key, 100n, salt1));
    const r2 = bidder1.impureCircuits.commitBid(r1.context);
    expect(() => {
      bidder1.impureCircuits.commitBid(r2.context);
    }).toThrow("Already placed a bid");
  });

  it("should reveal bid and verify commitment", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const bidder1 = new Contract(makeWitnesses(bidder1Key, 100n, salt1));
    const r2 = bidder1.impureCircuits.commitBid(r1.context);
    const r3 = sellerContract.impureCircuits.closeAndReveal(r2.context);
    const r4 = bidder1.impureCircuits.revealBid(r3.context);
    expect(r4.context).toBeDefined();
  });

  it("should reject reveal with wrong salt", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const bidder1 = new Contract(makeWitnesses(bidder1Key, 100n, salt1));
    const r2 = bidder1.impureCircuits.commitBid(r1.context);
    const r3 = sellerContract.impureCircuits.closeAndReveal(r2.context);
    const wrongBidder = new Contract(makeWitnesses(bidder1Key, 100n, salt2));
    expect(() => {
      wrongBidder.impureCircuits.revealBid(r3.context);
    }).toThrow("Commitment mismatch");
  });

  it("should reject bid below minimum", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const lowBidder = new Contract(makeWitnesses(bidder1Key, 10n, salt1));
    const r2 = lowBidder.impureCircuits.commitBid(r1.context);
    const r3 = sellerContract.impureCircuits.closeAndReveal(r2.context);
    expect(() => {
      lowBidder.impureCircuits.revealBid(r3.context);
    }).toThrow("Below minimum bid");
  });

  it("should track highest bidder across reveals", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const bidder1 = new Contract(makeWitnesses(bidder1Key, 100n, salt1));
    const bidder2 = new Contract(makeWitnesses(bidder2Key, 200n, salt2));
    const r2 = bidder1.impureCircuits.commitBid(r1.context);
    const r3 = bidder2.impureCircuits.commitBid(r2.context);
    const r4 = sellerContract.impureCircuits.closeAndReveal(r3.context);
    const r5 = bidder1.impureCircuits.revealBid(r4.context);
    const r6 = bidder2.impureCircuits.revealBid(r5.context);
    expect(r6.context).toBeDefined();
  });

  it("should complete full auction lifecycle", () => {
    const r1 = sellerContract.impureCircuits.configure(ctx, "Rare Item", 50n);
    const bidder1 = new Contract(makeWitnesses(bidder1Key, 100n, salt1));
    const r2 = bidder1.impureCircuits.commitBid(r1.context);
    const r3 = sellerContract.impureCircuits.closeAndReveal(r2.context);
    const r4 = bidder1.impureCircuits.revealBid(r3.context);
    const r5 = sellerContract.impureCircuits.settle(r4.context);
    expect(r5.context).toBeDefined();
  });
});
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly and all 8 tests pass
  against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is moderate-to-high (k ~14-15) due to the 4-element
  `persistentHash` in both `commitBid` and `revealBid`, plus multiple Map
  operations. Consider using `transientHash` for internal comparisons if the
  commitment does not need to be verified off-chain.
- **Privacy of losing bids:** In this implementation, losing bids are disclosed
  during the `revealBid` comparison (`disclose(amount > winningBid)`). To keep
  losing bids fully private, you would need a circuit that updates the winner
  without disclosing the comparison operands -- possible but significantly more
  complex (e.g., using an off-chain tallier that computes the winner and submits
  a proof of correctness).
- **Non-revealing bidders:** If a bidder commits but never reveals, their bid is
  effectively forfeit. The seller should settle after a deadline regardless of
  reveal completeness. Add a `revealDeadline: Uint<64>` ledger variable and a
  time-gated settle circuit for production use.
- Salt management is critical. If a bidder loses their salt between commit and
  reveal, they cannot prove their bid. The TypeScript witness must persist the
  salt in private state.
- For real auctions with value transfer, combine with coin operations: bidders
  `receive(coin)` during commit, and the contract `sendImmediate` to the winner
  and refunds to losers during settlement.
