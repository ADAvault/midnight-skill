# Staking

> **Compiler-validated:** Contract compiles and 6/6 tests pass against Compact 0.29.0.

A token staking contract with lock periods and reward calculation -- a core DeFi
primitive. Stakers lock tokens for a minimum period and earn rewards based on a
configurable rate (in basis points). Demonstrates ZK-friendly division (witness
computes, circuit verifies via multiplication), time-based lock enforcement with
witness-provided timestamps, and admin-controlled parameter updates.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger stakes: Map<Bytes<32>, Uint<64>>;
export ledger stakeTimestamps: Map<Bytes<32>, Uint<64>>;
export ledger lockPeriod: Uint<64>;
export ledger rewardRate: Uint<64>;
export ledger totalStakers: Counter;
export ledger rewardsClaimed: Counter;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;
witness getStakeAmount(): Uint<64>;
witness computeReward(amount: Uint<64>, rate: Uint<64>): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "stake:pk:"), sk]);
}

constructor(period: Uint<64>, rate: Uint<64>) {
  admin = disclose(publicKey(localSecretKey()));
  lockPeriod = disclose(period);
  rewardRate = disclose(rate);
}

export circuit stake(): [] {
  const staker = disclose(publicKey(localSecretKey()));
  assert(!stakes.member(staker), "Already staking");

  const amount = getStakeAmount();
  assert(disclose(amount > (0 as Uint<64>)), "Amount must be positive");

  const now = getCurrentTime();

  stakes.insert(staker, disclose(amount));
  stakeTimestamps.insert(staker, disclose(now));
  totalStakers.increment(1);
}

export circuit unstake(): [] {
  const staker = disclose(publicKey(localSecretKey()));
  assert(stakes.member(staker), "No active stake");

  const stakeTime = stakeTimestamps.lookup(staker);
  const now = getCurrentTime();
  assert(disclose(now >= stakeTime + lockPeriod), "Lock period not elapsed");

  stakes.remove(staker);
  stakeTimestamps.remove(staker);
  totalStakers.decrement(1);
}

export circuit claimReward(): [] {
  const staker = disclose(publicKey(localSecretKey()));
  assert(stakes.member(staker), "No active stake");

  const stakeTime = stakeTimestamps.lookup(staker);
  const now = getCurrentTime();
  assert(disclose(now >= stakeTime + lockPeriod), "Lock period not elapsed");

  const amount = stakes.lookup(staker);
  const rate = rewardRate;
  const reward = computeReward(amount, rate);

  // ZK-friendly division: witness computes reward = (amount * rate) / 10000,
  // circuit verifies via multiplication to avoid in-circuit division.
  assert(disclose(reward * (10000 as Uint<64>) == amount * rate),
         "Invalid reward calculation");

  rewardsClaimed.increment(1);
}

export circuit setRewardRate(newRate: Uint<64>): [] {
  assert(disclose(publicKey(localSecretKey()) == admin), "Only admin");
  rewardRate = disclose(newRate);
}

export circuit setLockPeriod(newPeriod: Uint<64>): [] {
  assert(disclose(publicKey(localSecretKey()) == admin), "Only admin");
  lockPeriod = disclose(newPeriod);
}
```

---

## Key Concepts

### ZK-Friendly Division

Compact supports basic arithmetic but integer division in-circuit can be
imprecise and expensive. The standard ZK pattern is:

1. **Witness computes** the quotient off-chain: `reward = (amount * rate) / 10000`
2. **Circuit verifies** via multiplication: `assert(reward * 10000 == amount * rate)`

This guarantees correctness without performing division in the circuit. The
witness `computeReward(amount, rate)` receives the staked amount and reward
rate as parameters and returns the computed reward. The circuit then verifies
the result is mathematically correct.

This pattern generalizes to any division: to prove `a / b == c`, the circuit
checks `c * b == a`. The prover cannot cheat because the multiplication check
is exact.

**Limitation:** This only works when `amount * rate` is evenly divisible by
10000. For production, either constrain amounts to multiples of 10000, or use
a rounding-aware verification: `assert(reward * 10000 <= amount * rate)` with
an upper bound check.

### Lock Period Enforcement

The `lockPeriod` is stored on-chain and checked against the time elapsed since
staking. The `getCurrentTime()` witness provides the current timestamp. The
circuit computes `stakeTime + lockPeriod` and asserts the current time is at
or beyond that point.

**Time witness limitation:** The timestamp is not cryptographically enforced.
The staker calling `unstake` or `claimReward` could submit a future timestamp
to bypass the lock period. In production, protocol-level time enforcement
(e.g., `blockTimeGreaterThan`) would be needed. However, the staker has no
incentive to unstake early in a well-designed staking system -- early unstaking
means forgoing future rewards.

### Basis Points for Reward Rate

The reward rate is stored in basis points (1 basis point = 0.01%). A rate of
500 means 5%, 1000 means 10%, etc. This avoids floating-point arithmetic
entirely. The formula is: `reward = (amount * rate) / 10000`.

### No Sequence Counter

This contract omits the sequence counter. Staker identities are long-lived --
a staker's public key is deterministic from their secret key. If a sequence
counter were used, the staker's public key would change after unstaking,
preventing them from re-staking with the same identity.

### Parameterized Witnesses

`computeReward(amount: Uint<64>, rate: Uint<64>)` demonstrates a witness that
receives parameters from the circuit. The circuit passes the staked amount and
reward rate to the witness, which computes the division off-chain. In the
TypeScript implementation, the parameters appear as additional arguments after
`WitnessContext`.

### Privacy Model

| Value | Visibility | Why |
|-------|-----------|-----|
| Secret key | **PRIVATE** | Never leaves the witness |
| Staker public key | **PUBLIC** | Stored on ledger for stake tracking |
| Staked amount | **PUBLIC** | Stored on ledger for reward calculation |
| Stake timestamp | **PUBLIC** | Stored on ledger for lock period enforcement |
| Reward amount | **PUBLIC** | Disclosed during verification assertion |
| Lock period | **PUBLIC** | Admin-set parameter on ledger |
| Reward rate | **PUBLIC** | Admin-set parameter on ledger |

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/staking/contract/index.js';

export interface StakingPrivateState {
  readonly secretKey: Uint8Array;
  readonly currentTime: bigint;
  readonly stakeAmount: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, StakingPrivateState>,
  ): [StakingPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getCurrentTime: (
    { privateState }: WitnessContext<Ledger, StakingPrivateState>,
  ): [StakingPrivateState, bigint] => {
    return [privateState, privateState.currentTime];
  },

  getStakeAmount: (
    { privateState }: WitnessContext<Ledger, StakingPrivateState>,
  ): [StakingPrivateState, bigint] => {
    return [privateState, privateState.stakeAmount];
  },

  computeReward: (
    { privateState }: WitnessContext<Ledger, StakingPrivateState>,
    amount: bigint,
    rate: bigint,
  ): [StakingPrivateState, bigint] => {
    // Off-chain division: reward = (amount * rate) / 10000
    // The circuit will verify this via multiplication.
    return [privateState, (amount * rate) / 10000n];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Admin, staker, and
non-admin use separate `Contract` instances with different witnesses. The
`getCurrentTime` witness is injected with controlled timestamps to test
lock period enforcement deterministically.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/staking/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const stakerKey = new Uint8Array(32); stakerKey[0] = 0x02;
const nobodyKey = new Uint8Array(32); nobodyKey[0] = 0x03;

const LOCK_PERIOD = 86400000n;   // 24 hours in ms
const REWARD_RATE = 500n;        // 5% (500 basis points)
const STAKE_AMOUNT = 10000n;     // Divisible by 10000/rate for clean reward math

const NOW = 1_000_000_000_000n;
const AFTER_LOCK = NOW + LOCK_PERIOD;
const BEFORE_LOCK = NOW + 1000n;

function makeWitnesses(sk, time = NOW, amount = STAKE_AMOUNT) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCurrentTime: ({ privateState }) => [privateState, time],
    getStakeAmount: ({ privateState }) => [privateState, amount],
    computeReward: ({ privateState }, amt, rate) => {
      return [privateState, (amt * rate) / 10000n];
    },
  };
}

describe("Staking", () => {
  let adminContract;
  let ctx;

  beforeEach(() => {
    adminContract = new Contract(makeWitnesses(adminKey));
    const addr = sampleContractAddress();
    const initial = adminContract.initialState(
      createConstructorContext({}, addr),
      LOCK_PERIOD,
      REWARD_RATE,
    );
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should stake tokens", () => {
    const staker = new Contract(makeWitnesses(stakerKey, NOW, STAKE_AMOUNT));
    const r = staker.impureCircuits.stake(ctx);
    expect(r.context).toBeDefined();
  });

  it("should reject unstake before lock period", () => {
    const staker = new Contract(makeWitnesses(stakerKey, NOW, STAKE_AMOUNT));
    const r1 = staker.impureCircuits.stake(ctx);
    const earlyUnstaker = new Contract(makeWitnesses(stakerKey, BEFORE_LOCK));
    expect(() => {
      earlyUnstaker.impureCircuits.unstake(r1.context);
    }).toThrow("Lock period not elapsed");
  });

  it("should unstake after lock period", () => {
    const staker = new Contract(makeWitnesses(stakerKey, NOW, STAKE_AMOUNT));
    const r1 = staker.impureCircuits.stake(ctx);
    const lateUnstaker = new Contract(makeWitnesses(stakerKey, AFTER_LOCK));
    const r2 = lateUnstaker.impureCircuits.unstake(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should claim rewards after lock period", () => {
    const staker = new Contract(makeWitnesses(stakerKey, NOW, STAKE_AMOUNT));
    const r1 = staker.impureCircuits.stake(ctx);
    const claimer = new Contract(makeWitnesses(stakerKey, AFTER_LOCK, STAKE_AMOUNT));
    const r2 = claimer.impureCircuits.claimReward(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should allow admin to set reward rate", () => {
    const r = adminContract.impureCircuits.setRewardRate(ctx, 1000n);
    expect(r.context).toBeDefined();
  });

  it("should reject non-admin from changing reward rate", () => {
    const nobody = new Contract(makeWitnesses(nobodyKey));
    expect(() => {
      nobody.impureCircuits.setRewardRate(ctx, 1000n);
    }).toThrow("Only admin");
  });
});
```

---

## CLI

```bash
compact compile src/staking.compact src/managed/staking
npm test
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly (5 exported circuits)
  and all 6 tests pass against Compact 0.29.0 with
  `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is moderate (k ~13-14). The `claimReward` circuit is the
  heaviest due to Map lookups, the witness call, and the multiplication
  verification assertion.
- **`Counter` tracks counts, not sums.** `totalStakers` counts the number of
  active stakers via `increment(1)`/`decrement(1)`. It does NOT sum staked
  amounts. `Counter` only supports increment/decrement by 1. For total value
  locked (TVL), use an off-chain indexer that reads the `stakes` Map.
- **Parameterized witness `computeReward(amount, rate)` works correctly.** The
  circuit passes two `Uint<64>` parameters to the witness. In TypeScript, these
  arrive as `bigint` arguments after `WitnessContext`.
- **Clean division constraint.** The test uses `STAKE_AMOUNT = 10000n` and
  `REWARD_RATE = 500n`, so `10000 * 500 / 10000 = 500` divides evenly. If the
  division is not exact, the multiplication check `reward * 10000 == amount * rate`
  will fail. Production contracts should handle rounding explicitly.
- **Staking is one-shot per identity.** A staker must unstake before re-staking.
  The `stakes.member` check prevents double-staking. For multiple concurrent
  stakes, use a composite key pattern: `hash(staker || stakeId)`.
- **`Map.remove` cleans up state.** The `unstake` circuit removes the staker
  from both `stakes` and `stakeTimestamps` Maps. This is important for allowing
  the staker to re-stake later.
- **Time witness for deterministic testing.** The `getCurrentTime` witness is
  injected with fixed timestamps (`NOW`, `BEFORE_LOCK`, `AFTER_LOCK`) to test
  lock period enforcement without relying on wall-clock time.
- **No actual token transfer.** This contract tracks staking accounting only.
  Real token movement would require coin operations (`receive`, `send`) on the
  Midnight UTXO layer. The staking contract would hold coin commitments and
  release them on unstake.
- **Reward rate changes affect all stakers.** When the admin calls
  `setRewardRate`, the new rate applies to all future `claimReward` calls,
  including existing stakers. For fair rate transitions, add a per-staker
  snapshot of the rate at stake time.
