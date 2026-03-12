# Identity Proof

> **Compiler-validated:** Contract compiles and 6/6 tests pass against Compact 0.29.0.

Prove attributes about yourself without revealing them -- the canonical
zero-knowledge use case. A verifier contract stores attribute commitments from
a trusted issuer, and users prove statements like "I am over 18" or "my credit
score exceeds 700" without revealing their actual age or score. Only the boolean
result of the condition is disclosed. Demonstrates selective disclosure,
witness-provided private attributes, and issuer-based trust anchoring.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger issuer: Bytes<32>;
export ledger credentials: Map<Bytes<32>, Bytes<32>>;
export ledger verifications: Counter;

witness localSecretKey(): Bytes<32>;
witness getCredentialSalt(): Bytes<32>;
witness getAttributeValue(attrName: Bytes<32>): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "identity:pk:"), sk]);
}

constructor() {
  issuer = disclose(publicKey(localSecretKey()));
}

export circuit issueCredential(
  holder: Bytes<32>,
  attrName: Bytes<32>,
  attrValue: Uint<64>,
  salt: Bytes<32>
): [] {
  assert(publicKey(localSecretKey()) == issuer, "Only issuer can issue credentials");

  const commitment = persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "identity:cred:"),
    salt,
    holder,
    attrName,
    attrValue as Field as Bytes<32>
  ]);

  const credKey = persistentHash<Vector<2, Bytes<32>>>([holder, attrName]);
  credentials.insert(disclose(credKey), disclose(commitment));
}

export circuit proveAttributeAbove(
  attrName: Bytes<32>,
  threshold: Uint<64>
): [] {
  const holder = disclose(publicKey(localSecretKey()));
  const salt = getCredentialSalt();
  const attrValue = getAttributeValue(attrName);

  const recomputed = persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "identity:cred:"),
    salt,
    holder,
    attrName,
    attrValue as Field as Bytes<32>
  ]);

  const credKey = persistentHash<Vector<2, Bytes<32>>>([holder, attrName]);
  assert(credentials.member(disclose(credKey)), "No credential found");
  const stored = credentials.lookup(disclose(credKey));
  assert(disclose(recomputed == stored), "Credential verification failed");

  assert(disclose(attrValue > threshold), "Attribute does not meet threshold");

  verifications.increment(1);
}

export circuit proveAttributeBelow(
  attrName: Bytes<32>,
  threshold: Uint<64>
): [] {
  const holder = disclose(publicKey(localSecretKey()));
  const salt = getCredentialSalt();
  const attrValue = getAttributeValue(attrName);

  const recomputed = persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "identity:cred:"),
    salt,
    holder,
    attrName,
    attrValue as Field as Bytes<32>
  ]);

  const credKey = persistentHash<Vector<2, Bytes<32>>>([holder, attrName]);
  assert(credentials.member(disclose(credKey)), "No credential found");
  const stored = credentials.lookup(disclose(credKey));
  assert(disclose(recomputed == stored), "Credential verification failed");

  assert(disclose(attrValue < threshold), "Attribute exceeds threshold");

  verifications.increment(1);
}

export circuit proveAttributeEquals(
  attrName: Bytes<32>,
  expected: Uint<64>
): [] {
  const holder = disclose(publicKey(localSecretKey()));
  const salt = getCredentialSalt();
  const attrValue = getAttributeValue(attrName);

  const recomputed = persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "identity:cred:"),
    salt,
    holder,
    attrName,
    attrValue as Field as Bytes<32>
  ]);

  const credKey = persistentHash<Vector<2, Bytes<32>>>([holder, attrName]);
  assert(credentials.member(disclose(credKey)), "No credential found");
  const stored = credentials.lookup(disclose(credKey));
  assert(disclose(recomputed == stored), "Credential verification failed");

  assert(disclose(attrValue == expected), "Attribute mismatch");

  verifications.increment(1);
}
```

---

## Key Concepts

### Selective Disclosure

The user proves a property of their attribute (above, below, equals) without
revealing the attribute itself. `disclose(attrValue > 18)` reveals only `true`
or `false`, not the actual age. The ZK proof guarantees the computation was
honest.

### Issuer Trust Anchor

The credential commitment is created by a trusted issuer and stored on-chain.
When a user proves an attribute, the circuit recomputes the commitment from
private inputs and verifies it matches the issuer's stored hash. A user cannot
fake an attribute because they cannot produce a matching commitment without
knowing the original salt and value.

### Commitment Structure

`hash(domain || salt || holder || attrName || attrValue)` binds the credential
to a specific holder and attribute. The 5-element `persistentHash<Vector<5, Bytes<32>>>`
includes:

1. **Domain separator** (`"identity:cred:"`) -- prevents cross-contract collision
2. **Salt** -- prevents dictionary attacks on known attribute values
3. **Holder** -- binds to a specific user's public key
4. **Attribute name** -- identifies what attribute is being committed
5. **Attribute value** -- the actual value (cast via `as Field as Bytes<32>`)

### Parameterized Witnesses

`witness getAttributeValue(attrName: Bytes<32>): Uint<64>` demonstrates a witness
that receives a parameter from the circuit. The circuit passes the attribute name
to the witness, and the TypeScript implementation looks up the value in the user's
private state. The witness signature in TypeScript receives the parameter as an
additional argument after `WitnessContext`.

### No Sequence Counter

This contract omits the sequence counter. Credentials are permanent -- there is
no key rotation or replay concern. The issuer and holder keys are deterministic
from their secret keys alone, simplifying the design.

### Privacy Model

| Value | Visibility | Why |
|-------|-----------|-----|
| Attribute value | **PRIVATE** | Never leaves the witness. ZK proof proves properties without revealing. |
| Comparison result | **PUBLIC** | `disclose(attrValue > threshold)` -- only the boolean. |
| Credential commitment | **PUBLIC** | Stored on ledger. Cannot be reversed to learn the value. |
| Salt | **PRIVATE** | Known only to issuer and holder. Prevents brute-force on commitment. |
| Holder public key | **PUBLIC** | Disclosed during proofs. Identifies who proved what. |
| Threshold | **PRIVATE** | Circuit parameter. Not disclosed unless explicitly wrapped. |

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/identity/contract/index.js';

export interface IdentityPrivateState {
  readonly secretKey: Uint8Array;
  readonly credentialSalt: Uint8Array;
  readonly attributes: Record<string, bigint>;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
  ): [IdentityPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getCredentialSalt: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
  ): [IdentityPrivateState, Uint8Array] => {
    return [privateState, privateState.credentialSalt];
  },

  getAttributeValue: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
    attrName: Uint8Array,
  ): [IdentityPrivateState, bigint] => {
    const name = new TextDecoder().decode(attrName).replace(/\0+$/g, '');
    return [privateState, privateState.attributes[name] ?? 0n];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Issuer and holder use separate
`Contract` instances with different witnesses. The holder's witnesses provide the
salt and attribute values needed for credential verification.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/identity/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const issuerKey = new Uint8Array(32); issuerKey[0] = 0x01;
const holderKey = new Uint8Array(32); holderKey[0] = 0x02;
const nonIssuerKey = new Uint8Array(32); nonIssuerKey[0] = 0x03;

const salt = new Uint8Array(32); salt[0] = 0xAA;
const wrongSalt = new Uint8Array(32); wrongSalt[0] = 0xBB;

function padBytes(s) {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(s);
  bytes.set(encoded.slice(0, 32));
  return bytes;
}

const AGE_ATTR = padBytes("age");
const DEBT_ATTR = padBytes("debt");
const COUNTRY_ATTR = padBytes("country");

function makeIssuerWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCredentialSalt: ({ privateState }) => [privateState, new Uint8Array(32)],
    getAttributeValue: ({ privateState }, attrName) => [privateState, 0n],
  };
}

function makeHolderWitnesses(sk, holderSalt, attributes) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCredentialSalt: ({ privateState }) => [privateState, holderSalt],
    getAttributeValue: ({ privateState }, attrName) => {
      const name = new TextDecoder().decode(attrName).replace(/\0+$/g, "");
      return [privateState, attributes[name] ?? 0n];
    },
  };
}

describe("Identity Proof", () => {
  let issuerContract;
  let ctx;
  let holderPk;

  beforeEach(() => {
    issuerContract = new Contract(makeIssuerWitnesses(issuerKey));
    const addr = sampleContractAddress();
    const initial = issuerContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
    holderPk = pureCircuits.publicKey(holderKey);
  });

  it("should issue credential and prove above threshold", () => {
    const r1 = issuerContract.impureCircuits.issueCredential(ctx, holderPk, AGE_ATTR, 25n, salt);
    const holder = new Contract(makeHolderWitnesses(holderKey, salt, { age: 25n }));
    const r2 = holder.impureCircuits.proveAttributeAbove(r1.context, AGE_ATTR, 18n);
    expect(r2.context).toBeDefined();
  });

  it("should prove below threshold", () => {
    const r1 = issuerContract.impureCircuits.issueCredential(ctx, holderPk, DEBT_ATTR, 5000n, salt);
    const holder = new Contract(makeHolderWitnesses(holderKey, salt, { debt: 5000n }));
    const r2 = holder.impureCircuits.proveAttributeBelow(r1.context, DEBT_ATTR, 10000n);
    expect(r2.context).toBeDefined();
  });

  it("should prove exact match", () => {
    const r1 = issuerContract.impureCircuits.issueCredential(ctx, holderPk, COUNTRY_ATTR, 840n, salt);
    const holder = new Contract(makeHolderWitnesses(holderKey, salt, { country: 840n }));
    const r2 = holder.impureCircuits.proveAttributeEquals(r1.context, COUNTRY_ATTR, 840n);
    expect(r2.context).toBeDefined();
  });

  it("should reject attribute below threshold", () => {
    const r1 = issuerContract.impureCircuits.issueCredential(ctx, holderPk, AGE_ATTR, 16n, salt);
    const holder = new Contract(makeHolderWitnesses(holderKey, salt, { age: 16n }));
    expect(() => {
      holder.impureCircuits.proveAttributeAbove(r1.context, AGE_ATTR, 18n);
    }).toThrow("Attribute does not meet threshold");
  });

  it("should reject proof with wrong salt", () => {
    const r1 = issuerContract.impureCircuits.issueCredential(ctx, holderPk, AGE_ATTR, 25n, salt);
    const holder = new Contract(makeHolderWitnesses(holderKey, wrongSalt, { age: 25n }));
    expect(() => {
      holder.impureCircuits.proveAttributeAbove(r1.context, AGE_ATTR, 18n);
    }).toThrow("Credential verification failed");
  });

  it("should reject non-issuer from issuing credentials", () => {
    const nonIssuer = new Contract(makeIssuerWitnesses(nonIssuerKey));
    expect(() => {
      nonIssuer.impureCircuits.issueCredential(ctx, holderPk, AGE_ATTR, 25n, salt);
    }).toThrow("Only issuer can issue credentials");
  });
});
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly (4 circuits) and all 6
  tests pass against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is high (k ~14-15) due to the 5-element `persistentHash`
  for credential commitments. Each proof circuit performs two hash computations
  (credential key + full commitment) plus Map operations.
- The `proveAttributeAbove`, `proveAttributeBelow`, and `proveAttributeEquals`
  circuits share identical verification logic. They are kept as separate exported
  circuits to avoid the k-value explosion from cross-circuit calls. An internal
  `circuit verifyCredential(...)` could extract the common logic.
- **Parameterized witnesses work correctly.** `witness getAttributeValue(attrName: Bytes<32>): Uint<64>`
  passes the circuit parameter to the TypeScript witness function as the second
  argument (after `WitnessContext`). The parameter arrives as a `Uint8Array`.
- **`Uint<64> as Field as Bytes<32>` works.** The chained cast converts the
  attribute value for inclusion in the hash vector. Same pattern as
  `sequence.read() as Field as Bytes<32>` in other contracts.
- **No `disclose()` on hash inputs.** The `persistentHash` inputs stay private
  in the proof. Only the hash result needs `disclose()` when written to the
  `credentials` Map (export ledger).
- **Credential revocation** is not implemented. For production, add a
  `revokedCredentials: Set<Bytes<32>>` and check it during proofs.
- **Multi-attribute proofs** (e.g., "age > 18 AND credit > 700") require either
  two separate transactions or a combined circuit. The combined approach increases
  k but is more efficient.
- The `threshold` parameter is a circuit parameter (private input). The verifier
  cannot see what threshold was checked unless `disclose(threshold)` is added.
  Only the boolean comparison result is disclosed.
