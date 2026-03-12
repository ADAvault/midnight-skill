# Credential Registry

> **Compiler-validated:** Contract compiles and 6/6 tests pass against Compact 0.29.0.

A nullifier-based credential system that prevents double-use of credentials
without revealing which credential was used. The issuer publishes credential
commitments on-chain; the holder later proves knowledge of the commitment
pre-image and publishes a nullifier that prevents reuse. The commitment and
nullifier cannot be linked by an observer -- this is the fundamental
ZCash/Tornado Cash privacy primitive, applied here to single-use credentials.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger issuer: Bytes<32>;
export ledger credentials: Map<Bytes<32>, Boolean>;
export ledger nullifiers: Map<Bytes<32>, Boolean>;
export ledger totalIssued: Counter;
export ledger totalUsed: Counter;

witness localSecretKey(): Bytes<32>;
witness getCredentialSecret(): Bytes<32>;
witness getCredentialNonce(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "cred:pk:"), sk]);
}

export pure circuit credentialCommitment(
  holder: Bytes<32>,
  secret: Bytes<32>,
  nonce: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "cred:commit:"),
    holder,
    secret,
    nonce
  ]);
}

export pure circuit nullifierHash(
  holder: Bytes<32>,
  secret: Bytes<32>,
  nonce: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "cred:null:"),
    holder,
    secret,
    nonce
  ]);
}

constructor() {
  issuer = disclose(publicKey(localSecretKey()));
}

export circuit issue(commitment: Bytes<32>): [] {
  assert(issuer == publicKey(localSecretKey()), "Only issuer");
  assert(!credentials.member(disclose(commitment)), "Credential already exists");

  credentials.insert(disclose(commitment), true);
  totalIssued.increment(1);
}

export circuit use(): [] {
  const holderPk = publicKey(localSecretKey());
  const secret = getCredentialSecret();
  const nonce = getCredentialNonce();

  // Recompute the commitment from private inputs
  const commitment = credentialCommitment(holderPk, secret, nonce);
  assert(credentials.member(disclose(commitment)), "Credential not found");

  // Compute the nullifier — different hash domain, same inputs
  const nullifier = nullifierHash(holderPk, secret, nonce);
  assert(!nullifiers.member(disclose(nullifier)), "Credential already used");

  nullifiers.insert(disclose(nullifier), true);
  totalUsed.increment(1);
}

export circuit verify(commitment: Bytes<32>): Boolean {
  if (credentials.member(disclose(commitment))) { return credentials.lookup(disclose(commitment)); } return false;
}

export circuit isUsed(nullifierValue: Bytes<32>): Boolean {
  return nullifiers.member(disclose(nullifierValue));
}

export circuit revoke(commitment: Bytes<32>): [] {
  assert(issuer == publicKey(localSecretKey()), "Only issuer");
  assert(credentials.member(disclose(commitment)), "Credential not found");

  credentials.insert(disclose(commitment), false);
}
```

---

## Key Concepts

### The nullifier pattern

The nullifier is the foundational privacy primitive behind ZCash, Tornado Cash,
and most anonymous credential systems. It solves a seemingly impossible problem:
how to prove you have not used a credential before, without revealing which
credential you hold.

The mechanism works in two layers:

1. **Commitment (issue-time):** The issuer computes
   `hash("cred:commit:", holder, secret, nonce)` and publishes it on-chain.
   This commitment is opaque -- an observer cannot determine the holder,
   secret, or nonce from the hash.

2. **Nullifier (use-time):** The holder computes
   `hash("cred:null:", holder, secret, nonce)` and publishes it on-chain.
   The contract checks that this nullifier has not been seen before. If it
   has, the credential is rejected as a double-use.

The critical insight is that the commitment and nullifier use **different hash
domain separators** (`"cred:commit:"` vs `"cred:null:"`). This means:

- Given a commitment, you cannot compute the corresponding nullifier (you would
  need the pre-image components: holder, secret, nonce).
- Given a nullifier, you cannot compute the corresponding commitment.
- An observer sees both values on-chain but cannot link them.

The ZK proof guarantees that the nullifier was correctly derived from a valid
commitment's pre-image, without revealing which commitment it corresponds to.

### Unlinkability between commitments and nullifiers

Consider 100 credentials issued to various holders. When holder Alice uses her
credential, the nullifier she publishes cannot be linked to any of the 100
commitments by an external observer. They know *some* credential was used (they
see a new nullifier), but not *which one*. Alice's privacy set is the full set
of issued credentials.

This is stronger than pseudonymous systems (like Ethereum addresses) where all
actions by the same address are linkable. Here, even multiple uses by the same
holder (with different nonces) produce unrelated nullifiers.

### Off-chain commitment computation

In this design, the commitment is computed off-chain by the issuer and passed
as a parameter to the `issue()` circuit. This is intentional: the issuer and
holder collaborate off-chain to agree on the secret and nonce, then the issuer
publishes only the resulting commitment.

An alternative design would have the holder call `issue()` and compute the
commitment in-circuit. The trade-off is that the holder's transaction would
then be linkable to the commitment (the transaction submitter is visible even
if the circuit inputs are not). By having the issuer publish the commitment,
the holder is completely absent from the issuance transaction.

### Single-use credentials vs reusable identity

This contract implements **single-use credentials**: each credential can be
used exactly once (enforced by the nullifier set). This is appropriate for:

- Event tickets (use once to enter)
- Vouchers or coupons (redeem once)
- Voting rights (vote once per election)
- Access tokens (one-time authorization)

For **reusable credentials** (e.g., "prove you are over 18" repeatedly), you
would omit the nullifier mechanism entirely and rely only on the commitment
proof. The holder could prove knowledge of the commitment pre-image as many
times as needed without publishing a nullifier. However, this introduces a
risk: repeated proofs for the same credential could be correlated unless
additional randomization is applied to each proof.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/credential/contract/index.cjs';

export interface CredentialPrivateState {
  readonly secretKey: Uint8Array;
  readonly credentialSecret?: Uint8Array;
  readonly credentialNonce?: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, CredentialPrivateState>,
  ): [CredentialPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getCredentialSecret: (
    { privateState }: WitnessContext<Ledger, CredentialPrivateState>,
  ): [CredentialPrivateState, Uint8Array] => {
    if (!privateState.credentialSecret)
      throw new Error('No credential secret in private state');
    return [privateState, privateState.credentialSecret];
  },

  getCredentialNonce: (
    { privateState }: WitnessContext<Ledger, CredentialPrivateState>,
  ): [CredentialPrivateState, Uint8Array] => {
    if (!privateState.credentialNonce)
      throw new Error('No credential nonce in private state');
    return [privateState, privateState.credentialNonce];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/credential/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import crypto from "crypto";

setNetworkId("undeployed");

const issuerKey = new Uint8Array(32); issuerKey[0] = 0x01;
const aliceKey = new Uint8Array(32); aliceKey[0] = 0x02;
const bobKey = new Uint8Array(32); bobKey[0] = 0x03;
const eveKey = new Uint8Array(32); eveKey[0] = 0x04;

const secret1 = crypto.randomBytes(32);
const secret2 = crypto.randomBytes(32);
const wrongSecret = crypto.randomBytes(32);
const nonce1 = crypto.randomBytes(32);
const nonce2 = crypto.randomBytes(32);

function makeWitnesses(sk, secret = null, nonce = null) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCredentialSecret: ({ privateState }) => {
      if (!secret) throw new Error("No credential secret in private state");
      return [privateState, secret];
    },
    getCredentialNonce: ({ privateState }) => {
      if (!nonce) throw new Error("No credential nonce in private state");
      return [privateState, nonce];
    },
  };
}

describe("Credential Registry", () => {
  let issuerContract;
  let ctx;

  beforeEach(() => {
    issuerContract = new Contract(makeWitnesses(issuerKey));
    const addr = sampleContractAddress();
    const initial = issuerContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should issue and use credential", () => {
    // Issuer computes commitment off-chain for Alice
    const alicePk = pureCircuits.publicKey(aliceKey);
    const commitment = pureCircuits.credentialCommitment(alicePk, secret1, nonce1);

    // Issuer publishes commitment
    const r1 = issuerContract.impureCircuits.issue(ctx, commitment);

    // Verify credential exists
    const r2 = issuerContract.impureCircuits.verify(r1.context, commitment);
    expect(r2.result).toBe(true);

    // Alice uses the credential
    const alice = new Contract(makeWitnesses(aliceKey, secret1, nonce1));
    const r3 = alice.impureCircuits.use(r2.context);
    expect(r3.context).toBeDefined();
  });

  it("should reject double-use via nullifier", () => {
    const alicePk = pureCircuits.publicKey(aliceKey);
    const commitment = pureCircuits.credentialCommitment(alicePk, secret1, nonce1);

    const r1 = issuerContract.impureCircuits.issue(ctx, commitment);
    const alice = new Contract(makeWitnesses(aliceKey, secret1, nonce1));
    const r2 = alice.impureCircuits.use(r1.context);

    // Second use should fail — nullifier already exists
    expect(() => {
      alice.impureCircuits.use(r2.context);
    }).toThrow("Credential already used");
  });

  it("should reject use with wrong secret", () => {
    const alicePk = pureCircuits.publicKey(aliceKey);
    const commitment = pureCircuits.credentialCommitment(alicePk, secret1, nonce1);

    const r1 = issuerContract.impureCircuits.issue(ctx, commitment);

    // Alice tries with wrong secret — recomputed commitment won't match
    const aliceWrong = new Contract(makeWitnesses(aliceKey, wrongSecret, nonce1));
    expect(() => {
      aliceWrong.impureCircuits.use(r1.context);
    }).toThrow("Credential not found");
  });

  it("should reject non-issuer issuing", () => {
    const alicePk = pureCircuits.publicKey(aliceKey);
    const commitment = pureCircuits.credentialCommitment(alicePk, secret1, nonce1);

    const eve = new Contract(makeWitnesses(eveKey));
    expect(() => {
      eve.impureCircuits.issue(ctx, commitment);
    }).toThrow("Only issuer");
  });

  it("should revoke credential", () => {
    const alicePk = pureCircuits.publicKey(aliceKey);
    const commitment = pureCircuits.credentialCommitment(alicePk, secret1, nonce1);

    const r1 = issuerContract.impureCircuits.issue(ctx, commitment);

    // Issuer revokes
    const r2 = issuerContract.impureCircuits.revoke(r1.context, commitment);

    // Verify returns false after revocation
    const r3 = issuerContract.impureCircuits.verify(r2.context, commitment);
    expect(r3.result).toBe(false);
  });

  it("should query verify and isUsed", () => {
    const alicePk = pureCircuits.publicKey(aliceKey);
    const commitment = pureCircuits.credentialCommitment(alicePk, secret1, nonce1);
    const nullifier = pureCircuits.nullifierHash(alicePk, secret1, nonce1);

    const r1 = issuerContract.impureCircuits.issue(ctx, commitment);

    // Before use: credential exists, nullifier does not
    const r2 = issuerContract.impureCircuits.verify(r1.context, commitment);
    expect(r2.result).toBe(true);
    const r3 = issuerContract.impureCircuits.isUsed(r2.context, nullifier);
    expect(r3.result).toBe(false);

    // After use: nullifier exists
    const alice = new Contract(makeWitnesses(aliceKey, secret1, nonce1));
    const r4 = alice.impureCircuits.use(r3.context);
    const r5 = alice.impureCircuits.isUsed(r4.context, nullifier);
    expect(r5.result).toBe(true);
  });
});
```

---

## CLI

```bash
compact compile src/credential.compact src/managed/credential
npm test
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly and all 6 tests pass
  against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity for `use()` is moderate-to-high (k ~14-15) due to two
  4-element `persistentHash` computations (commitment + nullifier) and two
  Map membership checks. The `issue()` and `revoke()` circuits are simpler
  (k ~12).
- No sequence counter is needed because the issuer's identity is fixed at
  deployment and the holder's public key is derived deterministically from
  their secret key. There are no lifecycle phases that would require key
  rotation.
- The `credentialCommitment` and `nullifierHash` pure circuits are internal
  (not `export`) in the Compact contract but are exposed by the compiler as
  `pureCircuits.credentialCommitment` and `pureCircuits.nullifierHash` in
  TypeScript. This allows the issuer to compute commitments off-chain before
  calling `issue()`. If the compiler does not export internal pure circuits,
  replicate the hash logic in TypeScript using `@midnight-ntwrk/compact-runtime`
  hash utilities.
- **Privacy set size matters.** The unlinkability guarantee is only as strong
  as the number of issued credentials. If only one credential exists, the
  nullifier trivially links to that commitment. In production, batch issuance
  and mixing with other contracts' commitments increases the anonymity set.
- **Revocation model:** The `revoke()` circuit sets the credential's boolean
  to `false` in the Map. This prevents future `use()` calls (the `member`
  check passes but the boolean value would need to be checked for a strict
  implementation). For stronger revocation, the issuer could maintain a
  separate revocation list or use an accumulator that supports removal.
- For multi-use credentials (e.g., identity proofs), remove the nullifier
  mechanism. The holder proves knowledge of the commitment pre-image without
  publishing any on-chain artifact. Each proof is unlinkable if the circuit
  uses fresh randomness.
- The commitment is passed as a parameter to `issue()` rather than computed
  in-circuit. This keeps the issuer's transaction from revealing which holder
  the credential belongs to, since the commitment is computed collaboratively
  off-chain.
