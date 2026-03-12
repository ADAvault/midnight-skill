# Access Control

> **Compiler-validated:** Contract compiles (8 circuits) and 6/6 tests pass against Compact 0.29.0.

Role-based permission management following the OpenZeppelin AccessControl
pattern adapted for Compact. Defines admin, operator, and viewer roles with
hierarchical grant/revoke privileges. The admin role manages all other roles,
operators perform privileged actions, and the contract supports pause/unpause.
Demonstrates composite Map keys for role membership, internal circuit guards,
and role hierarchy.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger roleMembers: Map<Bytes<32>, Boolean>;
export ledger roleAdmins: Map<Bytes<32>, Bytes<32>>;
export ledger totalMembers: Counter;
export ledger paused: Boolean;
export ledger configValue: Uint<64>;
export ledger lastOperator: Bytes<32>;

witness localSecretKey(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "acl:pk:"), sk]);
}

pure circuit roleKey(role: Bytes<32>, account: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([role, account]);
}

circuit assertRole(role: Bytes<32>): Bytes<32> {
  const caller = publicKey(localSecretKey());
  const key = roleKey(role, caller);
  assert(roleMembers.member(disclose(key)), "Missing required role");
  return caller;
}

constructor() {
  const deployer = disclose(publicKey(localSecretKey()));
  const adminKey = roleKey(pad(32, "ADMIN"), deployer);
  roleMembers.insert(disclose(adminKey), true);
  totalMembers.increment(1);
  roleAdmins.insert(pad(32, "ADMIN"), pad(32, "ADMIN"));
  roleAdmins.insert(pad(32, "OPERATOR"), pad(32, "ADMIN"));
  roleAdmins.insert(pad(32, "VIEWER"), pad(32, "ADMIN"));
  paused = false;
}

export circuit grantRole(role: Bytes<32>, account: Bytes<32>): [] {
  const adminRole = roleAdmins.lookup(disclose(role));
  assertRole(adminRole);
  const key = roleKey(role, account);
  assert(!roleMembers.member(disclose(key)), "Account already has role");
  roleMembers.insert(disclose(key), true);
  totalMembers.increment(1);
}

export circuit revokeRole(role: Bytes<32>, account: Bytes<32>): [] {
  const adminRole = roleAdmins.lookup(disclose(role));
  assertRole(adminRole);
  const key = roleKey(role, account);
  assert(roleMembers.member(disclose(key)), "Account does not have role");
  roleMembers.remove(disclose(key));
  totalMembers.decrement(1);
}

export circuit renounceRole(role: Bytes<32>): [] {
  const caller = disclose(publicKey(localSecretKey()));
  const key = roleKey(role, caller);
  assert(roleMembers.member(disclose(key)), "Caller does not have role");
  roleMembers.remove(disclose(key));
  totalMembers.decrement(1);
}

export circuit pause(): [] {
  assertRole(pad(32, "ADMIN"));
  assert(!paused, "Already paused");
  paused = true;
}

export circuit unpause(): [] {
  assertRole(pad(32, "ADMIN"));
  assert(paused, "Not paused");
  paused = false;
}

export circuit updateConfig(newValue: Uint<64>): [] {
  assert(!paused, "Contract is paused");
  const caller = assertRole(pad(32, "OPERATOR"));
  configValue = disclose(newValue);
  lastOperator = disclose(caller);
}

export circuit privilegedAction(): [] {
  assert(!paused, "Contract is paused");
  assertRole(pad(32, "OPERATOR"));
}

export circuit checkRole(role: Bytes<32>, account: Bytes<32>): Boolean {
  const key = roleKey(role, account);
  return roleMembers.member(disclose(key));
}
```

---

## Key Concepts

### No Sequence Counter

Like the multi-sig example, this contract omits the sequence counter. If the
sequence changed (e.g., after a privileged action), ALL role membership keys
would become invalid because keys are derived from `hash(role || publicKey)` and
`publicKey` would change. Deterministic keys avoid this entirely.

### Composite Map Keys

Since Compact does not support nested Maps (`Map<K1, Map<K2, V>>`), role
membership uses `hash(role || account)` as a single `Bytes<32>` key. The
`roleKey` pure circuit computes this composite key.

### Internal Circuit Guards

The `assertRole` internal circuit provides reusable role checking. It reads from
the `roleMembers` Map, asserts membership, and returns the caller's public key.
Internal circuits (`circuit` without `export`) can access ledger state but are
not callable from outside the contract. They avoid the k-value explosion from
cross-exported-circuit calls.

### Role Hierarchy

`roleAdmins` maps each role to its admin role. By default, ADMIN is the admin
for all roles. The `grantRole` circuit looks up the admin role for the target
role and asserts the caller has that admin role.

### Inlined Role Constants

Role identifiers use `pad(32, "ADMIN")`, `pad(32, "OPERATOR")`, etc. inlined
at each use site. In tests, the equivalent JavaScript encoding is:
```javascript
function padBytes(s) {
  const bytes = new Uint8Array(32);
  new TextEncoder().encode(s).forEach((b, i) => bytes[i] = b);
  return bytes;
}
```

### Boolean Literals to Export Ledger

`paused = true` and `paused = false` assign boolean literals to an export ledger
field. These do NOT need `disclose()` -- compile-time constants are not
considered potentially witness-derived.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/acl/contract/index.js';

export interface AclPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, AclPrivateState>,
  ): [AclPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Admin grants roles, operator
performs guarded actions, non-authorized users are rejected.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/acl/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const adminKey = new Uint8Array(32); adminKey[0] = 0x01;
const operatorKey = new Uint8Array(32); operatorKey[0] = 0x02;
const viewerKey = new Uint8Array(32); viewerKey[0] = 0x03;
const nobodyKey = new Uint8Array(32); nobodyKey[0] = 0x04;

function padBytes(s) {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(s);
  bytes.set(encoded.slice(0, 32));
  return bytes;
}

const ADMIN_ROLE = padBytes("ADMIN");
const OPERATOR_ROLE = padBytes("OPERATOR");

function makeWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
  };
}

describe("Access Control", () => {
  let adminContract, ctx, operatorPk;

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
    operatorPk = pureCircuits.publicKey(operatorKey);
  });

  it("should grant and revoke operator role", () => {
    let r = adminContract.impureCircuits.grantRole(ctx, OPERATOR_ROLE, operatorPk);
    r = adminContract.impureCircuits.revokeRole(r.context, OPERATOR_ROLE, operatorPk);
    expect(r.context).toBeDefined();
  });

  it("should allow operator to update config", () => {
    let r = adminContract.impureCircuits.grantRole(ctx, OPERATOR_ROLE, operatorPk);
    const opContract = new Contract(makeWitnesses(operatorKey));
    r = opContract.impureCircuits.updateConfig(r.context, 42n);
    expect(r.context).toBeDefined();
  });

  it("should reject non-operator from updating config", () => {
    const nobody = new Contract(makeWitnesses(nobodyKey));
    expect(() => {
      nobody.impureCircuits.updateConfig(ctx, 42n);
    }).toThrow("Missing required role");
  });

  it("should reject non-admin from granting roles", () => {
    const opContract = new Contract(makeWitnesses(operatorKey));
    const viewerPk = pureCircuits.publicKey(viewerKey);
    expect(() => {
      opContract.impureCircuits.grantRole(ctx, OPERATOR_ROLE, viewerPk);
    }).toThrow("Missing required role");
  });

  it("should pause and prevent operator actions", () => {
    let r = adminContract.impureCircuits.grantRole(ctx, OPERATOR_ROLE, operatorPk);
    r = adminContract.impureCircuits.pause(r.context);
    const opContract = new Contract(makeWitnesses(operatorKey));
    expect(() => {
      opContract.impureCircuits.updateConfig(r.context, 42n);
    }).toThrow("Contract is paused");
  });

  it("should allow renouncing own role", () => {
    let r = adminContract.impureCircuits.grantRole(ctx, OPERATOR_ROLE, operatorPk);
    const opContract = new Contract(makeWitnesses(operatorKey));
    r = opContract.impureCircuits.renounceRole(r.context, OPERATOR_ROLE);
    expect(() => {
      opContract.impureCircuits.updateConfig(r.context, 42n);
    }).toThrow("Missing required role");
  });
});
```

---

## Notes

- **Compiler-validated:** 8 circuits compiled, 6/6 tests pass against Compact 0.29.0.
- **Using the OZ module:** In production, prefer importing the OZ AccessControl
  module: `import "./oz/AccessControl" prefix AC_;`. This example shows the
  underlying pattern for education and customization.
- **Role enumeration not supported:** Maps cannot be iterated in-circuit. Use the
  indexer to track `grantRole`/`revokeRole` transactions for role member lists.
- **Last admin protection:** This implementation does not prevent the last admin
  from renouncing ADMIN. Production contracts should guard against this.
- **`pure circuit` vs `circuit`:** `roleKey` is `pure circuit` (no state access,
  just hashing). `assertRole` is `circuit` (accesses `roleMembers` Map).
- The `checkRole` circuit generates a ZK proof for a read-only query. For
  off-chain checks, read `roleMembers` from the indexer directly.
