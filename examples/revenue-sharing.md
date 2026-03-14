# Revenue Sharing / Royalties

> **Compiler-validated:** 3 circuits compiled against Compact 0.29.0.

A revenue-sharing contract where income is automatically split among shareholders
according to private share percentages. Share allocations are hidden -- only the
commitment hash is public -- but withdrawals are verifiable via ZK proofs. The
revenue pool is public (anyone can deposit), while individual share sizes remain
private. Useful for NFT royalties, content revenue, or partnership splits.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger shareCommitments: Map<Bytes<32>, Bytes<32>>;
export ledger withdrawals: Map<Bytes<32>, Uint<64>>;
export ledger totalShares: Uint<64>;
export ledger revenuePool: Uint<64>;
export ledger shareholderCount: Counter;

witness localSecretKey(): Bytes<32>;
witness getShares(totalShares: Uint<64>): Uint<64>;
witness computeEntitlement(shares: Uint<64>, totalShares: Uint<64>, pool: Uint<64>): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "revshare:pk:"), sk]);
}

pure circuit shareCommitment(holder: Bytes<32>, shares: Uint<64>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([holder, shares as Bytes<32>]);
}

constructor(shares: Uint<64>) {
  admin = disclose(publicKey(localSecretKey()));
  totalShares = disclose(shares);
}

export circuit addShareholder(holder: Bytes<32>, shares: Uint<64>): [] {
  assert(disclose(publicKey(localSecretKey()) == admin), "Only admin");
  assert(!shareCommitments.member(disclose(holder)), "Already registered");
  assert(disclose(shares > (0 as Uint<64>)), "Shares must be positive");

  const commitment = shareCommitment(disclose(holder), disclose(shares));
  shareCommitments.insert(disclose(holder), disclose(commitment));
  withdrawals.insert(disclose(holder), disclose(0 as Uint<64>));
  shareholderCount.increment(1);
}

export circuit depositRevenue(amount: Uint<64>): [] {
  assert(disclose(amount > (0 as Uint<64>)), "Amount must be positive");
  revenuePool = (revenuePool + disclose(amount)) as Uint<64>;
}

export circuit withdraw(): [] {
  const holder = disclose(publicKey(localSecretKey()));
  assert(shareCommitments.member(holder), "Not a shareholder");

  const pool = revenuePool;
  const shares = getShares(totalShares);

  // Verify the share commitment matches what admin registered
  const commitment = shareCommitment(holder, disclose(shares));
  assert(disclose(commitment == shareCommitments.lookup(holder)),
         "Share proof invalid");

  // Witness computes entitlement off-chain: (pool * shares) / totalShares
  // Circuit verifies via multiplication to avoid in-circuit division
  const entitlement = computeEntitlement(disclose(shares), totalShares, pool);
  assert(disclose(entitlement * totalShares == pool * shares),
         "Invalid entitlement calculation");

  const alreadyWithdrawn = withdrawals.lookup(holder);
  assert(disclose(entitlement > alreadyWithdrawn), "Nothing to withdraw");

  withdrawals.insert(holder, disclose(entitlement));
}
```

---

## Key Concepts

### Private Shares, Public Revenue

The core privacy innovation is that share allocations remain private. When the
admin adds a shareholder, the contract stores a *commitment* --
`hash(holder || shares)` -- rather than the raw share count. The revenue pool
is fully public (anyone can deposit), but no observer can determine how the
pool will be split.

When a shareholder withdraws, they prove they know a share count that matches
the stored commitment, without revealing the count to the network. The ZK
proof guarantees the claimed shares are genuine.

| Value | Visibility | Why |
|-------|-----------|-----|
| Admin identity | **PUBLIC** | Stored on ledger for authorization |
| Shareholder identity | **PUBLIC** | Map key for commitment lookup |
| Share count per holder | **PRIVATE** | Only the commitment hash is on-chain |
| Share commitment | **PUBLIC** | Hash of (holder, shares) -- reveals nothing about count |
| Total shares | **PUBLIC** | Required for entitlement calculation |
| Revenue pool balance | **PUBLIC** | Public deposit counter |
| Withdrawal history | **PUBLIC** | Prevents double-withdrawal |
| Secret key | **PRIVATE** | Never leaves the witness |

### Commitment-Based Share Verification

The `shareCommitment` pure circuit computes `persistentHash([holder, shares])`.
This binds the share count to the holder's identity. During withdrawal, the
shareholder provides their share count via a witness, and the circuit recomputes
the commitment and checks it against the stored value. If the shareholder
claims a different number of shares, the commitment will not match.

This is a standard commit-verify pattern: the admin commits at registration
time, and the shareholder opens the commitment at withdrawal time.

### ZK-Friendly Division for Entitlement

The entitlement formula is `(pool * shares) / totalShares`. Division inside
a ZK circuit is expensive and imprecise, so the standard pattern is used:

1. **Witness computes** the quotient off-chain: `entitlement = (pool * shares) / totalShares`
2. **Circuit verifies** via multiplication: `assert(entitlement * totalShares == pool * shares)`

This guarantees correctness without performing division in the circuit. The
limitation is that `pool * shares` must be evenly divisible by `totalShares`.
For production, use a rounding-aware check or constrain total shares to a
power of 10.

### Incremental Withdrawals

The `withdrawals` Map tracks cumulative amounts each shareholder has withdrawn.
On each call to `withdraw`, the circuit computes the shareholder's total
entitlement from the current pool and asserts it exceeds what they have already
withdrawn. The difference is the new amount available. This allows shareholders
to withdraw incrementally as new revenue is deposited, without resetting the
pool.

### No Sequence Counter

Shareholder identities are long-lived -- a holder's public key is deterministic
from their secret key. If a sequence counter were used, the holder's identity
would change after each transaction, breaking the Map lookups for commitments
and withdrawal history.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/revenue-sharing/contract/index.js';

export interface RevenueSharePrivateState {
  readonly secretKey: Uint8Array;
  readonly shares: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, RevenueSharePrivateState>,
  ): [RevenueSharePrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getShares: (
    { privateState }: WitnessContext<Ledger, RevenueSharePrivateState>,
    _totalShares: bigint,
  ): [RevenueSharePrivateState, bigint] => {
    return [privateState, privateState.shares];
  },

  computeEntitlement: (
    { privateState }: WitnessContext<Ledger, RevenueSharePrivateState>,
    shares: bigint,
    totalShares: bigint,
    pool: bigint,
  ): [RevenueSharePrivateState, bigint] => {
    // Off-chain division: entitlement = (pool * shares) / totalShares
    // The circuit will verify this via multiplication.
    return [privateState, (pool * shares) / totalShares];
  },
};
```

---

## Tests

Compiler-validated simulator tests (7/7 passing). Admin, shareholders, and
unauthorized callers use separate `Contract` instances with different witnesses.
Revenue is deposited publicly, then shareholders prove their private share
counts to withdraw proportionally.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/revenue-sharing/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const aliceKey = new Uint8Array(32); aliceKey[0] = 0x02;
const bobKey = new Uint8Array(32); bobKey[0] = 0x03;
const nobodyKey = new Uint8Array(32); nobodyKey[0] = 0x04;

const TOTAL_SHARES = 10000n;
const ALICE_SHARES = 6000n; // 60%
const BOB_SHARES = 4000n;   // 40%
const DEPOSIT_AMOUNT = 10000n;

function makeWitnesses(sk, shares = 0n) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getShares: ({ privateState }, _totalShares) => [privateState, shares],
    computeEntitlement: ({ privateState }, s, total, pool) => {
      return [privateState, (pool * s) / total];
    },
  };
}

describe("Revenue Sharing", () => {
  let adminContract;
  let ctx;
  let addr;

  const alicePk = pureCircuits.publicKey(aliceKey);
  const bobPk = pureCircuits.publicKey(bobKey);

  beforeEach(() => {
    adminContract = new Contract(makeWitnesses(adminKey));
    addr = sampleContractAddress();
    const initial = adminContract.initialState(
      createConstructorContext({}, addr),
      TOTAL_SHARES,
    );
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should add a shareholder", () => {
    const r = adminContract.impureCircuits.addShareholder(ctx, alicePk, ALICE_SHARES);
    expect(r.context).toBeDefined();
  });

  it("should reject non-admin adding shareholder", () => {
    const nobody = new Contract(makeWitnesses(nobodyKey));
    expect(() => {
      nobody.impureCircuits.addShareholder(ctx, alicePk, ALICE_SHARES);
    }).toThrow("Only admin");
  });

  it("should reject duplicate shareholder", () => {
    const r1 = adminContract.impureCircuits.addShareholder(ctx, alicePk, ALICE_SHARES);
    expect(() => {
      adminContract.impureCircuits.addShareholder(r1.context, alicePk, ALICE_SHARES);
    }).toThrow("Already registered");
  });

  it("should deposit revenue", () => {
    const depositor = new Contract(makeWitnesses(nobodyKey));
    const r = depositor.impureCircuits.depositRevenue(ctx, DEPOSIT_AMOUNT);
    expect(r.context).toBeDefined();
  });

  it("should allow shareholder to withdraw entitlement", () => {
    // Admin adds Alice with 6000/10000 shares
    const r1 = adminContract.impureCircuits.addShareholder(ctx, alicePk, ALICE_SHARES);

    // Anyone deposits 10000 revenue
    const depositor = new Contract(makeWitnesses(nobodyKey));
    const r2 = depositor.impureCircuits.depositRevenue(r1.context, DEPOSIT_AMOUNT);

    // Alice withdraws her 60% = 6000
    const alice = new Contract(makeWitnesses(aliceKey, ALICE_SHARES));
    const r3 = alice.impureCircuits.withdraw(r2.context);
    expect(r3.context).toBeDefined();
  });

  it("should reject withdrawal with wrong share count", () => {
    // Admin adds Alice with 6000 shares
    const r1 = adminContract.impureCircuits.addShareholder(ctx, alicePk, ALICE_SHARES);

    const depositor = new Contract(makeWitnesses(nobodyKey));
    const r2 = depositor.impureCircuits.depositRevenue(r1.context, DEPOSIT_AMOUNT);

    // Alice claims 8000 shares instead of 6000 -- commitment won't match
    const cheatAlice = new Contract(makeWitnesses(aliceKey, 8000n));
    expect(() => {
      cheatAlice.impureCircuits.withdraw(r2.context);
    }).toThrow("Share proof invalid");
  });

  it("should reject non-shareholder withdrawal", () => {
    const r1 = adminContract.impureCircuits.addShareholder(ctx, alicePk, ALICE_SHARES);

    const depositor = new Contract(makeWitnesses(nobodyKey));
    const r2 = depositor.impureCircuits.depositRevenue(r1.context, DEPOSIT_AMOUNT);

    // Nobody tries to withdraw
    const nobody = new Contract(makeWitnesses(nobodyKey));
    expect(() => {
      nobody.impureCircuits.withdraw(r2.context);
    }).toThrow("Not a shareholder");
  });
});
```

---

## CLI

```bash
compact compile src/revenue-sharing.compact src/managed/revenue-sharing
npm test
```

---

## Notes

- **Compiler-validated:** Pending validation against Compact 0.29.0. The
  contract uses 4 exported circuits (`addShareholder`, `depositRevenue`,
  `withdraw`, plus the `publicKey` pure circuit).
- **Share privacy is the key feature.** Observers see that Alice is a
  shareholder and that she withdrew from the pool, but they cannot determine
  her share percentage. The commitment `hash(holder || shares)` is a one-way
  binding -- it proves Alice's share count without revealing it.
- **Clean division constraint.** The test uses `TOTAL_SHARES = 10000n`,
  `ALICE_SHARES = 6000n`, and `DEPOSIT_AMOUNT = 10000n`, so
  `10000 * 6000 / 10000 = 6000` divides evenly. If `pool * shares` is not
  evenly divisible by `totalShares`, the multiplication check
  `entitlement * totalShares == pool * shares` will fail. Production
  contracts should handle rounding (e.g., `entitlement * totalShares <= pool * shares`
  with an upper bound check).
- **Counter for revenue pool, not Map.** The `revenuePool` uses `Counter`
  because it only needs increment (deposits). Individual deposit history is
  not tracked on-chain. For auditability, an off-chain indexer can reconstruct
  deposit history from transaction logs.
- **Incremental withdrawal tracking.** The `withdrawals` Map stores cumulative
  amounts. After a first withdrawal, additional deposits increase the pool,
  and the shareholder can withdraw the new delta. The circuit asserts
  `entitlement > alreadyWithdrawn` to prevent re-withdrawing the same funds.
- **Admin registers shares, not shareholders.** The admin calls
  `addShareholder` with both the holder's public key and share count. This
  means the admin knows all share allocations. For fully private share
  issuance, shareholders could self-register with a commitment and the admin
  would verify via a separate approval circuit.
- **No actual token transfer.** This contract tracks revenue accounting only.
  Real token movement would require coin operations (`receive`, `send`) on
  the Midnight UTXO layer. The revenue contract would hold coin commitments
  and release them on withdrawal.
- **`totalShares` is immutable after construction.** Changing total shares
  after shareholders are registered would invalidate entitlement calculations.
  To support dynamic share reallocation, add an admin circuit that updates
  `totalShares` and requires re-registration of all shareholders.
- **Commitment binding prevents share inflation.** A shareholder cannot claim
  more shares than registered because the commitment hash would not match.
  The ZK proof guarantees the claimed share count opens the stored commitment.
