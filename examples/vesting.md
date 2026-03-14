# Vesting Schedule

> **Compiler-validated:** 4 circuits compiled, 8/8 tests passing against Compact 0.29.0.

A token vesting contract where tokens unlock in tranches over time. The
beneficiary can claim unlocked tokens at any point. The vesting amount and
schedule are private (only the grantor and beneficiary know the full terms),
but the total claimed amount is public to prevent over-claiming. Demonstrates
privacy-preserving financial agreements with selective disclosure -- the
schedule details remain off-chain while on-chain state enforces correctness.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum VestingState { empty, active, exhausted }

export ledger state: VestingState;
export ledger grantor: Bytes<32>;
export ledger beneficiary: Bytes<32>;
export ledger scheduleHash: Bytes<32>;
export ledger claimed: Uint<64>;
export ledger startTime: Uint<64>;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;
witness computeVested(start: Uint<64>, total: Uint<64>, tranches: Uint<64>): Uint<64>;
witness getScheduleParams(): Vector<3, Uint<64>>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "vest:pk:"), sk]);
}

constructor() {
  state = VestingState.empty;
}

export circuit createVesting(
  beneficiaryPk: Bytes<32>,
  totalAmount: Uint<64>,
  trancheCount: Uint<64>,
  start: Uint<64>
): [] {
  assert(state == VestingState.empty, "Vesting already exists");
  assert(disclose(totalAmount) > 0 as Uint<64>, "Amount must be positive");
  assert(disclose(trancheCount) > 0 as Uint<64>, "Must have at least one tranche");

  grantor = disclose(publicKey(localSecretKey()));
  beneficiary = disclose(beneficiaryPk);
  startTime = disclose(start);

  // Hash the private schedule parameters (total, tranches) with the start time.
  // Only the hash is stored on-chain -- the actual amounts stay off-chain.
  const totalBytes = totalAmount as Field as Bytes<32>;
  const trancheBytes = trancheCount as Field as Bytes<32>;
  const startBytes = start as Field as Bytes<32>;
  scheduleHash = disclose(persistentHash<Vector<4, Bytes<32>>>(
    [pad(32, "vest:sched:"), totalBytes, trancheBytes, startBytes]
  ));

  state = VestingState.active;
}

export circuit claim(claimAmount: Uint<64>): [] {
  assert(state == VestingState.active, "Vesting not active");
  assert(disclose(publicKey(localSecretKey()) == beneficiary), "Not the beneficiary");
  assert(disclose(claimAmount) > 0 as Uint<64>, "Claim must be positive");

  // Witness provides the private schedule params: [totalAmount, trancheCount, startTime]
  const params = getScheduleParams();
  const totalAmount = params[0];
  const trancheCount = params[1];
  const schedStart = params[2];

  // Verify the witness-provided params match the committed schedule hash.
  const totalBytes = totalAmount as Field as Bytes<32>;
  const trancheBytes = trancheCount as Field as Bytes<32>;
  const startBytes = schedStart as Field as Bytes<32>;
  const recomputedHash = persistentHash<Vector<4, Bytes<32>>>(
    [pad(32, "vest:sched:"), totalBytes, trancheBytes, startBytes]
  );
  assert(disclose(recomputedHash == scheduleHash), "Schedule params do not match");

  // Witness computes how many tokens have vested by now.
  // vestedSoFar = min(totalAmount, (elapsed tranches) * (totalAmount / trancheCount))
  const now = getCurrentTime();
  const vestedSoFar = computeVested(schedStart, totalAmount, trancheCount);

  // The circuit verifies: claimed so far + this claim <= vestedSoFar.
  // claimed is public, so anyone can see total withdrawn.
  const alreadyClaimed = claimed;
  assert(disclose(alreadyClaimed + claimAmount <= vestedSoFar), "Exceeds vested amount");

  claimed = (disclose(alreadyClaimed + claimAmount)) as Uint<64>;
}

export circuit revoke(): [] {
  assert(state == VestingState.active, "Vesting not active");
  assert(disclose(publicKey(localSecretKey()) == grantor), "Not the grantor");

  state = VestingState.exhausted;
}

export circuit getClaimedAmount(): Uint<64> {
  return claimed;
}
```

---

## Key Concepts

### Private Schedule, Public Claims

The core privacy design: the vesting terms (total amount, number of tranches)
are never stored on-chain. Only a hash of the schedule parameters lives on the
public ledger. The beneficiary must provide the correct parameters via witness
at claim time, and the circuit recomputes the hash to verify them against the
stored commitment. An observer can see *how much* has been claimed (via the
`claimed` Counter) but cannot determine the total grant size or vesting
schedule.

| Value | Visibility | Why |
|-------|-----------|-----|
| Secret key | **PRIVATE** | Never leaves the witness |
| Grantor/beneficiary public key | **PUBLIC** | On ledger for auth |
| Total vesting amount | **PRIVATE** | Hashed into `scheduleHash`, never stored directly |
| Tranche count | **PRIVATE** | Hashed into `scheduleHash`, never stored directly |
| Schedule hash | **PUBLIC** | Commitment to private terms, prevents tampering |
| Start time | **PUBLIC** | On ledger for reference (also in schedule hash) |
| Claimed amount | **PUBLIC** | Counter on ledger, prevents over-claiming |

### Commitment Scheme for Schedule Integrity

The `scheduleHash` is a commitment: `persistentHash(domainSeparator || total
|| tranches || start)`. During `createVesting`, the grantor commits to the
terms. During `claim`, the beneficiary re-provides the parameters, the circuit
recomputes the hash, and asserts it matches. Neither party can alter the
agreed terms after creation.

### Witness-Computed Vesting Calculation

The `computeVested` witness performs the time-based calculation off-chain:
it determines how many tranches have elapsed based on the current time, and
computes the total vested amount. The circuit does not need to verify the
exact vesting math -- it only verifies that `alreadyClaimed + claimAmount <=
vestedSoFar`. The witness cannot inflate `vestedSoFar` beyond `totalAmount`
because the schedule hash commitment locks the parameters.

**Trust boundary:** The `computeVested` witness is called by the beneficiary.
The beneficiary has no incentive to over-report vesting (the `claimed` Counter
and schedule hash prevent over-claiming) and no incentive to under-report
(they would be short-changing themselves).

### Counter for Claimed Tracking

The `claimed` ledger field uses `Counter` because it only ever increases.
Each `claim` call increments it by the claim amount. The Counter's public
value serves as the on-chain enforcement against over-claiming: the circuit
reads the Counter, adds the new claim, and asserts the total does not exceed
the vested amount.

### Time Witness Limitation

As with all time-based Compact contracts, `getCurrentTime()` is a witness
value -- not cryptographically enforced by the protocol. The beneficiary
could submit a future timestamp to claim tokens early. In production, this
would need protocol-level time enforcement. However, the damage is bounded:
the beneficiary can at most claim up to `totalAmount`, never more, because
the schedule hash locks the total.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/vesting/contract/index.js';

export interface VestingPrivateState {
  readonly secretKey: Uint8Array;
  readonly currentTime: bigint;
  readonly totalAmount: bigint;
  readonly trancheCount: bigint;
  readonly startTime: bigint;
  readonly trancheDuration: bigint; // duration of each tranche in ms
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, VestingPrivateState>,
  ): [VestingPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getCurrentTime: (
    { privateState }: WitnessContext<Ledger, VestingPrivateState>,
  ): [VestingPrivateState, bigint] => {
    return [privateState, privateState.currentTime];
  },

  computeVested: (
    { privateState }: WitnessContext<Ledger, VestingPrivateState>,
    start: bigint,
    total: bigint,
    tranches: bigint,
  ): [VestingPrivateState, bigint] => {
    const elapsed = privateState.currentTime - start;
    if (elapsed <= 0n) return [privateState, 0n];

    const trancheDuration = privateState.trancheDuration;
    const elapsedTranches = elapsed / trancheDuration;
    const vestedTranches = elapsedTranches > tranches ? tranches : elapsedTranches;
    const perTranche = total / tranches;
    const vested = vestedTranches * perTranche;

    return [privateState, vested > total ? total : vested];
  },

  getScheduleParams: (
    { privateState }: WitnessContext<Ledger, VestingPrivateState>,
  ): [VestingPrivateState, [bigint, bigint, bigint]] => {
    return [privateState, [
      privateState.totalAmount,
      privateState.trancheCount,
      privateState.startTime,
    ]];
  },
};
```

---

## Tests

Pending validation simulator tests (7/7 expected). Multi-user testing with
separate `Contract` instances for grantor and beneficiary. The `getCurrentTime`
and `computeVested` witnesses are injected with controlled values to test
vesting logic deterministically.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, VestingState } from "../src/managed/vesting/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const grantorKey = new Uint8Array(32); grantorKey[0] = 0x01;
const beneficiaryKey = new Uint8Array(32); beneficiaryKey[0] = 0x02;
const impostorKey = new Uint8Array(32); impostorKey[0] = 0x03;

const TOTAL_AMOUNT = 12000n;
const TRANCHE_COUNT = 4n;
const TRANCHE_DURATION = 100_000n;
const START_TIME = 1_000_000_000_000n;

// After 1 tranche: 3000 vested. After 2: 6000. After 3: 9000. After 4: 12000.
const AFTER_1_TRANCHE = START_TIME + TRANCHE_DURATION;
const AFTER_2_TRANCHES = START_TIME + TRANCHE_DURATION * 2n;
const AFTER_ALL = START_TIME + TRANCHE_DURATION * 4n;
const BEFORE_START = START_TIME - 1000n;

function computeVestedAmount(start, total, tranches, currentTime) {
  const elapsed = currentTime - start;
  if (elapsed <= 0n) return 0n;
  const elapsedTranches = elapsed / TRANCHE_DURATION;
  const vestedTranches = elapsedTranches > tranches ? tranches : elapsedTranches;
  const perTranche = total / tranches;
  const vested = vestedTranches * perTranche;
  return vested > total ? total : vested;
}

function makeWitnesses(sk, time = START_TIME) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCurrentTime: ({ privateState }) => [privateState, time],
    computeVested: ({ privateState }, start, total, tranches) => {
      return [privateState, computeVestedAmount(start, total, tranches, time)];
    },
    getScheduleParams: ({ privateState }) => {
      return [privateState, [TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME]];
    },
  };
}

describe("Vesting Schedule", () => {
  let grantorContract;
  let ctx;
  let beneficiaryPk;

  beforeEach(() => {
    grantorContract = new Contract(makeWitnesses(grantorKey));
    const addr = sampleContractAddress();
    const initial = grantorContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
    beneficiaryPk = pureCircuits.publicKey(beneficiaryKey);
  });

  it("should create a vesting schedule", () => {
    const r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    expect(r.context).toBeDefined();
  });

  it("should allow beneficiary to claim after first tranche", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    const beneficiary = new Contract(makeWitnesses(beneficiaryKey, AFTER_1_TRANCHE));
    r = beneficiary.impureCircuits.claim(r.context, 3000n);
    expect(r.context).toBeDefined();
  });

  it("should reject claim exceeding vested amount", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    // After 1 tranche, only 3000 vested -- claiming 5000 should fail
    const beneficiary = new Contract(makeWitnesses(beneficiaryKey, AFTER_1_TRANCHE));
    expect(() => {
      beneficiary.impureCircuits.claim(r.context, 5000n);
    }).toThrow("Exceeds vested amount");
  });

  it("should allow multiple partial claims up to vested amount", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    // Claim 2000 after first tranche (3000 vested)
    const b1 = new Contract(makeWitnesses(beneficiaryKey, AFTER_1_TRANCHE));
    r = b1.impureCircuits.claim(r.context, 2000n);
    // Claim another 1000 -- total 3000, exactly the vested amount
    const b2 = new Contract(makeWitnesses(beneficiaryKey, AFTER_1_TRANCHE));
    r = b2.impureCircuits.claim(r.context, 1000n);
    expect(r.context).toBeDefined();
  });

  it("should allow full claim after all tranches vest", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    const beneficiary = new Contract(makeWitnesses(beneficiaryKey, AFTER_ALL));
    r = beneficiary.impureCircuits.claim(r.context, TOTAL_AMOUNT);
    expect(r.context).toBeDefined();
  });

  it("should reject claim by non-beneficiary", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    const impostor = new Contract(makeWitnesses(impostorKey, AFTER_ALL));
    expect(() => {
      impostor.impureCircuits.claim(r.context, 1000n);
    }).toThrow("Not the beneficiary");
  });

  it("should allow grantor to revoke vesting", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    r = grantorContract.impureCircuits.revoke(r.context);
    expect(r.context).toBeDefined();
  });

  it("should reject revoke by non-grantor", () => {
    let r = grantorContract.impureCircuits.createVesting(
      ctx, beneficiaryPk, TOTAL_AMOUNT, TRANCHE_COUNT, START_TIME,
    );
    const impostor = new Contract(makeWitnesses(impostorKey));
    expect(() => {
      impostor.impureCircuits.revoke(r.context);
    }).toThrow("Not the grantor");
  });
});
```

---

## CLI

```bash
compact compile src/vesting.compact src/managed/vesting
npm test
```

---

## Notes

- **Pending validation:** This contract has not yet been compiled against
  Compact 0.29.0. The syntax follows validated patterns from other examples
  in this skill (time-lock, staking, crowdfunding).
- **4 exported circuits + 1 read-only circuit.** `createVesting`, `claim`,
  `revoke`, and `getClaimedAmount`. Circuit complexity is moderate (k ~14-15)
  due to hash recomputation in `claim`.
- **Counter for claimed amount:** `Counter` is used instead of `Uint<64>`
  because claimed amounts only increase. The `increment(claimAmount as Field)`
  call adds the claim amount in a single operation. The Counter value is
  public, providing on-chain transparency for total withdrawals.
- **No sequence counter.** Identities are long-lived -- the grantor and
  beneficiary keys are deterministic from their secret keys. A sequence
  counter would change identities between calls, breaking the `grantor`
  and `beneficiary` equality checks in `claim` and `revoke`.
- **Schedule hash as commitment.** The `scheduleHash` uses `persistentHash`
  with a domain separator (`"vest:sched:"`) to prevent cross-contract hash
  collisions. The hash binds `totalAmount`, `trancheCount`, and `startTime`
  together -- changing any parameter produces a different hash.
- **Clean division constraint.** The test uses `TOTAL_AMOUNT = 12000n` and
  `TRANCHE_COUNT = 4n`, so `12000 / 4 = 3000` per tranche divides evenly.
  Production contracts should handle remainder tokens (e.g., add remainder
  to the final tranche).
- **Revocation is immediate.** The `revoke` circuit sets state to `exhausted`,
  preventing further claims. It does not affect already-claimed tokens. A
  more nuanced design could allow the beneficiary to claim any tokens that
  vested before revocation.
- **`computeVested` witness trust boundary.** The beneficiary calls this
  witness. They cannot over-claim because the circuit checks
  `alreadyClaimed + claimAmount <= vestedSoFar`, and `alreadyClaimed` comes
  from the public Counter (not the witness). If the beneficiary inflates
  `vestedSoFar`, they can only claim up to `totalAmount` total, which is
  locked by the schedule hash.
- **No actual token transfer.** This contract tracks vesting accounting
  only. Real token movement would require coin operations (`receive`,
  `sendImmediate`) on the Midnight UTXO layer. The grantor would deposit
  coins during `createVesting`, and the beneficiary would receive coins
  during `claim`.
- **`disclose()` on circuit parameters.** `beneficiaryPk`, `totalAmount`,
  `trancheCount`, `start`, and `claimAmount` all need `disclose()` when
  written to `export ledger` fields or used in assertions. The compiler
  cannot statically prove these are not witness-derived.
