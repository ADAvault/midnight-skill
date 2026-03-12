# Access Control

Role-based permission management following the OpenZeppelin AccessControl
pattern adapted for Compact. Defines admin, operator, and viewer roles with
hierarchical grant/revoke privileges. The admin role can manage all other roles,
operators can perform privileged actions, and viewers have read-level access
markers. Demonstrates OZ module composition for access management, role-based
circuit guards, and the interaction between privacy and role visibility.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

// Role identifiers as Bytes<32> constants
// In OZ convention, roles are hashed strings. Here we use pad for simplicity.
const ADMIN_ROLE: Bytes<32> = pad(32, "ADMIN");
const OPERATOR_ROLE: Bytes<32> = pad(32, "OPERATOR");
const VIEWER_ROLE: Bytes<32> = pad(32, "VIEWER");

// Role membership: Map<hash(role || account), Boolean>
// Using a composite key avoids nested Maps (not supported in Compact)
export ledger roleMembers: Map<Bytes<32>, Boolean>;
export ledger roleAdmins: Map<Bytes<32>, Bytes<32>>;
export ledger totalMembers: Counter;
export ledger paused: Boolean;
export ledger configValue: Uint<64>;
export ledger lastOperator: Bytes<32>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "acl:pk:"), seq, sk]);
}

// Derive the composite key for role membership
circuit roleKey(role: Bytes<32>, account: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([role, account]);
}

// Internal: check if an account has a role
circuit hasRole(role: Bytes<32>, account: Bytes<32>): Boolean {
  const key = roleKey(role, account);
  return roleMembers.member(key);
}

// Internal: assert caller has a specific role
circuit assertRole(role: Bytes<32>): Bytes<32> {
  const caller = publicKey(localSecretKey(), sequence as Field as Bytes<32>);
  const key = roleKey(role, caller);
  assert(roleMembers.member(disclose(key)), "Missing required role");
  return caller;
}

constructor() {
  // Deployer gets ADMIN role
  const deployer = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  const adminKey = roleKey(ADMIN_ROLE, deployer);
  roleMembers.insert(disclose(adminKey), true);
  totalMembers.increment(1);

  // Set ADMIN as the admin role for all roles (role hierarchy)
  roleAdmins.insert(ADMIN_ROLE, ADMIN_ROLE);
  roleAdmins.insert(OPERATOR_ROLE, ADMIN_ROLE);
  roleAdmins.insert(VIEWER_ROLE, ADMIN_ROLE);

  paused = false;
  sequence.increment(1);
}

// Grant a role to an account (requires admin of that role)
export circuit grantRole(role: Bytes<32>, account: Bytes<32>): [] {
  // Caller must have the admin role for the target role
  const adminRole = roleAdmins.lookup(role);
  const caller = assertRole(adminRole);

  // Grant the role
  const key = roleKey(role, account);
  assert(!roleMembers.member(disclose(key)), "Account already has role");
  roleMembers.insert(disclose(key), true);
  totalMembers.increment(1);
}

// Revoke a role from an account (requires admin of that role)
export circuit revokeRole(role: Bytes<32>, account: Bytes<32>): [] {
  const adminRole = roleAdmins.lookup(role);
  const caller = assertRole(adminRole);

  const key = roleKey(role, account);
  assert(roleMembers.member(disclose(key)), "Account does not have role");
  roleMembers.remove(disclose(key));
  totalMembers.decrement(1);
}

// Renounce a role (caller removes their own role)
export circuit renounceRole(role: Bytes<32>): [] {
  const caller = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  const key = roleKey(role, caller);
  assert(roleMembers.member(disclose(key)), "Caller does not have role");
  roleMembers.remove(disclose(key));
  totalMembers.decrement(1);
}

// --- Role-guarded operations ---

// ADMIN only: pause the contract
export circuit pause(): [] {
  assertRole(ADMIN_ROLE);
  assert(!paused, "Already paused");
  paused = true;
}

// ADMIN only: unpause the contract
export circuit unpause(): [] {
  assertRole(ADMIN_ROLE);
  assert(paused, "Not paused");
  paused = false;
}

// OPERATOR only: update a configuration value
export circuit updateConfig(newValue: Uint<64>): [] {
  assert(!paused, "Contract is paused");
  const caller = assertRole(OPERATOR_ROLE);
  configValue = newValue;
  lastOperator = disclose(caller);
}

// OPERATOR only: perform a privileged action
export circuit privilegedAction(): [] {
  assert(!paused, "Contract is paused");
  assertRole(OPERATOR_ROLE);
  // ... privileged logic here ...
  sequence.increment(1);
}

// Check if a specific account has a role (public query)
export circuit checkRole(role: Bytes<32>, account: Bytes<32>): Boolean {
  const key = roleKey(role, account);
  return roleMembers.member(key);
}
```

---

## Key Concepts

- **OZ AccessControl pattern:** Roles are `Bytes<32>` identifiers. Membership is
  tracked in a Map using composite keys (`hash(role || account)`). Each role has
  an "admin role" that controls who can grant and revoke it.
- **Composite Map keys:** Since Compact does not support nested Maps
  (`Map<Bytes<32>, Map<Bytes<32>, Boolean>>`), role membership uses
  `hash(role || account)` as a single `Bytes<32>` key. This is the standard
  Compact pattern for multi-dimensional lookups.
- **Internal circuit guards:** The `assertRole` internal circuit provides reusable
  role checking without the k-value explosion of cross-exported-circuit calls.
  Every guarded exported circuit calls `assertRole` internally.
- **Role hierarchy:** `roleAdmins` maps each role to its admin role. By default,
  ADMIN is the admin for all roles. This can be customized (e.g., OPERATOR could
  be admin for VIEWER, allowing operators to manage viewers without admin
  intervention).
- **Privacy tradeoff:** The `disclose(key)` in role operations reveals the
  composite key hash on-chain. An observer can determine that "some account was
  granted some role" but cannot reverse the hash to learn the account or role
  without additional information. For fully private role checks, omit `disclose`
  from the Map key and use the internal `hasRole` circuit -- but this requires
  the compiler to accept non-disclosed Map keys, which depends on the ledger
  visibility of `roleMembers`.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/acl/contract/index.cjs';

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

// Helper: create role constants matching the contract
export const ROLES = {
  ADMIN: new TextEncoder().encode('ADMIN'.padEnd(32, '\0')),
  OPERATOR: new TextEncoder().encode('OPERATOR'.padEnd(32, '\0')),
  VIEWER: new TextEncoder().encode('VIEWER'.padEnd(32, '\0')),
} as const;

// Helper: derive the public key for a given secret key
// Must match the contract's publicKey circuit logic exactly
export function derivePublicKey(
  secretKey: Uint8Array,
  sequence: bigint,
): Uint8Array {
  // Use the same hash(domain || seq || sk) as the contract.
  // In production, use @midnight-ntwrk/compact-runtime's hash utilities
  // to ensure identical results.
  const domain = new TextEncoder().encode('acl:pk:'.padEnd(32, '\0'));
  const seqBytes = bigintToBytes32(sequence);
  return sha256(Buffer.concat([domain, seqBytes, secretKey]));
}
```

---

## Tests

```
describe('Access Control', () => {

  1. Admin grants and revokes roles (happy path)
     - Deploy, admin grants OPERATOR to account B
     - Verify B has OPERATOR role, admin revokes it
     - Verify B no longer has OPERATOR role

  2. Operator performs guarded action (happy path)
     - Grant OPERATOR to B, B calls updateConfig
     - Assert configValue updated, lastOperator is B's key

  3. Non-operator cannot perform guarded action (should fail)
     - Account without OPERATOR calls updateConfig
     - Assert "Missing required role" error

  4. Non-admin cannot grant roles (should fail)
     - OPERATOR account attempts to grant ADMIN to another account
     - Assert "Missing required role" error

  5. Pause prevents operator actions
     - Admin pauses, operator attempts updateConfig
     - Assert "Contract is paused" error
     - Admin unpauses, operator succeeds

  6. Renounce removes own role
     - Admin grants OPERATOR to B, B renounces OPERATOR
     - Assert B can no longer perform operator actions
});
```

---

## Notes

- Circuit complexity is moderate-to-high (k ~13-14) due to the `persistentHash`
  for composite key derivation and Map operations. The `grantRole` circuit
  performs two Map lookups (admin role check + duplicate check) and one Map
  insert. Circuits calling `assertRole` inherit its Map lookup cost.
- **Using the actual OZ module:** In production, prefer importing the OZ
  AccessControl module directly rather than reimplementing it:
  ```compact
  import "./oz/AccessControl" prefix AC_;
  ```
  The OZ module provides tested implementations of `grantRole`, `revokeRole`,
  `hasRole`, and `assertHasRole`. This example shows the underlying pattern for
  educational purposes and for cases where you need custom role logic.
- **Role enumeration is not supported:** There is no way to list all accounts
  with a given role from within a circuit (Maps cannot be iterated). To enumerate
  role members, maintain an off-chain index via the indexer's public data
  provider, tracking `grantRole` and `revokeRole` transactions.
- **Admin key compromise:** If the admin's secret key is compromised, all roles
  can be manipulated. For production, consider making the admin a multisig (see
  the multi-sig example) or implementing a time-delayed admin transfer.
- The `checkRole` circuit generates a ZK proof for a read-only query. For
  off-chain role checks, read the `roleMembers` Map directly from the indexer
  using the composite key hash, avoiding proof generation overhead.
- **Last admin protection:** This implementation does not prevent the last admin
  from revoking or renouncing their own ADMIN role, which would leave the
  contract without an admin. Production contracts should add a guard against this.
