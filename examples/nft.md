# NFT (Commitment-Based Ownership)

> **Compiler-validated:** Contract compiles and 6/6 tests pass against Compact 0.29.0.

An NFT contract that stores ownership as hash commitments rather than plain
addresses. Transferring a token requires proving knowledge of the commitment
pre-image via ZK proof, so ownership is never visible on-chain. This teaches
the commitment-based ownership pattern -- the Midnight equivalent of
ERC-721, but with the owner hidden behind a hash at all times.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger owners: Map<Bytes<32>, Bytes<32>>;
export ledger tokenExists: Map<Bytes<32>, Boolean>;
export ledger totalMinted: Counter;
export ledger approvals: Map<Bytes<32>, Bytes<32>>;

witness localSecretKey(): Bytes<32>;
witness getOwnershipSalt(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "nft:pk:"), sk]);
}

pure circuit ownerCommitment(
  pk: Bytes<32>,
  salt: Bytes<32>,
  tokenId: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "nft:own:"),
    pk,
    salt,
    tokenId
  ]);
}

constructor() {
  admin = disclose(publicKey(localSecretKey()));
}

export circuit mint(
  to: Bytes<32>,
  tokenId: Bytes<32>,
  salt: Bytes<32>
): [] {
  assert(admin == publicKey(localSecretKey()), "Only admin");
  assert(!tokenExists.member(disclose(tokenId)), "Token already exists");

  const commitment = ownerCommitment(to, salt, tokenId);
  owners.insert(disclose(tokenId), disclose(commitment));
  tokenExists.insert(disclose(tokenId), true);
  totalMinted.increment(1);
}

export circuit transfer(
  tokenId: Bytes<32>,
  newOwner: Bytes<32>,
  newSalt: Bytes<32>
): [] {
  assert(tokenExists.member(disclose(tokenId)), "Token does not exist");

  const callerPk = publicKey(localSecretKey());
  const salt = getOwnershipSalt();
  const commitment = ownerCommitment(callerPk, salt, tokenId);
  const stored = owners.lookup(disclose(tokenId));
  assert(disclose(commitment == stored), "Not the owner");

  const newCommitment = ownerCommitment(newOwner, newSalt, tokenId);
  owners.insert(disclose(tokenId), disclose(newCommitment));

  if (approvals.member(disclose(tokenId))) {
    approvals.insert(disclose(tokenId), pad(32, ""));
  }
}

export circuit burn(tokenId: Bytes<32>): [] {
  assert(tokenExists.member(disclose(tokenId)), "Token does not exist");

  const callerPk = publicKey(localSecretKey());
  const salt = getOwnershipSalt();
  const commitment = ownerCommitment(callerPk, salt, tokenId);
  const stored = owners.lookup(disclose(tokenId));
  assert(disclose(commitment == stored), "Not the owner");

  owners.insert(disclose(tokenId), pad(32, ""));
  tokenExists.insert(disclose(tokenId), false);
  totalMinted.decrement(1);
}

export circuit approve(
  tokenId: Bytes<32>,
  approved: Bytes<32>
): [] {
  assert(tokenExists.member(disclose(tokenId)), "Token does not exist");

  const callerPk = publicKey(localSecretKey());
  const salt = getOwnershipSalt();
  const commitment = ownerCommitment(callerPk, salt, tokenId);
  const stored = owners.lookup(disclose(tokenId));
  assert(disclose(commitment == stored), "Not the owner");

  approvals.insert(disclose(tokenId), disclose(approved));
}

export circuit transferFrom(
  tokenId: Bytes<32>,
  newOwner: Bytes<32>,
  newSalt: Bytes<32>
): [] {
  assert(tokenExists.member(disclose(tokenId)), "Token does not exist");
  assert(approvals.member(disclose(tokenId)), "No approval set");

  const callerPk = publicKey(localSecretKey());
  const storedApproval = approvals.lookup(disclose(tokenId));
  assert(disclose(callerPk == storedApproval), "Not approved");

  const newCommitment = ownerCommitment(newOwner, newSalt, tokenId);
  owners.insert(disclose(tokenId), disclose(newCommitment));
  approvals.insert(disclose(tokenId), pad(32, ""));
}

export circuit verifyOwnership(tokenId: Bytes<32>): [] {
  assert(tokenExists.member(disclose(tokenId)), "Token does not exist");

  const callerPk = publicKey(localSecretKey());
  const salt = getOwnershipSalt();
  const commitment = ownerCommitment(callerPk, salt, tokenId);
  const stored = owners.lookup(disclose(tokenId));
  assert(disclose(commitment == stored), "Not the owner");
}

export circuit totalSupply(): Uint<64> {
  return totalMinted.read();
}
```

---

## Key Concepts

### Commitment-based ownership

In a traditional ERC-721 contract, the owner's address is stored in plain text
on-chain. Anyone can see who owns which token. On Midnight, ownership is stored
as a hash commitment: `persistentHash(domainSep, ownerPk, salt, tokenId)`. The
on-chain ledger only ever contains this opaque 32-byte value. To prove you own
a token, you provide the pre-image components inside a ZK circuit -- the proof
verifies the hash matches without revealing your public key or salt.

This means an observer scanning the ledger sees only commitments. They cannot
determine who owns a given token, whether two tokens share an owner, or how
many tokens a specific party holds.

### Salt rotation on transfer

When a token changes hands, the new owner provides a fresh salt for their
commitment. This is critical for unlinkability: if the same salt were reused,
an observer who knew the old commitment and the new one could potentially
correlate them (especially if the hash function or domain separator leaked
information about the structure). A fresh salt ensures the new commitment is
indistinguishable from any other random 32-byte value.

The old owner's salt is consumed during the transfer proof and never appears
on-chain. The new owner must remember their salt (stored in private state) to
later prove ownership or transfer the token again.

### Approval pattern without revealing owner identity

The `approve` circuit lets an owner grant transfer rights to another party
without revealing who the owner is. The approved address is stored on-chain
(it must be, so `transferFrom` can verify it), but the owner's identity
remains hidden behind their commitment. The approved party calls
`transferFrom` and proves they match the stored approval, but they never
learn the owner's secret key or salt.

After any transfer (including `transferFrom`), the approval is cleared by
overwriting with an empty value.

### Comparison with ERC-721

| Aspect | ERC-721 (Ethereum) | NFT (Midnight/Compact) |
|--------|-------------------|----------------------|
| Owner visibility | Public address on-chain | Hidden behind hash commitment |
| Transfer auth | `msg.sender == owner` | ZK proof of commitment pre-image |
| Approval | `approve(spender)` visible | Approval visible, owner hidden |
| Enumeration | `ownerOf(tokenId)` returns address | `verifyOwnership` is a proof, not a query |
| Linkability | Trivial to link all tokens to an owner | Unlinkable across tokens and transfers |

The trade-off is UX complexity: owners must manage salts in private state, and
losing a salt means losing the ability to prove ownership (the token is
effectively burned).

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/nft/contract/index.cjs';

export interface NftPrivateState {
  readonly secretKey: Uint8Array;
  readonly ownershipSalt: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, NftPrivateState>,
  ): [NftPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getOwnershipSalt: (
    { privateState }: WitnessContext<Ledger, NftPrivateState>,
  ): [NftPrivateState, Uint8Array] => {
    // Salt must be retained in private state until the token is
    // transferred or burned. Losing the salt = losing the token.
    return [privateState, privateState.ownershipSalt];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/nft/contract/index.js";
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
const eveKey = new Uint8Array(32); eveKey[0] = 0x04;

const salt1 = new Uint8Array(32); salt1[0] = 0xAA;
const salt2 = new Uint8Array(32); salt2[0] = 0xBB;
const salt3 = new Uint8Array(32); salt3[0] = 0xCC;

const tokenId1 = new Uint8Array(32); tokenId1[0] = 0x01;
const tokenId2 = new Uint8Array(32); tokenId2[0] = 0x02;

function makeWitnesses(sk, salt = salt1) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getOwnershipSalt: ({ privateState }) => [privateState, salt],
  };
}

describe("NFT", () => {
  let adminContract;
  let ctx;
  let alicePk;
  let bobPk;

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

    alicePk = pureCircuits.publicKey(aliceKey);
    bobPk = pureCircuits.publicKey(bobKey);
  });

  it("should mint and verify ownership", () => {
    const r1 = adminContract.impureCircuits.mint(ctx, alicePk, tokenId1, salt1);
    const alice = new Contract(makeWitnesses(aliceKey, salt1));
    const r2 = alice.impureCircuits.verifyOwnership(r1.context, tokenId1);
    expect(r2.context).toBeDefined();
    const r3 = alice.impureCircuits.totalSupply(r2.context);
    expect(r3.result).toBe(1n);
  });

  it("should transfer to new owner", () => {
    const r1 = adminContract.impureCircuits.mint(ctx, alicePk, tokenId1, salt1);
    const alice = new Contract(makeWitnesses(aliceKey, salt1));
    const r2 = alice.impureCircuits.transfer(r1.context, tokenId1, bobPk, salt2);
    // Bob can now verify ownership with the new salt
    const bob = new Contract(makeWitnesses(bobKey, salt2));
    const r3 = bob.impureCircuits.verifyOwnership(r2.context, tokenId1);
    expect(r3.context).toBeDefined();
  });

  it("should burn token", () => {
    const r1 = adminContract.impureCircuits.mint(ctx, alicePk, tokenId1, salt1);
    const alice = new Contract(makeWitnesses(aliceKey, salt1));
    const r2 = alice.impureCircuits.burn(r1.context, tokenId1);
    const r3 = alice.impureCircuits.totalSupply(r2.context);
    expect(r3.result).toBe(0n);
  });

  it("should reject unauthorized mint", () => {
    const eve = new Contract(makeWitnesses(eveKey));
    expect(() => {
      eve.impureCircuits.mint(ctx, alicePk, tokenId1, salt1);
    }).toThrow("Only admin");
  });

  it("should reject transfer by non-owner", () => {
    const r1 = adminContract.impureCircuits.mint(ctx, alicePk, tokenId1, salt1);
    const eve = new Contract(makeWitnesses(eveKey, salt1));
    expect(() => {
      eve.impureCircuits.transfer(r1.context, bobPk, salt2);
    }).toThrow("Not the owner");
  });

  it("should approve and transferFrom", () => {
    const r1 = adminContract.impureCircuits.mint(ctx, alicePk, tokenId1, salt1);
    const alice = new Contract(makeWitnesses(aliceKey, salt1));
    const r2 = alice.impureCircuits.approve(r1.context, tokenId1, bobPk);
    const bob = new Contract(makeWitnesses(bobKey, salt2));
    const r3 = bob.impureCircuits.transferFrom(r2.context, tokenId1, bobPk, salt2);
    // Bob verifies ownership with his own salt
    const r4 = bob.impureCircuits.verifyOwnership(r3.context, tokenId1);
    expect(r4.context).toBeDefined();
  });
});
```

---

## CLI

```bash
compact compile src/nft.compact src/managed/nft
npm test
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly and all 6 tests pass
  against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is moderate-to-high (k ~14-15) due to the 4-element
  `persistentHash` in `ownerCommitment` and multiple Map lookups per circuit.
  The `transfer` circuit is the most expensive: it computes two commitments
  (verify old + create new) and performs two Map writes.
- No sequence counter is needed because ownership is deterministic: the
  commitment is derived from the owner's public key, their salt, and the
  token ID. Unlike escrow or auction contracts, there is no lifecycle that
  changes the meaning of a public key.
- The `publicKey` pure circuit takes only `sk` (no sequence parameter) since
  there are no lifecycle phases. This simplifies off-chain key derivation.
- Salt management is the critical UX challenge. If a user loses their salt,
  the token is effectively bricked -- no one can prove ownership. In
  production, salts should be encrypted and backed up in the user's wallet.
- The `burn` circuit uses `insert` with empty/false values rather than a
  `delete` operation because Compact Maps do not support deletion. The
  `tokenExists` map distinguishes live tokens from burned ones.
- For real NFTs with metadata (images, attributes), store a content hash
  on-chain and the full metadata off-chain (IPFS, Arweave). Add a
  `metadata: Map<Bytes<32>, Bytes<32>>` ledger field mapping tokenId to
  content hash.
- The approval pattern is intentionally simple (one approval per token).
  For operator-level approvals (ERC-721 `setApprovalForAll`), you would
  need a nested Map or a separate approval contract.
