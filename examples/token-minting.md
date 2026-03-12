# Token Minting

> **Not simulator-testable:** This contract uses Zswap coin operations (`mintShieldedToken`,
> `tokenType`, `kernel.self()`) that require the full Midnight network stack
> (proof server + indexer + Zswap protocol). It cannot be validated using
> `compact-runtime` simulator tests alone. Network validation is pending.

A shielded token creation contract using Midnight's built-in `mintShieldedToken`
operation. The admin initializes a token domain, then mints new shielded tokens
to any recipient's Zswap public key. Minted coins enter the Zswap shielded
pool -- amounts and recipients are hidden from chain observers. The contract
tracks a nonce Counter to guarantee unique coin derivation per mint call.
Demonstrates the Zswap mint lifecycle, nonce evolution pattern, token type
derivation, and the distinction between minting (creating new supply) and
receiving (accepting existing coins).

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger admin: Bytes<32>;
export ledger tokenDomain: Bytes<32>;
export ledger totalMinted: Counter;
export ledger nonce: Counter;

witness localSecretKey(): Bytes<32>;
witness ownPublicKey(): ZswapCoinPublicKey;
witness getMintAmount(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "mint:pk:"), sk]);
}

constructor() {
  admin = disclose(publicKey(localSecretKey()));
}

export circuit initialize(domain: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");
  tokenDomain = disclose(domain);
}

export circuit mint(recipient: ZswapCoinPublicKey, amount: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == admin, "Only admin");

  // Derive the token type from domain separator + this contract's address
  const tt = tokenType(tokenDomain, kernel.self());

  // mintShieldedToken requires a unique nonce per call.
  // The Counter guarantees uniqueness: read current value, then increment.
  const currentNonce = nonce.read() as Field as Bytes<32>;

  // Mint shielded tokens into the Zswap pool
  mintShieldedToken(
    tokenDomain,
    disclose(amount),
    currentNonce,
    left<ZswapCoinPublicKey, ContractAddress>(disclose(recipient))
  );

  nonce.increment(1);
  totalMinted.increment(1);
}

export circuit getNonce(): Uint<64> {
  return nonce.read();
}
```

---

## Key Concepts

### mintShieldedToken Mechanics

`mintShieldedToken(domainSeparator, amount, nonce, recipient)` creates new shielded
tokens in the Zswap pool. The four parameters:

1. **domainSeparator** (`Bytes<32>`) -- identifies the token type. Combined with
   the contract address to produce a unique token type identifier.
2. **amount** (`Uint<64>`) -- how many tokens to mint. This value is shielded
   in the Zswap pool -- chain observers cannot see the minted amount.
3. **nonce** (`Uint<64>`) -- must be unique per `mintShieldedToken` call within this
   contract. Reusing a nonce would create a duplicate coin commitment, which
   the Zswap protocol would reject.
4. **recipient** (`Left<ZswapCoinPublicKey, ContractAddress>`) -- the Zswap
   public key of the recipient wallet. Wrapped in `left<>()` because the
   recipient type is a union (coin can go to a wallet key or a contract
   address).

### Evolve-Nonce Pattern

The nonce Counter guarantees uniqueness:

```
mint call 1: nonce.read() = 0, then nonce.increment(1)
mint call 2: nonce.read() = 1, then nonce.increment(1)
mint call 3: nonce.read() = 2, then nonce.increment(1)
```

Each `mintShieldedToken` call uses the current nonce value, then advances it. This is
the standard "evolve nonce" pattern for Zswap coin creation. Without it,
two mints of the same amount to the same recipient would produce identical
coin commitments, violating the Zswap uniqueness constraint.

### Token Type Derivation

`tokenType(domain, contractAddress)` produces a deterministic token type
identifier. The same domain separator used with different contract addresses
produces different token types. This means each deployed instance of this
contract creates a distinct token, even if they use the same domain string.

### Mint vs. Receive

| Operation | Direction | Purpose |
|-----------|-----------|---------|
| `mintShieldedToken(...)` | Contract --> Zswap pool | Create new supply (tokens did not exist before) |
| `receive(...)` | Zswap pool --> Contract | Accept existing tokens into the contract |
| `sendImmediate(...)` | Contract --> Zswap pool | Send held tokens to a recipient |

`mintShieldedToken` creates new tokens. `receive` accepts existing tokens (used here
for burning -- the contract accepts the coin but never sends it back).
`sendImmediate` (not used in this contract) would send tokens the contract
already holds.

### Shielded Supply

The `totalMinted` Counter tracks the number of mint operations (publicly
visible), but the actual amounts minted are shielded. A chain observer can see
"3 mint operations occurred" but cannot determine if 100, 1000, or 1000000
tokens were created in total. Only the participants (admin and recipients) know
the amounts.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/token-mint/contract/index.js';

export interface MintPrivateState {
  readonly secretKey: Uint8Array;
  readonly coinPublicKey: Uint8Array;
  readonly mintAmount: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, MintPrivateState>,
  ): [MintPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  ownPublicKey: (
    { privateState }: WitnessContext<Ledger, MintPrivateState>,
  ): [MintPrivateState, Uint8Array] => {
    // In production, this comes from the wallet SDK.
    // The wallet provides a fresh unlinkable key per transaction.
    return [privateState, privateState.coinPublicKey];
  },

  getMintAmount: (
    { privateState }: WitnessContext<Ledger, MintPrivateState>,
  ): [MintPrivateState, bigint] => {
    return [privateState, privateState.mintAmount];
  },
};

// Helper: create a domain separator from a human-readable name
export function tokenDomain(name: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(name);
  bytes.set(encoded.slice(0, 32));
  return bytes;
}
```

---

## Tests

```
describe('Token Minting', () => {

  1. Initialize and mint (happy path)
     - Admin initializes token domain
     - Admin mints tokens to a recipient
     - Assert nonce incremented, totalMinted incremented

  2. Mint multiple times (nonce evolution)
     - Initialize domain
     - Mint 3 times sequentially
     - Assert getNonce() returns 3
     - Confirms each mint used a unique nonce

  3. Burn tokens
     - Receive a coin into the contract (destroying it)
     - Assert the receive completes without error

  4. Non-admin cannot mint (should fail)
     - Non-admin attempts mint
     - Assert "Only admin" error

  5. Non-admin cannot initialize (should fail)
     - Non-admin attempts initialize
     - Assert "Only admin" error

  6. Mint to different recipients
     - Initialize domain
     - Mint to recipient A, then mint to recipient B
     - Assert nonce is 2, totalMinted is 2
     - Each recipient receives independently shielded coins
});
```

---

## CLI

```bash
compact compile src/token-mint.compact src/managed/token-mint
npm test
```

---

## Notes

- **Not simulator-testable.** Like token-swap, this contract uses `mintShieldedToken`,
  `tokenType`, `receive(coin)`, and `kernel.self()` -- all of which require
  the full Midnight network stack. Will be validated on rezi@rey once
  devnet/testnet access is available.
- **Nonce must be unique per mint call.** If the nonce is reused, the Zswap
  protocol rejects the transaction (duplicate coin commitment). The Counter
  type guarantees monotonic uniqueness.
- **No sequence counter needed.** Admin identity is deterministic from the
  secret key alone. The `nonce` Counter serves a different purpose (coin
  derivation, not replay protection).
- **`tokenType` vs `tokenDomain`:** `tokenDomain` is the human-chosen domain
  separator (stored on ledger). `tokenType(domain, kernel.self())` combines it
  with the contract address to produce the actual token type identifier used by
  the Zswap protocol. Same domain + different contract = different token type.
- **Burn is simplified.** The `burn()` circuit calls `receive(coin)` to accept
  a coin but never sends it anywhere. The coin is effectively destroyed -- it
  exists in the contract's Zswap state but is inaccessible. A production burn
  might track total burned for supply accounting.
- **Supply is unbounded.** This contract has no max supply check. A production
  token contract would add `maxSupply: Uint<64>` to the ledger and assert
  against it in `mint()`. Since minted amounts are shielded, the supply cap
  would need to track cumulative amounts via a separate ledger field that the
  admin updates.
- Circuit complexity: `initialize` is lightweight (k ~8-10). `mint` is heavier
  (k ~14-16) due to `tokenType` derivation, `mintShieldedToken` coin creation, and
  Counter operations.
- The `left<ZswapCoinPublicKey, ContractAddress>(recipient)` wrapping is
  required because `mintShieldedToken`'s recipient parameter is a union type. Use
  `left` for wallet recipients, `right` for contract recipients.
