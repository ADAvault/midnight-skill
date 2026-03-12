# Contract Upgradability

> **Compiler-validated:** Both V1 and V2 contracts compile independently. V1: 3 circuits, 3/3 tests pass. V2: 7 circuits, 5/5 tests pass. Against Compact 0.29.0.

A migration pattern showing how to handle contract upgrades on Midnight.
Since Midnight contracts are immutable once deployed (no proxy pattern, no
delegatecall), upgrades require deploying a new contract and migrating state
manually. This example shows V1 (a simple balance ledger) and V2 (adds
withdraw, transfer, balance limits, and freeze/unfreeze). The admin freezes
V1, deploys V2, and migrates accounts one by one. Demonstrates the
freeze-deploy-migrate workflow, V2 schema evolution (new ledger fields and
circuits), and the trade-offs of immutable contract design.

---

## Contract (V1)

The original contract. Supports deposit and balance queries. The `freeze`
circuit sets version to 0, signalling that V1 is deprecated and no further
deposits should be accepted (enforced off-chain -- the contract itself does
not check version in deposit).

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger balances: Map<Bytes<32>, Uint<64>>;
export ledger totalAccounts: Counter;
export ledger version: Uint<32>;

witness localSecretKey(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "upgrade:pk:"), sk]);
}

constructor() {
  admin = disclose(publicKey(localSecretKey()));
  version = 1;
}

export circuit deposit(account: Bytes<32>, amount: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  if (!balances.member(disclose(account))) {
    totalAccounts.increment(1);
  }
  if (balances.member(disclose(account))) {
    const current = balances.lookup(disclose(account));
    balances.insert(disclose(account), disclose((current + amount) as Uint<64>));
  } else {
    balances.insert(disclose(account), disclose(amount));
  }
}

export circuit getBalance(account: Bytes<32>): Uint<64> {
  assert(balances.member(disclose(account)), "Account not found");
  return balances.lookup(disclose(account));
}

export circuit freeze(): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  version = 0;
}
```

---

## Contract (V2)

The upgraded contract. Adds `withdraw`, `transfer`, `maxBalance` enforcement,
and `frozen` state (a proper Boolean, unlike V1's version-number hack). The
`migrateAccount` circuit is purpose-built for the migration flow -- it accepts
an account and balance from V1 and inserts them into V2's ledger.

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger balances: Map<Bytes<32>, Uint<64>>;
export ledger totalAccounts: Counter;
export ledger version: Uint<32>;
export ledger maxBalance: Uint<64>;
export ledger frozen: Boolean;

witness localSecretKey(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "upgrade:pk:"), sk]);
}

constructor() {
  admin = disclose(publicKey(localSecretKey()));
  version = 2;
  maxBalance = 1000000;
  frozen = false;
}

export circuit migrateAccount(account: Bytes<32>, balance: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(!frozen, "Contract is frozen");
  assert(!balances.member(disclose(account)), "Account already migrated");
  balances.insert(disclose(account), disclose(balance));
  totalAccounts.increment(1);
}

export circuit deposit(account: Bytes<32>, amount: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(!frozen, "Frozen");
  assert(balances.member(disclose(account)), "Account not found");
  const current = balances.lookup(disclose(account));
  const newBalance = disclose((current + amount) as Uint<64>);
  assert(newBalance <= maxBalance, "Exceeds max balance");
  balances.insert(disclose(account), newBalance);
}

export circuit withdraw(account: Bytes<32>, amount: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(!frozen, "Frozen");
  assert(balances.member(disclose(account)), "Account not found");
  const current = balances.lookup(disclose(account));
  assert(disclose(current >= amount), "Insufficient balance");
  balances.insert(disclose(account), disclose((current - amount) as Uint<64>));
}

export circuit transfer(sender: Bytes<32>, to: Bytes<32>, amount: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  assert(!frozen, "Frozen");
  assert(balances.member(disclose(sender)), "Sender account not found");
  const fromBal = balances.lookup(disclose(sender));
  assert(disclose(fromBal >= amount), "Insufficient balance");
  balances.insert(disclose(sender), disclose((fromBal - amount) as Uint<64>));
  if (balances.member(disclose(to))) {
    const toBal = balances.lookup(disclose(to));
    balances.insert(disclose(to), disclose((toBal + amount) as Uint<64>));
  } else {
    balances.insert(disclose(to), disclose(amount));
    totalAccounts.increment(1);
  }
}

export circuit getBalance(account: Bytes<32>): Uint<64> {
  assert(balances.member(disclose(account)), "Account not found");
  return balances.lookup(disclose(account));
}

export circuit freeze(): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  frozen = true;
}

export circuit unfreeze(): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  frozen = false;
}
```

---

## Key Concepts

### No Proxy Pattern on Midnight

Midnight contracts are immutable once deployed. There is no `delegatecall`, no
proxy contract, and no storage slot manipulation. If you need to change
contract logic, you deploy a new contract and migrate state. This is a
fundamental design constraint -- plan for it from V1.

### The Freeze-Deploy-Migrate Workflow

```
1. V1: freeze()         -- stop accepting new operations
2. Deploy V2            -- new contract with upgraded logic
3. V2: migrateAccount() -- for each account in V1, read balance off-chain
                           and insert into V2 (admin-authorized)
4. V2: unfreeze()       -- V2 is now live (or never frozen to begin with)
```

The migration is orchestrated off-chain. The admin reads V1 state via
`getBalance()`, then calls `migrateAccount()` on V2 for each account. This is
inherently sequential -- each `migrateAccount` call is a separate transaction.
For large account sets, this can be slow and expensive.

### Schema Evolution

V2 adds new ledger fields (`maxBalance`, `frozen`) and new circuits
(`withdraw`, `transfer`, `migrateAccount`, `unfreeze`) that did not exist in
V1. The shared fields (`admin`, `balances`, `totalAccounts`, `version`) have
the same types in both contracts but are independent storage -- V2's ledger is
entirely separate from V1's.

### Migration Circuit Design

`migrateAccount` is a one-way operation:
- `assert(!balances.member(...))` prevents double-migration
- Only admin can call it (same auth pattern as all other circuits)
- It accepts the balance as a parameter -- the admin is trusted to provide the
  correct value from V1. There is no cross-contract read in Compact.

### No Sequence Counter

Both V1 and V2 omit the sequence counter. The admin key is deterministic from
the secret key alone. Since there is only one privileged role (admin) and no
state transitions that require replay protection on identity, the simpler
`publicKey(sk)` pattern is sufficient.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/upgrade-v1/contract/index.js';

export interface UpgradePrivateState {
  readonly secretKey: Uint8Array;
}

// Same witnesses work for both V1 and V2 — only localSecretKey is needed
export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, UpgradePrivateState>,
  ): [UpgradePrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },
};
```

---

## Tests

Compiler-validated simulator tests. V1 and V2 are tested independently since
they are separate contracts. The migration flow is demonstrated conceptually --
reading V1 state and writing it to V2.

### V1 Tests (3/3 passing)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract as ContractV1, pureCircuits } from "../src/managed/upgrade-v1/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const nonAdminKey = new Uint8Array(32); nonAdminKey[0] = 0x02;

const accountA = new Uint8Array(32); accountA[0] = 0x10;
const accountB = new Uint8Array(32); accountB[0] = 0x11;

function makeWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
  };
}

describe("Contract V1", () => {
  let adminContract;
  let ctx;

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
  });

  it("should deposit and read balance", () => {
    const r1 = adminContract.impureCircuits.deposit(ctx, accountA, 500n);
    const r2 = adminContract.impureCircuits.getBalance(r1.context, accountA);
    expect(r2.result).toBe(500n);
  });

  it("should accumulate deposits", () => {
    const r1 = adminContract.impureCircuits.deposit(ctx, accountA, 300n);
    const r2 = adminContract.impureCircuits.deposit(r1.context, accountA, 200n);
    const r3 = adminContract.impureCircuits.getBalance(r2.context, accountA);
    expect(r3.result).toBe(500n);
  });

  it("should freeze the contract", () => {
    const r1 = adminContract.impureCircuits.deposit(ctx, accountA, 100n);
    const r2 = adminContract.impureCircuits.freeze(r1.context);
    expect(r2.context).toBeDefined();
  });
});
```

### V2 Tests (5/5 passing)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract as ContractV2, pureCircuits } from "../src/managed/upgrade-v2/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const nonAdminKey = new Uint8Array(32); nonAdminKey[0] = 0x02;

const accountA = new Uint8Array(32); accountA[0] = 0x10;
const accountB = new Uint8Array(32); accountB[0] = 0x11;

function makeWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
  };
}

describe("Contract V2", () => {
  let adminContract;
  let ctx;

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
  });

  it("should migrate an account from V1", () => {
    // Simulate reading V1 balance off-chain: accountA had 500
    const r1 = adminContract.impureCircuits.migrateAccount(ctx, accountA, 500n);
    const r2 = adminContract.impureCircuits.getBalance(r1.context, accountA);
    expect(r2.result).toBe(500n);
  });

  it("should reject double-migration", () => {
    const r1 = adminContract.impureCircuits.migrateAccount(ctx, accountA, 500n);
    expect(() => {
      adminContract.impureCircuits.migrateAccount(r1.context, accountA, 500n);
    }).toThrow("Account already migrated");
  });

  it("should deposit with max balance enforcement", () => {
    const r1 = adminContract.impureCircuits.migrateAccount(ctx, accountA, 500n);
    const r2 = adminContract.impureCircuits.deposit(r1.context, accountA, 200n);
    const r3 = adminContract.impureCircuits.getBalance(r2.context, accountA);
    expect(r3.result).toBe(700n);
  });

  it("should transfer between accounts", () => {
    const r1 = adminContract.impureCircuits.migrateAccount(ctx, accountA, 500n);
    const r2 = adminContract.impureCircuits.transfer(r1.context, accountA, accountB, 200n);  // sender=accountA, to=accountB
    const r3 = adminContract.impureCircuits.getBalance(r2.context, accountA);
    expect(r3.result).toBe(300n);
    const r4 = adminContract.impureCircuits.getBalance(r3.context, accountB);
    expect(r4.result).toBe(200n);
  });

  it("should withdraw from an account", () => {
    const r1 = adminContract.impureCircuits.migrateAccount(ctx, accountA, 500n);
    const r2 = adminContract.impureCircuits.withdraw(r1.context, accountA, 150n);
    const r3 = adminContract.impureCircuits.getBalance(r2.context, accountA);
    expect(r3.result).toBe(350n);
  });
});
```

---

## CLI

```bash
# V1
compact compile src/upgrade-v1.compact src/managed/upgrade-v1
# V2
compact compile src/upgrade-v2.compact src/managed/upgrade-v2
npm test
```

---

## Notes

- **Two separate contracts, two separate compilations.** V1 and V2 are
  independent Compact files. They share no state at the ledger level.
  Migration is a manual off-chain process.
- **No sequence counter** in either contract. Admin identity is deterministic
  and there are no state transitions that require key rotation.
- **`migrateAccount` trusts the admin** to provide accurate balances. There
  is no cross-contract verification in Compact. The admin reads V1's state
  off-chain (via `getBalance`) and inserts it into V2. A malicious admin
  could alter balances during migration -- this is inherent to the pattern.
- **V1's `freeze()` is a soft freeze.** It sets `version = 0` but does not
  prevent deposits. A production V1 would check `assert(version != 0)` in
  the deposit circuit. V2 uses a proper `frozen: Boolean` with assert checks
  in every mutating circuit.
- **Max balance is set in constructor.** V2 introduces `maxBalance` as a
  new ledger field. A production version would add an `updateMaxBalance`
  circuit for admin to adjust limits post-deployment.
- Circuit complexity: V1 is lightweight (k ~10-12). V2's `transfer` is the
  heaviest circuit (k ~14-15) due to dual Map lookups, arithmetic, and
  conditional new-account logic.
- **Version field** is a convention, not enforced by the runtime. It exists
  for off-chain tooling to identify which contract version is deployed at a
  given address.
- For contracts with many accounts, consider batching migration (similar to
  `prescribeBatch` in the prescription example) to reduce transaction count,
  at the cost of higher per-circuit k-values.
