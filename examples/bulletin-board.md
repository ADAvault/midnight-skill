# Bulletin Board

A single-post bulletin board demonstrating the canonical authentication pattern -- witnesses for private key management, domain-separated key hashing, and ownership verification. Based on the official [midnightntwrk/example-bboard](https://github.com/midnightntwrk/example-bboard), this is the pattern that almost every Midnight contract builds on.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum State { vacant, occupied }

export ledger state: State;
export ledger message: Opaque<"string">;
export ledger owner: Bytes<32>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;

constructor() {
  state = State.vacant;
  sequence.increment(1);
}

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "bboard:pk:"), seq, sk]);
}

export circuit post(newMessage: Opaque<"string">): [] {
  assert(state == State.vacant, "Board is occupied");
  owner = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  message = disclose(newMessage);
  state = State.occupied;
}

export circuit takeDown(): Opaque<"string"> {
  assert(state == State.occupied, "Board is vacant");
  assert(owner == publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>),
         "Not the current owner");
  const oldMessage = message;
  state = State.vacant;
  sequence.increment(1);
  return oldMessage;
}
```

---

## Key Concepts

### Authentication Pattern

This is the pattern to memorise. Every authenticated Midnight contract uses a variation of it.

**Step 1 -- Secret key in private state.** The user holds a secret key off-chain, managed by their TypeScript witness layer. The key never appears on-chain.

**Step 2 -- Witness provides the key.** `witness localSecretKey(): Bytes<32>` declares the bridge. The Compact circuit calls `localSecretKey()` and receives the key from the off-chain TypeScript implementation.

**Step 3 -- Hash-based public key derivation.** `publicKey()` takes the secret key and produces a deterministic hash:

```compact
persistentHash<Vector<3, Bytes<32>>>([pad(32, "bboard:pk:"), seq, sk])
```

Three inputs are hashed together: a domain separator, a sequence value, and the secret key. The output is a 32-byte public key.

**Step 4 -- Disclosure.** When posting, the derived public key is written to the public ledger via `disclose()`:

```compact
owner = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
```

The hash becomes public. The secret key stays private. The ZK proof guarantees the hash was correctly derived from the secret key without revealing it.

**Step 5 -- Verification.** When taking down a post, the circuit recomputes the public key from the caller's secret key and compares it to the stored owner:

```compact
assert(owner == publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>),
       "Not the current owner");
```

If the hashes match, the caller knows the secret key that produced the stored public key. This is proof of identity -- the Midnight equivalent of signature verification.

### Why Domain Separator (`"bboard:pk:"`)

The string `"bboard:pk:"` is a domain separator. It is hashed alongside the secret key to produce the public key.

Without it, the same secret key used across different contracts would produce the same public key. An observer could link the user's activity across contracts: "the owner of bulletin board X is the same entity as the admin of contract Y."

With domain separation, each contract type produces a different public key from the same secret key. Identity is isolated per contract.

### Why Sequence Counter

The `sequence` counter increments each time a post is taken down. It is included in the public key derivation.

This prevents replay attacks. After a post cycle (post then take-down), the sequence value changes, so the public key changes. A previous `owner` value cannot be reused because it was derived from an older sequence number.

Each post cycle gets a unique key derivation, even with the same secret key.

### Privacy Model

| Value | Visibility | Stored where |
|-------|-----------|--------------|
| Secret key | **PRIVATE** | Off-chain, in user's private state. Never leaves the witness. |
| Public key hash | **PUBLIC** | On ledger as `owner`. Verifiable by anyone. |
| Message content | **PUBLIC** | On ledger as `message`. Visible to all. |
| Sequence counter | **CONTRACT-PRIVATE** | On ledger but not exported. Only circuits can read it. |

The ZK proof proves: "I know a secret key that, when hashed with the domain separator and current sequence, produces the `owner` value stored on the ledger." The verifier is convinced without learning the secret key.

### Compiler Constraints on `Opaque<"string">`

`Opaque<"string">` values **cannot be constructed in-circuit** -- they must arrive via circuit parameters or witnesses. You cannot assign a string literal (e.g., `disclose("")`) to an `Opaque<"string">` ledger field. This is why `takeDown` simply transitions `state` to `vacant` without clearing the `message` field -- there is no valid in-circuit value to assign.

Circuit parameters written to `export ledger` fields require `disclose()` wrapping. Even though a parameter like `newMessage` is not witness-derived, the compiler cannot prove that statically, so `disclose()` is mandatory. This is why `post` uses `message = disclose(newMessage)` rather than a bare assignment.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';

// The Ledger type is generated by the Compact compiler
// from your contract's ledger declarations.
import type { Ledger } from '../managed/bboard/contract/index.js';

export interface BBoardPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, BBoardPrivateState>): [
    BBoardPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secretKey],
};
```

The witness is minimal: it reads `secretKey` from private state and returns it unchanged. The tuple `[privateState, privateState.secretKey]` follows the standard witness return pattern -- first element is the (potentially updated) private state, second is the return value.

The `WitnessContext` also provides read-only access to the current public ledger state, but this witness does not need it.

---

## Tests

Compiler-validated simulator tests (8/8 passing). These execute circuits directly without ZK proof generation. Multi-user testing uses separate `Contract` instances with different witnesses, sharing the context chain.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, State } from "../src/managed/bboard/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const aliceKey = new Uint8Array(32);
aliceKey[0] = 0x01;
const bobKey = new Uint8Array(32);
bobKey[0] = 0x02;

function makeWitnesses(secretKey) {
  return {
    localSecretKey: ({ privateState }) => [privateState, secretKey],
  };
}

describe("Bulletin Board", () => {
  let aliceContract;
  let bobContract;
  let ctx;

  beforeEach(() => {
    aliceContract = new Contract(makeWitnesses(aliceKey));
    bobContract = new Contract(makeWitnesses(bobKey));
    const addr = sampleContractAddress();
    const initial = aliceContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState
    );
  });

  it("should start vacant — post succeeds", () => {
    const result = aliceContract.impureCircuits.post(ctx, "Hello Midnight!");
    expect(result).toBeDefined();
  });

  it("should reject post when board is occupied", () => {
    const r1 = aliceContract.impureCircuits.post(ctx, "First message");
    expect(() => {
      aliceContract.impureCircuits.post(r1.context, "Second message");
    }).toThrow("Board is occupied");
  });

  it("should allow owner to take down message", () => {
    const r1 = aliceContract.impureCircuits.post(ctx, "Take me down");
    const r2 = aliceContract.impureCircuits.takeDown(r1.context);
    expect(r2.result).toBe("Take me down");
  });

  it("should reject takeDown from non-owner", () => {
    const r1 = aliceContract.impureCircuits.post(ctx, "Alice's message");
    expect(() => {
      bobContract.impureCircuits.takeDown(r1.context);
    }).toThrow("Not the current owner");
  });

  it("should allow new post after takeDown", () => {
    const r1 = aliceContract.impureCircuits.post(ctx, "First");
    const r2 = aliceContract.impureCircuits.takeDown(r1.context);
    const r3 = bobContract.impureCircuits.post(r2.context, "Bob's turn");
    expect(r3.context).toBeDefined();
  });

  it("should reject takeDown when board is vacant", () => {
    expect(() => {
      aliceContract.impureCircuits.takeDown(ctx);
    }).toThrow("Board is vacant");
  });

  it("should generate different public keys for different sequences", () => {
    const seq1 = new Uint8Array(32);
    seq1[0] = 0x01;
    const seq2 = new Uint8Array(32);
    seq2[0] = 0x02;
    const pk1 = pureCircuits.publicKey(aliceKey, seq1);
    const pk2 = pureCircuits.publicKey(aliceKey, seq2);
    expect(pk1).not.toEqual(pk2);
  });

  it("should generate different public keys for different users", () => {
    const seq = new Uint8Array(32);
    seq[0] = 0x01;
    const pkAlice = pureCircuits.publicKey(aliceKey, seq);
    const pkBob = pureCircuits.publicKey(bobKey, seq);
    expect(pkAlice).not.toEqual(pkBob);
  });
});
```

**Key testing patterns demonstrated:**

- **Separate `Contract` instances per user.** Alice and Bob each get their own `Contract` with distinct witnesses (different secret keys). The context chain is shared between them to simulate multi-user interaction on the same deployed contract.
- **`beforeEach` setup with `sampleContractAddress()`.** Each test gets a fresh contract address and initial context via the runtime helper.
- **Context threading.** Each circuit call returns a result whose `.context` feeds into the next call. This carries forward both the contract state and zswap local state.
- **Assertion testing with messages.** `expect(() => ...).toThrow("Board is occupied")` catches Compact `assert()` failures and verifies the specific error string.
- **`pureCircuits` for off-chain calls.** `pureCircuits.publicKey()` can be called directly without a circuit context, useful for verifying key derivation logic.

---

## Notes

- **This is THE canonical authentication pattern for Midnight.** Nearly every contract that needs user identity builds on the witness + hash-based key derivation + disclose pattern shown here.

- **`persistentHash` uses SHA-256**, not Poseidon. Use `persistentHash` when the hash must be verifiable off-chain or stored persistently. Use `transientHash` (Poseidon, ~10x cheaper in-circuit) for internal comparisons that never leave the proof.

- **`sequence.read() as Field as Bytes<32>`** is a chained type cast via `.read()`. `Counter` must be read first with `.read()`, then cast through `Field` as an intermediate step to reach `Bytes<32>`. Direct cast from `Counter` to `Bytes<32>` is not supported.

- **The pattern is analogous to Ethereum's ECDSA signature verification**, but implemented with hash-based authentication and ZK proofs. In Ethereum, you sign a message with your private key and the contract verifies the signature against a stored address. In Midnight, you provide your secret key via a witness, the circuit hashes it to derive a public key, and compares the hash against a stored owner. The ZK proof guarantees the hash computation was honest without revealing the secret key.

- **`publicKey()` is exported as a circuit**, meaning it can also be called from TypeScript for off-chain key derivation (e.g., to display the user's public key in a UI). As an exported circuit, calling it on-chain generates a ZK proof. For internal reuse within other circuits, consider an internal `circuit` variant to avoid the `k`-value explosion described in the language reference.

- **`Opaque<"string">` maps to TypeScript `string` in compiled output.** Circuit parameters typed `Opaque<"string">` accept plain JavaScript strings in the test harness and deployed client.

- **Circuit parameters need `disclose()` when written to `export ledger`** -- even if the value is not witness-derived. The compiler cannot statically prove provenance, so it conservatively requires disclosure for any value assigned to a public ledger field.

- **Multi-user testing: create separate `Contract` instances with different witnesses, share the context chain.** Each user gets their own `Contract` (with their own secret key in the witness), but the context returned from one user's circuit call is passed into the next user's call. This accurately models multiple wallets interacting with one deployed contract.

- **`pureCircuits.publicKey()` can be called directly without a circuit context.** Pure circuits (no state access, no side effects) are available on the `pureCircuits` export and can be invoked standalone for off-chain verification or testing.
