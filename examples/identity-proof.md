# Identity Proof

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
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getAge(): Uint<64>;
witness getCreditScore(): Uint<64>;
witness getCredentialSalt(): Bytes<32>;
witness getAttributeValue(attrName: Bytes<32>): Uint<64>;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "identity:pk:"), seq, sk]);
}

constructor() {
  issuer = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  sequence.increment(1);
}

// Issuer stores a commitment to a user's attributes.
// The commitment hides the actual attribute values.
// commitment = hash(domain || salt || holder || attrName || attrValue)
export circuit issueCredential(
  holder: Bytes<32>,
  attrName: Bytes<32>,
  attrValue: Uint<64>,
  salt: Bytes<32>
): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == issuer),
         "Only issuer can issue credentials");

  const commitment = persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "identity:cred:"),
    salt,
    holder,
    attrName,
    attrValue as Field as Bytes<32>
  ]);

  // Key: hash(holder || attrName) so each holder+attribute pair is unique
  const credKey = persistentHash<Vector<2, Bytes<32>>>([holder, attrName]);
  credentials.insert(disclose(credKey), disclose(commitment));
}

// User proves an attribute exceeds a threshold WITHOUT revealing the value.
// The circuit:
//   1. Recomputes the credential commitment from private inputs
//   2. Verifies it matches the on-chain commitment (proving the issuer attested this value)
//   3. Checks the attribute against the threshold
//   4. Discloses ONLY the boolean result
export circuit proveAttributeAbove(
  attrName: Bytes<32>,
  threshold: Uint<64>
): [] {
  const holder = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  const salt = getCredentialSalt();
  const attrValue = getAttributeValue(attrName);

  // Recompute the credential commitment
  const recomputed = persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "identity:cred:"),
    salt,
    holder,
    attrName,
    attrValue as Field as Bytes<32>
  ]);

  // Verify against stored commitment
  const credKey = persistentHash<Vector<2, Bytes<32>>>([holder, attrName]);
  assert(credentials.member(disclose(credKey)), "No credential found");
  const stored = credentials.lookup(disclose(credKey));
  assert(disclose(recomputed == stored), "Credential verification failed");

  // The core ZK proof: attrValue > threshold
  // Only the boolean result is disclosed -- not the actual value
  assert(disclose(attrValue > threshold), "Attribute does not meet threshold");

  verifications.increment(1);
}

// User proves an attribute is below a threshold
export circuit proveAttributeBelow(
  attrName: Bytes<32>,
  threshold: Uint<64>
): [] {
  const holder = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
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

// User proves an attribute equals an exact value
// Use case: prove country == "US" (encoded as a numeric code)
export circuit proveAttributeEquals(
  attrName: Bytes<32>,
  expected: Uint<64>
): [] {
  const holder = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
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

- **Selective disclosure:** The user proves a property of their attribute (above,
  below, equals) without revealing the attribute itself. `disclose(attrValue > 18)`
  reveals only `true` or `false`, not the actual age.
- **Issuer trust anchor:** The credential commitment is created by a trusted issuer
  and stored on-chain. When a user proves an attribute, the circuit verifies that
  the claimed value matches what the issuer attested, not what the user claims.
- **Commitment structure:** `hash(domain || salt || holder || attrName || attrValue)`
  binds the credential to a specific holder and attribute. The salt prevents
  dictionary attacks on known attribute values.
- **No witness trust required:** The circuit recomputes the commitment from the
  user's private inputs and verifies it against the issuer's on-chain commitment.
  A user cannot fake an attribute because they cannot produce a commitment that
  matches the issuer's stored hash without knowing the original salt and value.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/identity/contract/index.cjs';

export interface IdentityPrivateState {
  readonly secretKey: Uint8Array;
  readonly credentialSalt: Uint8Array;
  readonly attributes: Record<string, bigint>;  // attrName -> value
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
  ): [IdentityPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getAge: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
  ): [IdentityPrivateState, bigint] => {
    return [privateState, privateState.attributes['age'] ?? 0n];
  },

  getCreditScore: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
  ): [IdentityPrivateState, bigint] => {
    return [privateState, privateState.attributes['creditScore'] ?? 0n];
  },

  getCredentialSalt: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
  ): [IdentityPrivateState, Uint8Array] => {
    // The salt was given to the user by the issuer at credential issuance time.
    // It must be stored securely in private state.
    return [privateState, privateState.credentialSalt];
  },

  getAttributeValue: (
    { privateState }: WitnessContext<Ledger, IdentityPrivateState>,
    attrName: Uint8Array,
  ): [IdentityPrivateState, bigint] => {
    // Decode attrName bytes to string to look up in the attributes map.
    const decoder = new TextDecoder();
    const name = decoder.decode(attrName).replace(/\0+$/, '');
    return [privateState, privateState.attributes[name] ?? 0n];
  },
};
```

---

## Tests

```
describe('Identity Proof', () => {

  1. Issue credential and prove above threshold (happy path)
     - Issuer issues age=25, user proves age > 18
     - Assert verification succeeds, verifications counter increments

  2. Prove below threshold (happy path)
     - Issuer issues debt=5000, user proves debt < 10000
     - Assert verification succeeds

  3. Prove exact match (happy path)
     - Issuer issues country=840 (US code), user proves country == 840
     - Assert verification succeeds

  4. Attribute does not meet threshold (should fail)
     - Issuer issues age=16, user attempts to prove age > 18
     - Assert "Attribute does not meet threshold" error

  5. Wrong salt invalidates credential (should fail)
     - Issue with salt A, attempt proof with salt B
     - Assert "Credential verification failed" error

  6. Non-issuer cannot issue credentials (should fail)
     - Non-issuer attempts to call issueCredential
     - Assert "Only issuer" error
});
```

---

## Notes

- Circuit complexity is high (k ~14-15) due to the 5-element `persistentHash`
  for credential commitments. Each proof circuit performs two hash computations
  (credential key + full commitment) plus Map operations. For production, consider
  using `transientHash` for the in-circuit commitment recomputation if the on-chain
  stored commitment also uses Poseidon.
- The `proveAttributeAbove`, `proveAttributeBelow`, and `proveAttributeEquals`
  circuits share identical verification logic. They are kept as separate exported
  circuits to avoid the k-value explosion from cross-circuit calls. An internal
  `circuit verifyCredential(...)` could extract the common logic.
- **Credential revocation** is not implemented. For production, add a
  `revokedCredentials: Set<Bytes<32>>` and check it during proofs. The issuer
  would need a `revokeCredential` circuit.
- **Multi-attribute proofs** (e.g., "age > 18 AND credit > 700") require either
  two separate transactions or a combined circuit that verifies both credentials
  in one proof. The combined approach is more efficient but increases k.
- The `threshold` parameter is a circuit argument (public input), not a witness.
  This means the verifier can see what threshold was checked. If the threshold
  itself should be private, it must come from a witness with appropriate
  disclosure analysis.
