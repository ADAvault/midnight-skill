# Fungible Token

An ERC20-equivalent unshielded fungible token demonstrating OpenZeppelin module
composition, access control, and the standard token interface on Midnight. This
contract imports and composes OZ's FungibleToken, Ownable, and Pausable modules
to produce a mint-capable, pausable token with familiar transfer/approve
semantics. Based on [OpenZeppelin/compact-contracts](https://github.com/OpenZeppelin/compact-contracts).

Compiler-validated: this contract compiles and all 6 tests pass against
Compact 0.29.0 within the OZ compact-contracts workspace.

---

## Contract

```compact
pragma language_version >= 0.21.0;

import CompactStandardLibrary;

import "./FungibleToken" prefix FT_;
import "./Ownable" prefix Ownable_;
import "./Pausable" prefix Pausable_;

export { ZswapCoinPublicKey, ContractAddress, Either };

constructor(
  initOwner: Either<ZswapCoinPublicKey, ContractAddress>,
  name: Opaque<"string">,
  symbol: Opaque<"string">,
  decimals: Uint<8>,
  initialSupply: Uint<128>
) {
  Ownable_initialize(initOwner);
  FT_initialize(name, symbol, decimals);
  FT__mint(initOwner, initialSupply);
}

export circuit transfer(to: Either<ZswapCoinPublicKey, ContractAddress>, value: Uint<128>): Boolean {
  Pausable_assertNotPaused();
  return FT_transfer(to, value);
}

export circuit approve(spender: Either<ZswapCoinPublicKey, ContractAddress>, value: Uint<128>): Boolean {
  Pausable_assertNotPaused();
  return FT_approve(spender, value);
}

export circuit mint(to: Either<ZswapCoinPublicKey, ContractAddress>, amount: Uint<128>): [] {
  Ownable_assertOnlyOwner();
  FT__mint(to, amount);
}

export circuit pause(): [] {
  Ownable_assertOnlyOwner();
  Pausable__pause();
}

export circuit unpause(): [] {
  Ownable_assertOnlyOwner();
  Pausable__unpause();
}

export circuit balanceOf(account: Either<ZswapCoinPublicKey, ContractAddress>): Uint<128> {
  return FT_balanceOf(account);
}

export circuit totalSupply(): Uint<128> {
  return FT_totalSupply();
}
```

---

## Key Concepts

### OZ Module Composition

Module composition is Midnight's answer to Solidity inheritance. Instead of
`is ERC20, Ownable`, you import modules with a `prefix` and call their
circuits from your own exported circuits.

- **Import with `prefix`** -- all symbols from the module get namespaced
  (e.g., `FT_transfer`, `Ownable_assertOnlyOwner`)
- **Compose by delegation** -- your exported circuits call prefixed circuits
  from the imported modules, adding cross-cutting logic (pause checks,
  access control) before delegating
- **No ledger re-export needed** -- modules declare their own `export ledger`
  fields internally. When imported with a prefix, the compiler handles
  namespacing automatically. You do NOT need to re-declare module ledger
  fields in the consuming contract
- **Type re-export** -- use `export { ZswapCoinPublicKey, ContractAddress, Either }`
  to make the standard types available to callers
- **Double underscore for internal** -- `FT__mint` calls the module's
  internal `_mint` circuit (the prefix `FT_` plus the leading underscore
  yields `FT__mint`). Similarly, `Pausable__pause` calls `_pause`
- **`assertOnlyOwner` vs `assertOwner`** -- the actual OZ Ownable circuit
  is `assertOnlyOwner()` (not `assertOwner`). Check the module source for
  exact circuit names

### Unshielded vs Shielded Tokens

This example is **unshielded** -- balances are stored in a public
`Map<..., Uint<128>>` visible on-chain to everyone.

Shielded tokens (using `mintToken`/`receive`/`send`) exist in the OZ repo
but are **experimental and NOT recommended for production**. OZ explicitly
archives ShieldedToken with "DO NOT USE IN PRODUCTION". The reason: once
shielded tokens leave the contract, contract-level rules (pause, allowance
caps, blacklists) no longer apply. The Zswap layer handles them directly,
bypassing your circuit logic.

For production token contracts, use the unshielded pattern shown here.

### Either\<ZswapCoinPublicKey, ContractAddress\>

This is the universal "account" type on Midnight -- it holds either a wallet
public key or a contract address.

- `left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey())` -- the calling
  wallet
- `right<ZswapCoinPublicKey, ContractAddress>(kernel.self())` -- the current
  contract's own address

Used throughout OZ modules for any parameter that accepts "an address".

In TypeScript, `Either` values are plain objects:
```typescript
// Wallet (left)
{ is_left: true, left: { bytes: encodedPublicKey }, right: encodedEmptyAddr }
// Contract (right)
{ is_left: false, left: encodedEmptyPK, right: { bytes: encodedContractAddr } }
```

Use `encodeCoinPublicKey()` from `@midnight-ntwrk/compact-runtime` to encode
public keys for test addresses.

### Key Differences from ERC20

- **Uint\<128\> max** -- Midnight supports Uint\<8\>, Uint\<16\>, Uint\<32\>,
  Uint\<64\>, and Uint\<128\>. There is no Uint\<256\>.
- **No events** -- Midnight does not have an event/log system. Off-chain
  indexers watch ledger state changes directly.
- **No contract-to-contract calls** -- `transferFrom` patterns are limited
  because contracts cannot call circuits on other contracts in the same
  transaction.
- **Unlinkable callers** -- `ownPublicKey()` changes per transaction, so the
  contract must use stable account identifiers stored in ledger state.
- **Constructor args are separate** -- `initialState(ctx, arg1, arg2, ...)`
  passes constructor arguments after the context, not inside it.

---

## TypeScript Witnesses

```typescript
// No witnesses needed -- this contract has no private inputs.
// All token operations use public ledger state only.
export const witnesses = {};
```

---

## Test (Simulator)

Compiler-validated tests (6/6 passing). Requires the OZ compact-contracts
workspace for module dependencies and test utilities.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract } from "../artifacts/MockOwnablePausableFT/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import * as utils from "#test-utils/address.js";

const witnesses = {};

// Create properly encoded Either<ZswapCoinPublicKey, ContractAddress> addresses
const [, ownerEither] = utils.generateEitherPubKeyPair("OWNER");
const [, recipientEither] = utils.generateEitherPubKeyPair("RECIPIENT");

const INITIAL_SUPPLY = 1_000_000n;
const DECIMALS = 18n;

describe("OwnablePausableFungibleToken", () => {
  let contract;
  let ctx;

  beforeEach(() => {
    contract = new Contract(witnesses);
    const addr = sampleContractAddress();

    // Pass owner's coin public key for ownPublicKey() identity
    const initial = contract.initialState(
      createConstructorContext({}, ownerEither.left),
      ownerEither,      // initOwner
      "TestToken",      // name
      "TT",             // symbol
      DECIMALS,         // decimals
      INITIAL_SUPPLY,   // initialSupply
    );

    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should deploy with initial supply", () => {
    const result = contract.impureCircuits.totalSupply(ctx);
    expect(result.result).toBe(INITIAL_SUPPLY);
  });

  it("should show owner balance equals initial supply", () => {
    const result = contract.impureCircuits.balanceOf(ctx, ownerEither);
    expect(result.result).toBe(INITIAL_SUPPLY);
  });

  it("should transfer tokens", () => {
    const r1 = contract.impureCircuits.transfer(ctx, recipientEither, 1000n);
    expect(r1.result).toBe(true);
    // Check recipient balance via context continuation
    const r2 = contract.impureCircuits.balanceOf(r1.context, recipientEither);
    expect(r2.result).toBe(1000n);
  });

  it("should allow owner to mint", () => {
    const r1 = contract.impureCircuits.mint(ctx, recipientEither, 500n);
    const r2 = contract.impureCircuits.totalSupply(r1.context);
    expect(r2.result).toBe(INITIAL_SUPPLY + 500n);
  });

  it("should allow owner to pause and block transfers", () => {
    const r1 = contract.impureCircuits.pause(ctx);
    expect(() => {
      contract.impureCircuits.transfer(r1.context, recipientEither, 100n);
    }).toThrow("Pausable: paused");
  });

  it("should allow owner to unpause and resume transfers", () => {
    const r1 = contract.impureCircuits.pause(ctx);
    const r2 = contract.impureCircuits.unpause(r1.context);
    const r3 = contract.impureCircuits.transfer(r2.context, recipientEither, 100n);
    expect(r3.result).toBe(true);
  });
});
```

---

## CLI

```bash
# This contract requires OZ modules as dependencies.
# Clone the OZ repo and place your contract alongside the modules:
git clone https://github.com/OpenZeppelin/compact-contracts.git
cd compact-contracts

# Compile using the OZ workspace tooling:
yarn install && yarn workspace @openzeppelin-compact/compact build
yarn workspace @openzeppelin/compact-contracts compact

# Or compile standalone (adjust import paths):
compact compile src/token/test/mocks/MyToken.compact artifacts/MyToken
```

---

## Notes

- **No ledger re-export needed.** The `import "..." prefix` mechanism
  automatically brings module ledger state into the contract. The compiled
  `Ledger` type will be `{}` at the top level -- access balances and supply
  through circuits (`balanceOf`, `totalSupply`), not direct ledger reads
- **Constructor args follow the context.** `initialState(ctx, initOwner, name,
  symbol, decimals, initialSupply)` -- constructor parameters are passed as
  separate arguments after the `ConstructorContext`, not inside it
- **`createConstructorContext({}, coinPK)` takes a CoinPublicKey.** The second
  parameter sets the caller identity for `ownPublicKey()`. For Ownable
  contracts, this must match the `initOwner` value
- **`Either` types need proper encoding.** Raw `Uint8Array` won't work --
  use `encodeCoinPublicKey()` and `encodeContractAddress()` from
  `@midnight-ntwrk/compact-runtime` or the OZ test utilities
- **`Pausable__pause()` not `Pausable_pause()`.** The OZ Pausable module
  exposes `_pause()` and `_unpause()` (underscored = internal). With the
  `Pausable_` prefix, this becomes `Pausable__pause()` (double underscore).
  Similarly, `Ownable_assertOnlyOwner()` not `Ownable_assertOwner()`
- **601 OZ tests pass.** The full OZ compact-contracts test suite validates
  against Compact 0.29.0 -- FungibleToken, NonFungibleToken, MultiToken,
  Ownable, AccessControl, Pausable, Initializable, Utils
- Uint\<128\> is the practical maximum for token amounts -- Uint\<256\> is NOT
  supported in Compact
- Map operations are expensive in-circuit -- each lookup or update costs circuit
  constraints
- No `transferFrom` equivalent exists because Midnight lacks contract-to-contract
  calls within a single transaction -- the approve/allowance pattern is present
  in OZ but limited in practice
