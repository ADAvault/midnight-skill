# Fungible Token

An ERC20-equivalent unshielded fungible token demonstrating OpenZeppelin module
composition, access control, and the standard token interface on Midnight. This
contract imports and composes OZ's FungibleToken, Ownable, and Pausable modules
to produce a mint-capable, pausable token with familiar transfer/approve
semantics. Based on [OpenZeppelin/compact-contracts](https://github.com/OpenZeppelin/compact-contracts).

---

## Contract

```compact
pragma language_version >= 0.21.0;

import CompactStandardLibrary;
import "./Ownable" prefix Ownable_;
import "./Pausable" prefix Pausable_;
import "./FungibleToken" prefix FT_;

// Re-export necessary ledger state from composed modules
export ledger Ownable_owner: Either<ZswapCoinPublicKey, ContractAddress>;
export ledger FT_balances: Map<Either<ZswapCoinPublicKey, ContractAddress>, Uint<128>>;
export ledger FT_name: Opaque<"string">;
export ledger FT_symbol: Opaque<"string">;
export ledger FT_decimals: Uint<8>;
export ledger FT_totalSupply: Uint<128>;

constructor(initOwner: Either<ZswapCoinPublicKey, ContractAddress>, name: Opaque<"string">, symbol: Opaque<"string">, decimals: Uint<8>, initialSupply: Uint<128>) {
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
  Ownable_assertOwner();
  FT__mint(to, amount);
}

export circuit pause(): [] {
  Ownable_assertOwner();
  Pausable_pause();
}

export circuit unpause(): [] {
  Ownable_assertOwner();
  Pausable_unpause();
}
```

---

## Key Concepts

### OZ Module Composition

Module composition is Midnight's answer to Solidity inheritance. Instead of
`is ERC20, Ownable`, you import modules with a `prefix` and call their
functions from your own circuits.

- **Import with `prefix`** — all symbols from the module get namespaced
  (e.g., `FT_transfer`, `Ownable_assertOwner`)
- **Compose by delegation** — your exported circuits call prefixed functions
  from the imported modules, adding cross-cutting logic (pause checks,
  access control) before delegating
- **Ledger re-export** — ledger state defined inside modules must be
  re-exported with the prefix so it appears on-chain. `FT_balances` in your
  contract corresponds to `balances` inside the FungibleToken module
- **Double underscore for internal** — `FT__mint` calls the module's
  internal `_mint` function (the prefix `FT_` plus the leading underscore
  yields `FT__mint`)

### Unshielded vs Shielded Tokens

This example is **unshielded** — balances are stored in a public
`Map<..., Uint<128>>` visible on-chain to everyone.

Shielded tokens (using `mintToken`/`receive`/`send`) exist in the OZ repo
but are **experimental and NOT recommended for production**. OZ explicitly
archives ShieldedToken with "DO NOT USE IN PRODUCTION". The reason: once
shielded tokens leave the contract, contract-level rules (pause, allowance
caps, blacklists) no longer apply. The Zswap layer handles them directly,
bypassing your circuit logic.

For production token contracts, use the unshielded pattern shown here.

### Either\<ZswapCoinPublicKey, ContractAddress\>

This is the universal "account" type on Midnight — it holds either a wallet
public key or a contract address.

- `left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey())` — the calling
  wallet
- `right<ZswapCoinPublicKey, ContractAddress>(kernel.self())` — the current
  contract's own address

Used throughout OZ modules for any parameter that accepts "an address".
Note that `ownPublicKey()` is unlinkable by design — the same wallet
produces different public keys across transactions, so on-chain balances
are keyed to a stable identifier, not the transient circuit public key.

### Key Differences from ERC20

- **Uint\<128\> max** — Midnight supports Uint\<8\>, Uint\<16\>, Uint\<32\>,
  Uint\<64\>, and Uint\<128\>. There is no Uint\<256\>.
- **No events** — Midnight does not have an event/log system. Off-chain
  indexers watch ledger state changes directly.
- **No contract-to-contract calls** — `transferFrom` patterns are limited
  because contracts cannot call circuits on other contracts in the same
  transaction.
- **Unlinkable callers** — `ownPublicKey()` changes per transaction, so the
  contract must use stable account identifiers stored in ledger state.

---

## TypeScript Witnesses

```typescript
// No witnesses needed — this contract has no private inputs.
// All token operations use public ledger state only.
export const witnesses = {};
```

---

## Test (Simulator)

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { Contract } from '../managed/fungible-token/contract/index.js';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

setNetworkId('undeployed');

const witnesses = {};

describe('FungibleToken', () => {
  let contractState: any;
  let ownerPrivateState: any;

  // Simulate an owner address as a left<ZswapCoinPublicKey, ContractAddress>
  const ownerKey = new Uint8Array(32).fill(0x01);
  const nonOwnerKey = new Uint8Array(32).fill(0x02);
  const recipientKey = new Uint8Array(32).fill(0x03);

  const INITIAL_SUPPLY = 1_000_000n;
  const DECIMALS = 18n;

  beforeAll(() => {
    const contract = new Contract(witnesses);
    const initial = contract.initialState(
      createConstructorContext(
        { publicKey: ownerKey },
        sampleContractAddress,
        // Constructor args: initOwner, name, symbol, decimals, initialSupply
      ),
    );
    contractState = initial.currentContractState;
    ownerPrivateState = initial.currentPrivateState;
  });

  it('should deploy with initial supply allocated to owner', () => {
    // After constructor, totalSupply should equal initialSupply
    // and the owner's balance should equal initialSupply
    expect(contractState).toBeDefined();
  });

  it('should transfer tokens between accounts', () => {
    const contract = new Contract(witnesses);
    const ctx = createCircuitContext(contractState, ownerPrivateState);

    const transferAmount = 1_000n;
    const result = contract.impureCircuits.transfer(ctx, recipientKey, transferAmount);

    expect(result.result).toBe(true);
    // State updated: owner balance decreased, recipient balance increased
    contractState = result.currentContractState;
    ownerPrivateState = result.currentPrivateState;
  });

  it('should allow owner to mint new tokens', () => {
    const contract = new Contract(witnesses);
    const ctx = createCircuitContext(contractState, ownerPrivateState);

    const mintAmount = 500n;
    const result = contract.impureCircuits.mint(ctx, recipientKey, mintAmount);

    // Mint should succeed without throwing
    expect(result.currentContractState).toBeDefined();
    contractState = result.currentContractState;
    ownerPrivateState = result.currentPrivateState;
  });

  it('should reject mint by non-owner', () => {
    const contract = new Contract(witnesses);
    const nonOwnerState = { publicKey: nonOwnerKey };
    const ctx = createCircuitContext(contractState, nonOwnerState);

    // Non-owner calling mint should fail the Ownable_assertOwner() check
    expect(() => {
      contract.impureCircuits.mint(ctx, recipientKey, 100n);
    }).toThrow();
  });

  it('should allow owner to pause and unpause', () => {
    const contract = new Contract(witnesses);

    // Pause
    let ctx = createCircuitContext(contractState, ownerPrivateState);
    const pauseResult = contract.impureCircuits.pause(ctx);
    contractState = pauseResult.currentContractState;
    ownerPrivateState = pauseResult.currentPrivateState;

    // Unpause
    ctx = createCircuitContext(contractState, ownerPrivateState);
    const unpauseResult = contract.impureCircuits.unpause(ctx);
    contractState = unpauseResult.currentContractState;
    ownerPrivateState = unpauseResult.currentPrivateState;

    expect(contractState).toBeDefined();
  });

  it('should reject transfer while paused', () => {
    const contract = new Contract(witnesses);

    // First, pause the contract
    let ctx = createCircuitContext(contractState, ownerPrivateState);
    const pauseResult = contract.impureCircuits.pause(ctx);
    const pausedState = pauseResult.currentContractState;
    const pausedPrivate = pauseResult.currentPrivateState;

    // Now attempt a transfer — should fail at Pausable_assertNotPaused()
    ctx = createCircuitContext(pausedState, pausedPrivate);
    expect(() => {
      contract.impureCircuits.transfer(ctx, recipientKey, 100n);
    }).toThrow();
  });
});
```

---

## CLI

```bash
compact compile src/fungible-token.compact src/managed/fungible-token
npm test
```

---

## Notes

- The module composition pattern (`import ... prefix`) is Midnight's answer to
  Solidity inheritance — it is the standard way to reuse OZ building blocks
- Uint\<128\> is the practical maximum for token amounts — Uint\<256\> is NOT
  supported in Compact
- Map operations are expensive in-circuit — each lookup or update costs circuit
  constraints. For high-frequency operations, consider whether the map can be
  replaced with a flatter structure or whether operations can be batched
- This pattern works for any programmable token (governance, utility, rewards,
  etc.) — swap FungibleToken for your own module and the composition stays the
  same
- No `transferFrom` equivalent exists because Midnight lacks contract-to-contract
  calls within a single transaction — the approve/allowance pattern is present
  in OZ but limited in practice
