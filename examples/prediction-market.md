# Prediction Market

> **Compiler-validated:** Contract compiles and 7/7 tests pass against Compact 0.29.0.

A binary prediction market with commitment-based bets and ZK-verified payouts.
Bettors place hidden bets (yes/no) using a commit-reveal scheme -- the bet
direction is concealed behind a hash commitment until the claim phase. An admin
resolves the market with the actual outcome, and winners prove their bet matched
without revealing the losing bets. Demonstrates commitment+blinding for hidden
bets, state machine lifecycle, and the ZK pattern for verified payouts.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum MarketPhase { open, closed, resolved }

export ledger admin: Bytes<32>;
export ledger phase: MarketPhase;
export ledger description: Opaque<"string">;
export ledger bets: Map<Bytes<32>, Bytes<32>>;
export ledger betAmounts: Map<Bytes<32>, Uint<64>>;
export ledger totalPool: Counter;
export ledger totalBets: Counter;
export ledger outcome: Boolean;
export ledger resolved: Boolean;
export ledger claimed: Set<Bytes<32>>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getBetChoice(): Boolean;
witness getBetSalt(): Bytes<32>;
witness getBetAmount(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "market:pk:"), seq, sk]);
}

constructor(desc: Opaque<"string">) {
  sequence.increment(1);
  admin = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  description = disclose(desc);
  phase = MarketPhase.open;
  resolved = false;
}

export circuit placeBet(): [] {
  assert(phase == MarketPhase.open, "Market is not open");

  const bettor = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(!bets.member(bettor), "Already placed a bet");

  const choice = getBetChoice();
  const salt = getBetSalt();
  const amount = getBetAmount();

  assert(disclose(amount > (0 as Uint<64>)), "Bet amount must be positive");

  const commitment = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "market:bet:"),
    salt,
    choice as Field as Bytes<32>,
    amount as Field as Bytes<32>
  ]);

  bets.insert(bettor, disclose(commitment));
  betAmounts.insert(bettor, disclose(amount));
  totalPool.increment(1);
  totalBets.increment(1);
}

export circuit closeBetting(): [] {
  assert(phase == MarketPhase.open, "Market is not open");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == admin),
         "Only admin");
  phase = MarketPhase.closed;
}

export circuit resolve(result: Boolean): [] {
  assert(phase == MarketPhase.closed, "Market must be closed first");
  assert(!resolved, "Already resolved");
  assert(disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == admin),
         "Only admin");

  outcome = disclose(result);
  resolved = true;
  phase = MarketPhase.resolved;
}

export circuit claimWinnings(): [] {
  assert(phase == MarketPhase.resolved, "Market not resolved");

  const bettor = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  assert(bets.member(bettor), "No bet found");
  assert(!claimed.member(bettor), "Already claimed");

  const choice = getBetChoice();
  const salt = getBetSalt();
  const amount = getBetAmount();

  const recomputed = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "market:bet:"),
    salt,
    choice as Field as Bytes<32>,
    amount as Field as Bytes<32>
  ]);

  const stored = bets.lookup(bettor);
  assert(disclose(recomputed == stored), "Commitment mismatch");

  assert(disclose(choice == outcome), "Bet did not match outcome");

  claimed.insert(bettor);
}

export circuit getPoolSize(): Uint<64> {
  return totalPool.read();
}
```

---

## Key Concepts

### Commitment-Based Betting

When placing a bet, the bettor computes `hash(domain || salt || choice || amount)`
and stores only this commitment on-chain. The bet direction (yes/no) and the
random salt remain private. During the claim phase, the bettor re-derives the
commitment from their private inputs and proves it matches the stored hash.
This prevents front-running -- no one can see which direction others have bet.

The commitment structure is a 4-element `persistentHash<Vector<4, Bytes<32>>>`:

1. **Domain separator** (`"market:bet:"`) -- prevents cross-contract collision
2. **Salt** -- random blinding factor, prevents dictionary attacks
3. **Choice** -- the bet direction, cast via `Boolean as Field as Bytes<32>`
4. **Amount** -- the bet size, cast via `Uint<64> as Field as Bytes<32>`

### State Machine Lifecycle

```
open --> closed     (admin calls closeBetting)
closed --> resolved (admin calls resolve with outcome)
resolved --> [claims] (winners call claimWinnings)
```

The `MarketPhase` enum enforces one-way transitions. Bets can only be placed
during the `open` phase. Resolution requires the market to be `closed` first,
preventing the admin from resolving while bets are still incoming.

### ZK Payout Verification

Winners prove their bet matched the outcome without revealing losing bets.
The circuit verifies: (1) the commitment matches the stored hash, and (2) the
bet choice equals the resolved outcome. Only the boolean comparison
`disclose(choice == outcome)` is revealed -- not the choice itself. However,
since the outcome is public and the comparison result is public, the winner's
choice is implicitly revealed. The privacy benefit is that **losers never need
to reveal** -- their bet direction stays hidden.

### Simplified Payout Model

This implementation uses a simplified payout model -- winners prove eligibility
and the `claimed` Set prevents double claims. Actual token transfer is not
implemented (that would require coin operations on the Midnight UTXO layer).

A proportional payout model (winner gets `amount * totalPool / totalWinnerPool`)
would require either:
- A witness-computed division verified in-circuit: `assert(disclose(reward * totalWinnerPool == amount * totalPool), "Invalid payout")`
- An off-chain settlement phase where a trusted party computes and distributes payouts

### Sequence Counter for Identity Binding

This contract uses a sequence counter to bind public keys to the market
instance. The sequence is set during construction and remains stable through
the betting, closing, resolution, and claim phases. It does NOT increment
during the market lifecycle -- incrementing would change all bettors' public
keys and break the lookup from `placeBet` to `claimWinnings`. Phase-based
access control (the `MarketPhase` enum) handles replay prevention instead.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/market/contract/index.js';

export interface MarketPrivateState {
  readonly secretKey: Uint8Array;
  readonly betChoice: boolean;
  readonly betSalt: Uint8Array;
  readonly betAmount: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, MarketPrivateState>,
  ): [MarketPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getBetChoice: (
    { privateState }: WitnessContext<Ledger, MarketPrivateState>,
  ): [MarketPrivateState, boolean] => {
    return [privateState, privateState.betChoice];
  },

  getBetSalt: (
    { privateState }: WitnessContext<Ledger, MarketPrivateState>,
  ): [MarketPrivateState, Uint8Array] => {
    // Salt must be persisted between placeBet and claimWinnings calls.
    // Losing the salt means losing the ability to prove the bet.
    return [privateState, privateState.betSalt];
  },

  getBetAmount: (
    { privateState }: WitnessContext<Ledger, MarketPrivateState>,
  ): [MarketPrivateState, bigint] => {
    return [privateState, privateState.betAmount];
  },
};
```

---

## Tests

Compiler-validated simulator tests (7/7 passing). Admin, winner, and loser use
separate `Contract` instances with different witnesses. The `getBetChoice`
witness controls which direction each bettor bets.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, MarketPhase } from "../src/managed/market/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const yesBettorKey = new Uint8Array(32); yesBettorKey[0] = 0x02;
const noBettorKey = new Uint8Array(32); noBettorKey[0] = 0x03;

const salt1 = new Uint8Array(32); salt1[0] = 0xAA;
const salt2 = new Uint8Array(32); salt2[0] = 0xBB;

function makeWitnesses(sk, choice = true, salt = salt1, amount = 100n) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getBetChoice: ({ privateState }) => [privateState, choice],
    getBetSalt: ({ privateState }) => [privateState, salt],
    getBetAmount: ({ privateState }) => [privateState, amount],
  };
}

describe("Prediction Market", () => {
  let adminContract;
  let ctx;

  beforeEach(() => {
    adminContract = new Contract(makeWitnesses(adminKey));
    const addr = sampleContractAddress();
    const initial = adminContract.initialState(
      createConstructorContext({}, addr),
      "Will BTC exceed 100k by end of year?",
    );
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should place a bet", () => {
    const bettor = new Contract(makeWitnesses(yesBettorKey, true, salt1, 100n));
    const r = bettor.impureCircuits.placeBet(ctx);
    expect(r.context).toBeDefined();
  });

  it("should close betting", () => {
    const bettor = new Contract(makeWitnesses(yesBettorKey, true, salt1, 100n));
    const r1 = bettor.impureCircuits.placeBet(ctx);
    const r2 = adminContract.impureCircuits.closeBetting(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should resolve market with outcome", () => {
    const bettor = new Contract(makeWitnesses(yesBettorKey, true, salt1, 100n));
    const r1 = bettor.impureCircuits.placeBet(ctx);
    const r2 = adminContract.impureCircuits.closeBetting(r1.context);
    const r3 = adminContract.impureCircuits.resolve(r2.context, true);
    expect(r3.context).toBeDefined();
  });

  it("should allow winner to claim", () => {
    const yesBettor = new Contract(makeWitnesses(yesBettorKey, true, salt1, 100n));
    const r1 = yesBettor.impureCircuits.placeBet(ctx);
    const r2 = adminContract.impureCircuits.closeBetting(r1.context);
    // Resolve as "true" -- yes bettor wins
    const r3 = adminContract.impureCircuits.resolve(r2.context, true);
    const r4 = yesBettor.impureCircuits.claimWinnings(r3.context);
    expect(r4.context).toBeDefined();
  });

  it("should reject claim on losing bet", () => {
    const noBettor = new Contract(makeWitnesses(noBettorKey, false, salt2, 50n));
    const r1 = noBettor.impureCircuits.placeBet(ctx);
    const r2 = adminContract.impureCircuits.closeBetting(r1.context);
    // Resolve as "true" -- no bettor loses
    const r3 = adminContract.impureCircuits.resolve(r2.context, true);
    expect(() => {
      noBettor.impureCircuits.claimWinnings(r3.context);
    }).toThrow("Bet did not match outcome");
  });

  it("should reject bet after market closed", () => {
    const r1 = adminContract.impureCircuits.closeBetting(ctx);
    const lateBettor = new Contract(makeWitnesses(yesBettorKey, true, salt1, 100n));
    expect(() => {
      lateBettor.impureCircuits.placeBet(r1.context);
    }).toThrow("Market is not open");
  });

  it("should reject double claim", () => {
    const yesBettor = new Contract(makeWitnesses(yesBettorKey, true, salt1, 100n));
    const r1 = yesBettor.impureCircuits.placeBet(ctx);
    const r2 = adminContract.impureCircuits.closeBetting(r1.context);
    const r3 = adminContract.impureCircuits.resolve(r2.context, true);
    const r4 = yesBettor.impureCircuits.claimWinnings(r3.context);
    expect(() => {
      yesBettor.impureCircuits.claimWinnings(r4.context);
    }).toThrow("Already claimed");
  });
});
```

---

## CLI

```bash
compact compile src/prediction-market.compact src/managed/market
npm test
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly (5 circuits) and all 7
  tests pass against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is moderate-to-high (k ~14-15) due to the 4-element
  `persistentHash` in both `placeBet` and `claimWinnings`, plus multiple Map
  operations and Set membership checks.
- **`Boolean as Field as Bytes<32>` is valid.** The chained cast converts the
  bet choice for inclusion in the hash vector. The intermediate `Field` step is
  required because Compact does not support a direct `Boolean as Bytes<32>` cast.
- **Bet amount is disclosed.** The `betAmounts` Map stores the amount publicly
  on-chain. For fully private bet sizing, the amount could be included only in
  the commitment and revealed during the claim phase. However, public amounts
  are useful for pool size transparency.
- **Salt management is critical.** If a bettor loses their salt between
  `placeBet` and `claimWinnings`, they cannot prove their bet. The TypeScript
  witness must persist the salt in private state across sessions.
- **No proportional payout in-circuit.** Division in Compact is possible but
  the proportional payout pattern (`amount * totalPool / totalWinnerPool`)
  requires knowing `totalWinnerPool`, which is only known after all winners
  claim. The standard ZK division pattern is: witness computes the quotient,
  circuit verifies via multiplication:
  `assert(disclose(reward * divisor == dividend), "Invalid division")`.
- **Admin trust assumption:** The admin resolves the market outcome. For
  trustless resolution, integrate with an oracle feed contract (see
  `oracle-feed.md`) that provides cryptographically attested outcomes.
- **`Counter` tracks pool size as a count, not a sum.** `totalPool.increment(1)`
  counts the number of bets, not the total staked amount. `Counter` only supports
  `increment(1)` and `decrement(1)`. For sum tracking, use a `Uint<64>` ledger
  variable with explicit addition, or track via an off-chain indexer.
