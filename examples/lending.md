# Lending

> **Compiler-validated:** Contract compiles (6 circuits) and 6/6 tests pass against Compact 0.29.0.

A DeFi lending/borrowing contract with collateralization ratios, health factor
enforcement, and liquidation. Borrowers deposit collateral and take loans up
to a configurable ratio. Anyone can liquidate undercollateralized positions.
Demonstrates ZK-friendly arithmetic (multiplication cross-comparison instead
of division), in-circuit health factor checks, and the core DeFi lending
primitive adapted for Midnight's privacy model.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger collaterals: Map<Bytes<32>, Uint<64>>;
export ledger loans: Map<Bytes<32>, Uint<64>>;
export ledger collateralRatio: Uint<64>;
export ledger liquidationThreshold: Uint<64>;
export ledger totalDeposited: Counter;
export ledger totalBorrowed: Counter;

witness localSecretKey(): Bytes<32>;
witness getDepositAmount(): Uint<64>;
witness getBorrowAmount(): Uint<64>;
witness getRepayAmount(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "lend:pk:"), sk]);
}

constructor(ratio: Uint<64>, threshold: Uint<64>) {
  admin = disclose(publicKey(localSecretKey()));
  collateralRatio = disclose(ratio);
  liquidationThreshold = disclose(threshold);
}

export circuit depositCollateral(): [] {
  const caller = disclose(publicKey(localSecretKey()));
  const amount = getDepositAmount();
  assert(disclose(amount) > 0 as Uint<64>, "Amount must be positive");

  if (collaterals.member(caller)) {
    const current = collaterals.lookup(caller);
    collaterals.insert(caller, disclose((current + amount) as Uint<64>));
  } else {
    collaterals.insert(caller, disclose(amount));
  }
  totalDeposited.increment(1);
}

export circuit borrow(): [] {
  const caller = disclose(publicKey(localSecretKey()));
  assert(collaterals.member(caller), "No collateral deposited");

  const borrowAmount = getBorrowAmount();
  assert(disclose(borrowAmount) > 0 as Uint<64>, "Amount must be positive");

  const collateral = collaterals.lookup(caller);

  // Determine current loan balance
  // If no existing loan, treat as zero; otherwise add to existing
  if (loans.member(caller)) {
    const currentLoan = loans.lookup(caller);
    const newLoan = (currentLoan + borrowAmount) as Uint<64>;
    // Collateral ratio check: collateral * 100 >= newLoan * collateralRatio
    // This avoids division, which is not ZK-friendly
    assert(disclose(collateral * 100 as Uint<64> >= newLoan * collateralRatio),
           "Insufficient collateral");
    loans.insert(caller, disclose(newLoan));
  } else {
    // First loan: collateral * 100 >= borrowAmount * collateralRatio
    assert(disclose(collateral * 100 as Uint<64> >= borrowAmount * collateralRatio),
           "Insufficient collateral");
    loans.insert(caller, disclose(borrowAmount));
  }
  totalBorrowed.increment(1);
}

export circuit repay(): [] {
  const caller = disclose(publicKey(localSecretKey()));
  assert(loans.member(caller), "No outstanding loan");

  const repayAmount = getRepayAmount();
  assert(disclose(repayAmount) > 0 as Uint<64>, "Amount must be positive");

  const currentLoan = loans.lookup(caller);
  assert(disclose(repayAmount <= currentLoan), "Repay exceeds loan balance");

  const remaining = (currentLoan - repayAmount) as Uint<64>;
  if (disclose(remaining == 0 as Uint<64>)) {
    loans.remove(caller);
  } else {
    loans.insert(caller, disclose(remaining));
  }
  totalBorrowed.decrement(1);
}

export circuit liquidate(borrower: Bytes<32>): [] {
  assert(loans.member(disclose(borrower)), "No outstanding loan");
  assert(collaterals.member(disclose(borrower)), "No collateral");

  const collateral = collaterals.lookup(disclose(borrower));
  const loan = loans.lookup(disclose(borrower));

  // Liquidation check: collateral * 100 < loan * liquidationThreshold
  // Position is unhealthy when collateral ratio drops below threshold
  assert(disclose(collateral * 100 as Uint<64> < loan * liquidationThreshold),
         "Position is healthy");

  // Clear the position
  loans.remove(disclose(borrower));
  collaterals.remove(disclose(borrower));
  totalBorrowed.decrement(1);
  totalDeposited.decrement(1);
}

export circuit withdrawCollateral(): [] {
  const caller = disclose(publicKey(localSecretKey()));
  assert(collaterals.member(caller), "No collateral deposited");
  assert(!loans.member(caller), "Outstanding loan exists");

  collaterals.remove(caller);
  totalDeposited.decrement(1);
}

export circuit setParameters(ratio: Uint<64>, threshold: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(disclose(ratio) > disclose(threshold), "Ratio must exceed threshold");
  collateralRatio = disclose(ratio);
  liquidationThreshold = disclose(threshold);
}
```

---

## Key Concepts

### No Sequence Counter

Like the multi-sig and access-control examples, this contract omits the
sequence counter. Borrower positions are tracked by public key in Maps, and
if a sequence counter were used in key derivation, any state change would
invalidate all stored position keys. Deterministic keys (derived only from
the secret key) are correct for long-lived positions.

### Multiplication Cross-Comparison for Ratios

Division and modulo are not available in Compact circuits. All ratio checks
use multiplication cross-comparison:

```
Instead of:  collateral / loan >= 1.5  (150%)
Use:         collateral * 100 >= loan * 150
```

This is both ZK-friendly (multiplication is a native field operation) and
avoids precision issues entirely. The `collateralRatio` and
`liquidationThreshold` are stored as percentages (e.g., 150 = 150%,
120 = 120%), and the comparison multiplies both sides by appropriate
constants.

### Health Factor and Liquidation

The health factor determines whether a position can be liquidated:
- **Healthy:** `collateral * 100 >= loan * liquidationThreshold`
- **Unhealthy:** `collateral * 100 < loan * liquidationThreshold`

Anyone can call `liquidate` on an unhealthy position -- this is the
permissionless liquidation pattern common in DeFi. The liquidator does not
need to be the borrower or admin.

### Two-Threshold Design

The contract uses two separate thresholds:
- **`collateralRatio`** (e.g., 150): minimum ratio to open or increase a
  loan. Enforced in the `borrow` circuit.
- **`liquidationThreshold`** (e.g., 120): the point below which a position
  can be liquidated. Enforced in the `liquidate` circuit.

The gap between these (150 vs 120) provides a buffer zone. A borrower at
140% collateral cannot borrow more, but also cannot be liquidated yet.

### Simplified Value Tracking

This example tracks collateral and loan amounts in Map entries but does not
move real coins on the UTXO layer. Production lending would use coin
operations (`receive`, `sendImmediate`) for actual asset deposits,
withdrawals, and liquidation proceeds.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/lending/contract/index.js';

export interface LendingPrivateState {
  readonly secretKey: Uint8Array;
  readonly depositAmount: bigint;
  readonly borrowAmount: bigint;
  readonly repayAmount: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, LendingPrivateState>,
  ): [LendingPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getDepositAmount: (
    { privateState }: WitnessContext<Ledger, LendingPrivateState>,
  ): [LendingPrivateState, bigint] => {
    return [privateState, privateState.depositAmount];
  },

  getBorrowAmount: (
    { privateState }: WitnessContext<Ledger, LendingPrivateState>,
  ): [LendingPrivateState, bigint] => {
    return [privateState, privateState.borrowAmount];
  },

  getRepayAmount: (
    { privateState }: WitnessContext<Ledger, LendingPrivateState>,
  ): [LendingPrivateState, bigint] => {
    return [privateState, privateState.repayAmount];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Tests cover the full
lending lifecycle: deposit, borrow, repay, liquidation, and withdrawal.
Ratio enforcement is validated by testing both within-ratio and over-ratio
borrows.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/lending/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const borrower1Key = new Uint8Array(32); borrower1Key[0] = 0x02;
const borrower2Key = new Uint8Array(32); borrower2Key[0] = 0x03;
const liquidatorKey = new Uint8Array(32); liquidatorKey[0] = 0x04;

const COLLATERAL_RATIO = 150n;  // 150%
const LIQUIDATION_THRESHOLD = 120n;  // 120%

function makeWitnesses(sk, deposit = 0n, borrow = 0n, repay = 0n) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getDepositAmount: ({ privateState }) => [privateState, deposit],
    getBorrowAmount: ({ privateState }) => [privateState, borrow],
    getRepayAmount: ({ privateState }) => [privateState, repay],
  };
}

describe("Lending", () => {
  let adminContract, ctx, borrower1Pk;

  beforeEach(() => {
    adminContract = new Contract(makeWitnesses(adminKey));
    const addr = sampleContractAddress();
    const initial = adminContract.initialState(
      createConstructorContext({}, addr), COLLATERAL_RATIO, LIQUIDATION_THRESHOLD
    );
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
    borrower1Pk = pureCircuits.publicKey(borrower1Key);
  });

  it("should deposit and borrow within ratio", () => {
    // Deposit 300, borrow 200: 300*100=30000 >= 200*150=30000 (exactly at ratio)
    const depositor = new Contract(makeWitnesses(borrower1Key, 300n));
    let r = depositor.impureCircuits.depositCollateral(ctx);
    const borrower = new Contract(makeWitnesses(borrower1Key, 0n, 200n));
    r = borrower.impureCircuits.borrow(r.context);
    expect(r.context).toBeDefined();
  });

  it("should reject over-borrow", () => {
    // Deposit 150, try to borrow 200: 150*100=15000 < 200*150=30000
    const depositor = new Contract(makeWitnesses(borrower1Key, 150n));
    let r = depositor.impureCircuits.depositCollateral(ctx);
    const borrower = new Contract(makeWitnesses(borrower1Key, 0n, 200n));
    expect(() => {
      borrower.impureCircuits.borrow(r.context);
    }).toThrow("Insufficient collateral");
  });

  it("should repay loan", () => {
    const depositor = new Contract(makeWitnesses(borrower1Key, 300n));
    let r = depositor.impureCircuits.depositCollateral(ctx);
    const borrower = new Contract(makeWitnesses(borrower1Key, 0n, 100n));
    r = borrower.impureCircuits.borrow(r.context);
    const repayer = new Contract(makeWitnesses(borrower1Key, 0n, 0n, 100n));
    r = repayer.impureCircuits.repay(r.context);
    expect(r.context).toBeDefined();
  });

  it("should liquidate unhealthy position", () => {
    // Deposit 120, borrow 80: 120*100=12000 >= 80*150=12000 (at ratio, OK)
    // Then check liquidation: 120*100=12000 < 80*120=9600? No, 12000 >= 9600, healthy.
    // Need a scenario where collateral drops relative to loan.
    // Deposit 100, borrow 66: 100*100=10000 >= 66*150=9900 (just above, OK)
    // Liquidation check: 100*100=10000 < 66*120=7920? No, still healthy.
    // For testing, set tight parameters: ratio=150, threshold=120
    // Deposit 120, borrow 80: ratio check 120*100=12000 >= 80*150=12000 (OK)
    // Now setParameters to raise threshold to 160
    // Liquidation check: 120*100=12000 < 80*160=12800? Yes, liquidatable!
    const depositor = new Contract(makeWitnesses(borrower1Key, 120n));
    let r = depositor.impureCircuits.depositCollateral(ctx);
    const borrower = new Contract(makeWitnesses(borrower1Key, 0n, 80n));
    r = borrower.impureCircuits.borrow(r.context);
    // Raise threshold to make position unhealthy
    r = adminContract.impureCircuits.setParameters(r.context, 200n, 160n);
    const liquidator = new Contract(makeWitnesses(liquidatorKey));
    r = liquidator.impureCircuits.liquidate(r.context, borrower1Pk);
    expect(r.context).toBeDefined();
  });

  it("should reject liquidation of healthy position", () => {
    // Deposit 300, borrow 100: 300*100=30000 vs 100*120=12000 -- healthy
    const depositor = new Contract(makeWitnesses(borrower1Key, 300n));
    let r = depositor.impureCircuits.depositCollateral(ctx);
    const borrower = new Contract(makeWitnesses(borrower1Key, 0n, 100n));
    r = borrower.impureCircuits.borrow(r.context);
    const liquidator = new Contract(makeWitnesses(liquidatorKey));
    expect(() => {
      liquidator.impureCircuits.liquidate(r.context, borrower1Pk);
    }).toThrow("Position is healthy");
  });

  it("should withdraw after full repayment", () => {
    const depositor = new Contract(makeWitnesses(borrower1Key, 300n));
    let r = depositor.impureCircuits.depositCollateral(ctx);
    const borrower = new Contract(makeWitnesses(borrower1Key, 0n, 100n));
    r = borrower.impureCircuits.borrow(r.context);
    const repayer = new Contract(makeWitnesses(borrower1Key, 0n, 0n, 100n));
    r = repayer.impureCircuits.repay(r.context);
    const withdrawer = new Contract(makeWitnesses(borrower1Key));
    r = withdrawer.impureCircuits.withdrawCollateral(r.context);
    expect(r.context).toBeDefined();
  });
});
```

---

## CLI

```bash
compact compile src/lending.compact src/managed/lending
npm test
```

---

## Notes

- **Compiler-validated:** 6 circuits compiled, 6/6 tests pass against Compact 0.29.0.
- **No division in ZK circuits:** All ratio checks use multiplication
  cross-comparison. `collateral * 100 >= loan * ratio` is equivalent to
  `collateral / loan >= ratio / 100` but avoids division entirely. This is
  both ZK-friendly (field multiplication is cheap) and avoids truncation
  precision issues.
- **Basis-point precision:** The ratio values (150, 120) represent
  percentages. For finer control, use basis points (15000, 12000) and
  multiply by 10000 instead of 100. This gives 0.01% precision without
  changing the circuit logic.
- **No sequence counter:** Long-lived borrower positions are keyed by
  deterministic public keys. A sequence counter would invalidate all
  position references on any state transition.
- **Permissionless liquidation:** Anyone can call `liquidate` on an unhealthy
  position. In production, the liquidator would receive a portion of the
  collateral as incentive (liquidation bonus), implemented via coin
  operations.
- **No interest accrual:** This example does not compute interest over time.
  Interest in ZK circuits would require a time witness and in-circuit
  multiplication, or periodic off-chain rebalancing with on-chain
  verification.
- Circuit complexity is moderate (k ~14-15). The `borrow` circuit is the
  heaviest due to Map lookups, conditional branching, and the multiplication
  comparison. The `liquidate` circuit is similarly heavy with two Map
  lookups and a Map removal.
- **Overflow considerations:** `collateral * 100` on `Uint<64>` can overflow
  for very large values. For production, use `Uint<128>` for intermediate
  computation or cap maximum deposit/loan amounts.
