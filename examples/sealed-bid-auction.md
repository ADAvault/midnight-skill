# Sealed-Bid Auction

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
witness getItemDescription(): Opaque<"string">;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "auction:pk:"), seq, sk]);
}

constructor() {
  phase = AuctionPhase.open;
  seller = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  sequence.increment(1);
}

// Seller configures the auction
export circuit configure(desc: Opaque<"string">, minBid: Uint<64>): [] {
  assert(phase == AuctionPhase.open, "Auction already configured");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == seller),
         "Only seller");

  itemDescription = desc;
  minimumBid = minBid;
  phase = AuctionPhase.bidding;
}

// Bidder commits: hash(domain || salt || bidder || amount)
export circuit commitBid(): [] {
  assert(phase == AuctionPhase.bidding, "Not in bidding phase");

  const bidder = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  assert(!commitments.member(bidder), "Already placed a bid");

  const amount = getBidAmount();
  const salt = getBidSalt();

  // Commitment includes bidder identity to prevent commitment theft
  const commitment = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "auction:bid:"),
    salt,
    bidder,
    amount as Field as Bytes<32>
  ]);

  commitments.insert(bidder, disclose(commitment));
  totalBids.increment(1);
}

// Bidder reveals: prove bid matches commitment, update winner if highest
export circuit revealBid(): [] {
  assert(phase == AuctionPhase.reveal, "Not in reveal phase");

  const bidder = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  assert(commitments.member(bidder), "No commitment found");

  const amount = getBidAmount();
  const salt = getBidSalt();

  // Recompute commitment
  const recomputed = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "auction:bid:"),
    salt,
    bidder,
    amount as Field as Bytes<32>
  ]);

  const stored = commitments.lookup(bidder);
  assert(disclose(recomputed == stored), "Commitment mismatch");

  // Enforce minimum bid
  assert(disclose(amount >= minimumBid), "Below minimum bid");

  // Update winner if this is the highest bid so far
  // Note: disclose(amount) reveals the bid amount for comparison.
  // For maximum privacy, the comparison could be done without disclosing
  // the losing bid amount -- but winner's amount must be disclosed for
  // settlement. See Notes for alternative approaches.
  if (disclose(amount > winningBid)) {
    winningBid = disclose(amount);
    winner = bidder;
  }

  totalRevealed.increment(1);
}

// Phase transitions (seller only)
export circuit closeAndReveal(): [] {
  assert(phase == AuctionPhase.bidding, "Must be in bidding");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == seller),
         "Only seller");
  phase = AuctionPhase.reveal;
}

export circuit settle(): [] {
  assert(phase == AuctionPhase.reveal, "Must be in reveal");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == seller),
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

  getItemDescription: (
    { privateState }: WitnessContext<Ledger, AuctionPrivateState>,
  ): [AuctionPrivateState, string] => {
    return [privateState, 'Auction item'];
  },
};
```

---

## Tests

```
describe('Sealed-Bid Auction', () => {

  1. Full auction lifecycle (happy path)
     - Deploy, configure, two bidders commit, close, both reveal, settle
     - Assert winner is the higher bidder, winningBid matches

  2. Commitment mismatch on reveal (should fail)
     - Commit with amount=100, attempt reveal with amount=200
     - Assert "Commitment mismatch" error

  3. Double-bid prevention
     - Bidder commits once, attempts second commit
     - Assert "Already placed a bid" error

  4. Below minimum bid rejected on reveal
     - Set minimumBid=100, commit and reveal with amount=50
     - Assert "Below minimum bid" error

  5. Phase enforcement
     - Attempt to commit during reveal phase
     - Attempt to reveal during bidding phase
     - Assert phase mismatch errors

  6. Only seller can transition phases
     - Non-seller attempts closeAndReveal
     - Assert "Only seller" error
});
```

---

## Notes

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
