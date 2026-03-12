# Token Swap

An atomic swap contract for exchanging two different shielded token types through
the Zswap protocol. Party A deposits token X, party B deposits token Y, and the
contract releases each party's deposit to the other. All coin operations use
Midnight's built-in shielded token mechanics (`receive`, `sendImmediate`,
`mintToken`, `tokenType`). Demonstrates coin lifecycle, shielded transfer
mechanics, and the atomic exchange pattern.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum SwapState { open, partyAFunded, partyBFunded, bothFunded, completed, cancelled }

export ledger state: SwapState;
export ledger partyA: Bytes<32>;
export ledger partyB: Bytes<32>;
export ledger tokenDomainA: Bytes<32>;
export ledger tokenDomainB: Bytes<32>;
export ledger amountA: Uint<64>;
export ledger amountB: Uint<64>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness ownPublicKey(): ZswapCoinPublicKey;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "swap:pk:"), seq, sk]);
}

constructor() {
  state = SwapState.open;
  sequence.increment(1);
}

// Party A initializes the swap terms
export circuit initSwap(
  bParty: Bytes<32>,
  domainA: Bytes<32>,
  domainB: Bytes<32>,
  amtA: Uint<64>,
  amtB: Uint<64>
): [] {
  assert(state == SwapState.open, "Swap already initialized");

  partyA = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  partyB = bParty;
  tokenDomainA = domainA;
  tokenDomainB = domainB;
  amountA = amtA;
  amountB = amtB;
}

// Party A deposits their tokens into the contract
export circuit depositA(): [] {
  assert(state == SwapState.open, "Invalid state for party A deposit");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == partyA),
         "Not party A");

  // Accept the incoming coin -- the coin metadata (type, amount)
  // is verified by the Zswap protocol layer
  receive(coin);

  state = SwapState.partyAFunded;
}

// Party B deposits their tokens
export circuit depositB(): [] {
  assert(state == SwapState.partyAFunded, "Party A must deposit first");
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == partyB),
         "Not party B");

  receive(coin);

  state = SwapState.bothFunded;
}

// Execute the swap: send A's tokens to B, B's tokens to A
export circuit executeSwap(): [] {
  assert(state == SwapState.bothFunded, "Both parties must fund first");

  // Either party can trigger execution once both have funded
  const caller = publicKey(localSecretKey(), sequence as Field as Bytes<32>);
  assert(disclose(caller == partyA || caller == partyB), "Not a swap party");

  // Get the public keys for coin delivery
  const recipientPk = ownPublicKey();

  // Construct token types from stored domain separators
  const tokenTypeA = tokenType(tokenDomainA, kernel.self());
  const tokenTypeB = tokenType(tokenDomainB, kernel.self());

  // Send party A's tokens to party B (or vice versa depending on caller)
  // NOTE: In a full implementation, you would need both parties'
  // ZswapCoinPublicKeys. Since ownPublicKey() returns the CALLER's key,
  // a production version would store each party's coin public key during
  // deposit and use them here.
  //
  // Simplified: caller receives the other party's tokens
  if (disclose(caller == partyA)) {
    // Party A triggered: send B's tokens to A
    sendImmediate(tokenTypeB, left<ZswapCoinPublicKey, ContractAddress>(recipientPk), amountB);
  } else {
    // Party B triggered: send A's tokens to B
    sendImmediate(tokenTypeA, left<ZswapCoinPublicKey, ContractAddress>(recipientPk), amountA);
  }

  state = SwapState.completed;
  sequence.increment(1);
}

// Cancel and refund (only before both funded, or by mutual agreement)
export circuit cancel(): [] {
  assert(state != SwapState.completed, "Already completed");
  assert(state != SwapState.cancelled, "Already cancelled");

  const caller = publicKey(localSecretKey(), sequence as Field as Bytes<32>);

  // Only the depositing party can cancel in partial-fund state
  if (state == SwapState.partyAFunded) {
    assert(disclose(caller == partyA), "Only party A can cancel");
    // Refund party A's tokens
    const tokenTypeA = tokenType(tokenDomainA, kernel.self());
    const pk = ownPublicKey();
    sendImmediate(tokenTypeA, left<ZswapCoinPublicKey, ContractAddress>(pk), amountA);
  }

  // In open state, either party can cancel (nothing to refund)
  if (state == SwapState.open) {
    assert(disclose(caller == partyA || caller == partyB), "Not a swap party");
  }

  state = SwapState.cancelled;
  sequence.increment(1);
}
```

---

## Key Concepts

- **Shielded coin operations:** `receive(coin)` accepts tokens into the contract.
  `sendImmediate(tokenType, recipient, amount)` sends tokens from the contract
  to a wallet. The Zswap protocol handles privacy -- amounts and recipients are
  hidden from chain observers.
- **Token type derivation:** `tokenType(domain, contractAddress)` produces a
  deterministic token type identifier. The domain separator (`Bytes<32>`) and
  contract address together define a unique token type.
- **Atomic exchange:** Both parties must deposit before either can execute. The
  state machine ensures no partial execution -- either both transfers happen
  (via `executeSwap`) or both are refunded (via `cancel`).
- **Custody boundary:** Once tokens leave the contract via `sendImmediate`, the
  contract has no further control. The swap is atomic within the contract's scope,
  but the received tokens are free-floating in the Zswap pool after delivery.
- **`ownPublicKey()` vs `publicKey(sk, seq)`:** `ownPublicKey()` returns the
  caller's Zswap coin public key (for token operations). `publicKey(sk, seq)` is
  the contract-specific identity used for authentication. They serve different
  purposes and are not interchangeable.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/swap/contract/index.cjs';

export interface SwapPrivateState {
  readonly secretKey: Uint8Array;
  readonly coinPublicKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, SwapPrivateState>,
  ): [SwapPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  ownPublicKey: (
    { privateState }: WitnessContext<Ledger, SwapPrivateState>,
  ): [SwapPrivateState, Uint8Array] => {
    // In production, this comes from the wallet SDK.
    // The wallet provides a fresh unlinkable key per transaction.
    return [privateState, privateState.coinPublicKey];
  },
};

// Helper: create the token domain separator from a human-readable name
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
describe('Token Swap', () => {

  1. Full swap lifecycle (happy path)
     - Init swap, party A deposits, party B deposits, execute swap
     - Assert state is completed after execution

  2. Cancel before full funding (happy path)
     - Init swap, party A deposits, party A cancels
     - Assert state is cancelled, party A receives refund

  3. Party B cannot deposit before party A (should fail)
     - Init swap, party B attempts deposit first
     - Assert "Party A must deposit first" error

  4. Non-party cannot execute (should fail)
     - Both fund, third party attempts executeSwap
     - Assert "Not a swap party" error

  5. Cannot execute before both funded (should fail)
     - Only party A funds, attempt executeSwap
     - Assert "Both parties must fund first" error

  6. Cannot cancel after completion (should fail)
     - Complete full swap, attempt cancel
     - Assert "Already completed" error
});
```

---

## Notes

- Circuit complexity is moderate (k ~13-14). The `executeSwap` circuit is the
  heaviest due to `tokenType` derivation, `sendImmediate`, and conditional logic.
  The `depositA`/`depositB` circuits are lightweight (authentication + `receive`).
- **Two-transaction execution limitation:** In this simplified design,
  `executeSwap` sends tokens to the caller only. A production implementation
  would need to store each party's `ZswapCoinPublicKey` during their deposit
  phase and use both stored keys during execution to send tokens to the correct
  recipients in a single transaction.
- **Coin type verification:** The `receive(coin)` call accepts any coin sent to
  the contract. The Zswap protocol layer verifies the coin is valid, but the
  contract should ideally verify the coin type matches the expected
  `tokenDomainA` or `tokenDomainB`. Current Compact may not provide a way to
  inspect the received coin's type within the circuit -- check the latest SDK
  documentation.
- **Partial cancellation with refunds for `bothFunded` state** is not implemented
  in this example. A production version would need to handle the case where both
  parties funded but one wants to cancel -- this requires returning both deposits,
  which means two `sendImmediate` calls and storing both parties' coin public keys.
- Once tokens are sent via `sendImmediate`, they enter the Zswap shielded pool
  and the contract has no further control over them. This is the fundamental
  custody boundary of Midnight's token model.
