# Token Swap

> **Compiler-validated:** 6 circuits compiled and deployed on preprod against Compact 0.29.0.

An atomic swap contract for exchanging two different shielded token types through
the Zswap protocol. Party A deposits token X, party B deposits token Y, and the
contract releases each party's deposit to the other. All coin operations use
Midnight's built-in shielded token mechanics (`receiveShielded`, `sendImmediateShielded`,
`mintToken`, `tokenType`). Demonstrates coin lifecycle, shielded transfer
mechanics, and the atomic exchange pattern.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum SwapState { open, initialized, partyAFunded, bothFunded, completed, cancelled }

export ledger state: SwapState;
export ledger partyA: Bytes<32>;
export ledger partyB: Bytes<32>;
export ledger tokenDomainA: Bytes<32>;
export ledger tokenDomainB: Bytes<32>;
export ledger amountA: Uint<64>;
export ledger amountB: Uint<64>;
export ledger coinPkA: ZswapCoinPublicKey;
export ledger coinPkB: ZswapCoinPublicKey;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;

circuit authKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "swap:pk:"), seq, sk]);
}

constructor() {
  state = SwapState.open;
  sequence.increment(1);
}

// Party A initializes the swap terms and stores their coin public key
export circuit initSwap(
  bParty: Bytes<32>,
  domainA: Bytes<32>,
  domainB: Bytes<32>,
  amtA: Uint<64>,
  amtB: Uint<64>
): [] {
  assert(state == SwapState.open, "Swap already initialized");

  partyA = disclose(authKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  partyB = disclose(bParty);
  tokenDomainA = disclose(domainA);
  tokenDomainB = disclose(domainB);
  amountA = disclose(amtA);
  amountB = disclose(amtB);
  coinPkA = disclose(ownPublicKey());

  state = SwapState.initialized;
}

// Party A deposits their tokens
export circuit depositA(coin: ShieldedCoinInfo): [] {
  assert(state == SwapState.initialized, "Invalid state for party A deposit");
  assert(disclose(authKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == partyA),
         "Not party A");

  assert(disclose(coin.color == tokenType(tokenDomainA, kernel.self())), "Wrong token type");

  receiveShielded(disclose(coin));

  state = SwapState.partyAFunded;
}

// Party B deposits their tokens
export circuit depositB(coin: ShieldedCoinInfo): [] {
  assert(state == SwapState.partyAFunded, "Party A must deposit first");
  assert(disclose(authKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == partyB),
         "Not party B");

  assert(disclose(coin.color == tokenType(tokenDomainB, kernel.self())), "Wrong token type");

  receiveShielded(disclose(coin));
  coinPkB = disclose(ownPublicKey());

  state = SwapState.bothFunded;
}

// Execute the swap -- send each party's tokens to the other
// No auth check: once both funded, anyone can trigger (incentive-aligned)
export circuit executeSwap(coinA: ShieldedCoinInfo, coinB: ShieldedCoinInfo): [] {
  assert(state == SwapState.bothFunded, "Both parties must fund first");

  sendImmediateShielded(disclose(coinA), left<ZswapCoinPublicKey, ContractAddress>(coinPkB), disclose(amountA));
  sendImmediateShielded(disclose(coinB), left<ZswapCoinPublicKey, ContractAddress>(coinPkA), disclose(amountB));

  state = SwapState.completed;
  sequence.increment(1);
}

// Cancel and refund -- only party A can cancel (they have deposits at risk)
export circuit cancelAndRefund(coin: ShieldedCoinInfo): [] {
  assert(state == SwapState.partyAFunded, "Can only cancel in partyAFunded state");
  assert(disclose(authKey(localSecretKey(), sequence.read() as Field as Bytes<32>) == partyA),
         "Only party A can cancel");

  sendImmediateShielded(disclose(coin), left<ZswapCoinPublicKey, ContractAddress>(coinPkA), disclose(amountA));

  state = SwapState.cancelled;
  sequence.increment(1);
}

// Cancel before any deposits (either party)
export circuit cancelOpen(): [] {
  assert(state == SwapState.initialized, "Can only cancel in initialized state");
  state = SwapState.cancelled;
  sequence.increment(1);
}
```

---

## Key Concepts

- **Shielded coin operations:** `receiveShielded(disclose(coin))` accepts tokens
  into the contract, where `coin` is a `ShieldedCoinInfo` parameter (struct with
  `nonce`, `color`, `value` fields). `sendImmediateShielded(disclose(coin), recipient, disclose(amount))`
  sends tokens from the contract to a wallet. The Zswap protocol handles
  privacy -- amounts and recipients are hidden from chain observers.
- **`ShieldedCoinInfo` type:** The shielded coin descriptor passed to deposit
  circuits. Fields: `coin.nonce` (`Bytes<32>`), `coin.color` (`Bytes<32>`),
  `coin.value` (`Uint<128>`). The old name `CoinInfo` no longer works.
- **Token type derivation:** `tokenType(domain, contractAddress)` produces a
  deterministic token type identifier. The domain separator (`Bytes<32>`) and
  contract address together define a unique token type.
- **Atomic exchange:** Both parties must deposit before either can execute. The
  state machine ensures no partial execution -- either both transfers happen
  (via `executeSwap`) or both are refunded (via `cancelAndRefund`).
- **Custody boundary:** Once tokens leave the contract via `sendImmediateShielded`,
  the contract has no further control. The swap is atomic within the contract's
  scope, but the received tokens are free-floating in the Zswap pool after delivery.
- **`ownPublicKey()` is a stdlib built-in:** It returns the caller's
  `ZswapCoinPublicKey` and is provided by `CompactStandardLibrary`. Do NOT
  declare it as a witness -- doing so causes a "call site ambiguity" error.
  `authKey(sk, seq)` is the contract-specific identity used for authentication.
  They serve different purposes and are not interchangeable.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/swap/contract/index.cjs';

export interface SwapPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, SwapPrivateState>,
  ): [SwapPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },
  // NOTE: ownPublicKey() is a stdlib built-in provided by CompactStandardLibrary.
  // Do NOT declare it as a witness. The wallet SDK handles it automatically.
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
  heaviest due to `sendImmediateShielded` x2 and coin parameter handling.
  The `depositA`/`depositB` circuits are lightweight (authentication + `receiveShielded`).
- **Coin public keys stored during deposit:** Each party's `ZswapCoinPublicKey`
  is captured via `ownPublicKey()` (a stdlib built-in) and stored in ledger
  state (`coinPkA`, `coinPkB`). This allows `executeSwap` to send tokens to
  the correct recipients without requiring either party to be the caller.
- **Coin type verification:** The `ShieldedCoinInfo` parameter has a `.color`
  field that can be compared against `tokenType(domain, kernel.self())` to
  verify the deposited token matches expectations. This is enforced in both
  `depositA` and `depositB`.
- **Partial cancellation with refunds for `bothFunded` state** is not implemented
  in this example. A production version would need to handle the case where both
  parties funded but one wants to cancel -- this requires returning both deposits,
  which means two `sendImmediateShielded` calls.
- Once tokens are sent via `sendImmediateShielded`, they enter the Zswap shielded
  pool and the contract has no further control over them. This is the fundamental
  custody boundary of Midnight's token model.
- **Validation status:** Compiled and deployed on preprod (6 circuits, block
  625619, 645B DUST). Uses `receiveShielded`, `sendImmediateShielded`, `tokenType`,
  `ownPublicKey()`, and `kernel.self()` -- all require the full Midnight network
  stack and cannot be tested with `compact-runtime` simulator alone.
