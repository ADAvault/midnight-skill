---
name: midnight-compact
description: >
  Write, test, and deploy Compact smart contracts for Midnight.
  Use when writing privacy-preserving contracts, ZK circuits, shielded tokens,
  or any on-chain Midnight code.
  Triggers on: Midnight, Compact, smart contract, zero-knowledge, ZK, shielded,
  circuit, witness, ledger, proof server, DUST, NIGHT, disclose, Zswap.
  Covers Compact language syntax, privacy model, circuit patterns, testing,
  security best practices, SDK integration, and wallet connectivity.
user-invocable: true
---

# Midnight Compact Smart Contract Development

You are an expert Midnight smart contract developer. Compact is a TypeScript-like
domain-specific language that compiles to zero-knowledge circuits, enabling
privacy-preserving computation on the Midnight blockchain.

## Core Principles

1. **Privacy by default** — all computation is private unless explicitly disclosed with `disclose()`.
2. **Dual-state model** — contracts have public ledger state (on-chain) and private state (off-chain, per-user).
3. **Circuits, not functions** — exported `circuit` declarations compile to ZK proofs. There are no `function` keywords.
4. **Witnesses bridge private data** — `witness` declarations in Compact are implemented in TypeScript, providing off-chain private inputs.
5. **Correctness is enforced** — all circuit computation is verified by ZK proofs. Only witness code runs unverified.
6. **Test everything** — use the Compact simulator first, then standalone network, then testnet.

## Decision Tree

When asked to write a smart contract:

1. **Specify the contract** — before writing code, define:
   - What state is public vs private?
   - What operations (circuits) does it expose?
   - What invariants must hold? (e.g., "total supply is conserved", "only owner can withdraw")
   - What are the trust boundaries? (what can witnesses lie about?)
   - What are the failure modes?
2. **Identify the privacy requirements**: what must be shielded vs public?
3. **Design ledger state** — `export ledger` for public, plain `ledger` for contract-private
4. **Design witnesses** — what private data do users provide off-chain?
5. **Write circuits** — exported for external calls, plain for internal
6. **Add `disclose()` calls** — required for any witness-derived value written to ledger or used in conditionals
7. **Write TypeScript witnesses** — implement witness bodies returning `[newPrivateState, returnValue]`
8. **Write tests** — progressive approach:
   - Unit test witnesses in isolation (correct types, immutable state, edge cases)
   - Simulator tests for every circuit (happy path + error conditions)
   - Invariant tests with `fast-check` (conservation laws, state machine validity)
   - Privacy leak tests (verify secrets don't appear in public state)
   - Adversarial tests (replay attacks, privilege escalation, malicious witnesses)
9. **Review for privacy leaks** — check the security patterns in [security.md](reference/security.md)
10. **Check circuit complexity** — verify k-values are acceptable (k <= 14 fast, k >= 17 needs optimization)
11. **Compile and deploy** — `compact compile`, test with proof server, deploy to preprod before mainnet

When asked to audit or review a contract:

1. **Follow the auditing methodology** in [auditing.md](reference/auditing.md)
2. **Phase 1:** Map ledger state, circuits, witnesses, and trust boundaries
3. **Phase 2:** Privacy leak scan — check all `disclose()` calls, witness interactions, and indirect leakage
4. **Phase 3:** Circuit complexity analysis — check `k` values, ledger operation costs
5. **Phase 4:** SDK integration review — version alignment, provider configuration
6. **Phase 5:** Test coverage assessment
7. **Report findings** with severity, privacy impact, and fix

## Compact Language — Essential Syntax

### Pragma (REQUIRED at top of every file)

```compact
pragma language_version >= 0.20;
```

### Imports

```compact
import CompactStandardLibrary;                              // ALWAYS required
import "./path/to/Module" prefix Module_;                   // OZ composition pattern
```

### Ledger Declarations

CRITICAL: Use individual statements. Block syntax `ledger { }` is DEPRECATED and causes parse errors.

```compact
export ledger counter: Counter;                             // public, readable by anyone
export ledger owner: Bytes<32>;                             // public
export sealed ledger name: Opaque<"string">;                // set once in constructor, immutable
ledger privateData: Field;                                  // NOT exported = private to contract
```

### Types

**Primitives:**

| Type | Description |
|------|-------------|
| `Field` | Finite field element (basic numeric type for ZK circuits) |
| `Boolean` | true/false |
| `Bytes<N>` | Fixed-size byte array (N=32 most common) |
| `Uint<N>` | Unsigned integer (N = 8, 16, 32, 64, 128). NOTE: Uint<256> NOT supported |
| `Uint<MIN..MAX>` | Bounded unsigned integer |
| `Opaque<"string">` | External type bridged from TypeScript |

**Collections:**

| Type | Description |
|------|-------------|
| `Counter` | Incrementable/decrementable counter (ledger-backed) |
| `Map<K, V>` | Key-value mapping (ledger-backed, expensive) |
| `Set<T>` | Unique value collection (ledger-backed, expensive) |
| `Vector<N, T>` | Fixed-size array (circuit-friendly) |
| `Maybe<T>` | Optional value — `some<T>(val)` / `none<T>()` |
| `Either<L, R>` | Union type — `left<L, R>(val)` / `right<L, R>(val)` |

**Midnight-specific:**

| Type | Description |
|------|-------------|
| `ZswapCoinPublicKey` | Wallet public key for coin operations |
| `ContractAddress` | On-chain contract address |
| `CoinInfo` | Coin descriptor for shielded tokens |

**Custom types:**
```compact
export enum GameState { waiting, playing, finished }
export struct PlayerConfig { name: Opaque<"string">, score: Uint<32> }
```
NOTE: Enum access uses dot notation: `GameState.waiting`, NOT `GameState::waiting`.

### Circuits

```compact
// Exported circuit — callable from TypeScript, generates ZK proof
export circuit increment(): [] {
  counter.increment(1);
}

// Circuit with parameters and return value
export circuit getBalance(addr: Bytes<32>): Uint<64> {
  return balances.lookup(addr);
}

// Internal circuit — not exported, callable only from other circuits
circuit validateOwner(caller: Bytes<32>): Boolean {
  return caller == owner;
}

// Pure circuit — no state access, no side effects
export pure circuit hash(data: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<1, Bytes<32>>>([data]);
}
```

CRITICAL: Return type is `[]` (empty tuple) for void circuits, NOT `Void`. The keyword `function` does NOT exist — use `pure circuit` for stateless computation.

### Witnesses

Declared in Compact (no body), implemented in TypeScript:

```compact
// Compact — declaration only, ends with semicolon
witness localSecretKey(): Bytes<32>;
witness getAmount(max: Uint<64>): Uint<64>;
```

```typescript
// TypeScript — implementation returns [newPrivateState, returnValue]
export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, PrivateState>):
    [PrivateState, Uint8Array] => [privateState, privateState.secretKey],
  getAmount: ({ privateState }: WitnessContext<Ledger, PrivateState>, max: bigint):
    [PrivateState, bigint] => [privateState, privateState.amount],
};
```

### Disclosure — The Core Privacy Primitive

```compact
// MUST wrap witness-derived values for ledger writes or conditionals
owner = disclose(publicKey(localSecretKey()));

// Assertions on private values
assert(disclose(caller == storedOwner), "Not authorized");

// Branching on private values
if (disclose(guess == secret)) { /* ... */ }
```

CRITICAL: From Compact 0.16+, `disclose()` is MANDATORY for all witness-derived values written to ledger state or used in boolean expressions affecting control flow. Omitting it causes compilation errors.

### Constructor

```compact
constructor() {
  counter.increment(1);
  owner = disclose(publicKey(localSecretKey()));
}
```

### Common Operations

```compact
// Counter
counter.increment(1);          counter.decrement(1);
counter.read();                counter.lessThan(100);

// Map
balances.insert(key, value);   balances.remove(key);
balances.lookup(key);          balances.member(key);

// Maybe
const opt = some<Field>(42);   const empty = none<Field>();
if (opt.is_some) { const val = opt.value; }

// Either (used for wallet-or-contract addresses)
const wallet = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
const contract = right<ZswapCoinPublicKey, ContractAddress>(kernel.self());

// Hashing
persistentHash<Vector<2, Bytes<32>>>([data1, data2]);    // SHA-256
transientHash<Vector<2, Bytes<32>>>([data1, data2]);     // Poseidon (10x cheaper in-circuit)

// Type casting
const bytes: Bytes<32> = myField as Bytes<32>;
const num: Uint<64> = myField as Uint<64>;

// Assertions
assert(condition, "Error message");
```

### Coin Operations (Shielded Tokens)

```compact
receive(coin);                                            // accept incoming coin
sendImmediate(coin, recipient, amount);                   // send coin out
mintShieldedToken(domainSeparator, amount, nonce, recipient); // create new token
tokenType(pad(32, "myToken"), kernel.self());             // get token type ID
```

## CLI Workflow

```bash
# Install / update Compact toolchain
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact self update                    # update dev tools FIRST
compact update 0.29.0                  # then update toolchain

# Scaffold, compile, test
npx create-mn-app my-project           # scaffold new project
compact compile src/contract.compact src/managed/contract  # compile
compact fmt src/contract.compact       # format (compiler 0.25.0+)
npm test                               # run tests (Vitest/Jest)
```

## Testing

Always test with the simulator before deploying. See [testing.md](reference/testing.md) for full details
including invariant testing, witness validation, adversarial testing, performance baselines,
and CI/CD integration.

```typescript
import { Contract } from "../managed/counter/contract/index.js";
import { createConstructorContext, createCircuitContext, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

// Create contract instance with witnesses
const contract = new Contract<PrivateState>(witnesses);

// Initialize — sampleContractAddress() is a FUNCTION, call it
const addr = sampleContractAddress();
const initial = contract.initialState(createConstructorContext(initialPrivateState, addr));

// Create first circuit context — requires 4 params: (address, zswapState, contractState, privateState)
const ctx = createCircuitContext(addr, initial.currentZswapLocalState, initial.currentContractState, initial.currentPrivateState);

// Execute circuit
const result = contract.impureCircuits.increment(ctx);

// Chain calls: pass result.context directly — it IS the continuation
const readResult = contract.impureCircuits.read(result.context);
console.log(readResult.result); // 1n
```

## DUST Fee Economics

DUST is Midnight's fee token — a high-precision micro-token generated continuously from tNight holdings. All transaction fees are paid in DUST.

### Generation Model

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `nightDustRatio` | 5,000,000,000 | Peak DUST generated per tNight per second |
| `timeToCapSeconds` | 604,815 | ~7 days to reach generation cap |
| `generationDecayRate` | 8,267 | Decay factor for generation curve |
| `dustGracePeriodSeconds` | 10,800 | 3-hour grace period before generation starts decaying |

DUST has no decimal places — values are in the smallest indivisible unit. The numbers are intentionally large to provide high precision for fee calculation.

### Deployment Costs (preprod, protocol v21000)

Measured from 13 contract deployments on preprod (March 2026):

| Complexity | Fee Range | Examples |
|------------|-----------|----------|
| Simple (3 circuits) | 331B–367B DUST | Counter, RPS, Upgrade-V1, Token Minting |
| Medium (5 circuits) | 479B–564B DUST | Credential, DID, Prescription, Market, Staking, Crowdfunding |
| Complex (6-7 circuits) | 629B–721B DUST | NFT, DAO, Lending, Upgrade-V2 |

- Fees are **deterministic** — `paidFees` matches `estimatedFees` exactly
- Deploy time: 16–22 seconds (includes ZK proof generation + on-chain confirmation)
- With 2,000 tNight, DUST generation outpaces deployment fees — all 13 contracts deployed with DUST to spare

### Practical Guidance

- DUST accrues passively from tNight — no explicit conversion needed
- The `DustWallet` SDK handles fee calculation and payment automatically
- Set `additionalFeeOverhead` in `DustWallet` config for fee buffer (default examples use 300T DUST)
- On preprod, request tNight from the [Midnight faucet](https://faucet.preprod.midnight.network/) — 1,000 tNight per request is sufficient for dozens of deployments

## Reference Material

For detailed information, consult:

- [Language reference](reference/language.md) — types, syntax, modules, casting, operators
- [Privacy model](reference/privacy-model.md) — shielded vs unshielded, disclose(), witness pattern, ZK fundamentals
- [Security patterns](reference/security.md) — ZK-specific attack vectors, privacy leaks, common mistakes
- [Testing guide](reference/testing.md) — simulator, invariant testing, witness validation, adversarial testing, CI/CD, performance baselines
- [Design patterns](reference/patterns.md) — circuit optimization, off-chain computation, module composition
- [Standard library](reference/stdlib.md) — CompactStandardLibrary built-in functions and types
- [Gotchas](reference/gotchas.md) — 52 compiler bugs, SDK pitfalls, design traps (Discord + real compilation)
- [Off-chain integration](reference/offchain.md) — TypeScript SDK, wallet, deployment, contract monitoring, error handling
- [Auditing methodology](reference/auditing.md) — ZK contract audit process, privacy leak detection

## Examples

29 examples (27 validated + 2 network-only). 151 circuits compiled, 182/182 tests passing, 30 contracts deployed on preprod:

**Core Patterns:**
- [Counter](examples/counter.md) — 3 circuits, 5/5 tests. Simplest contract, increment/decrement with ledger state.
- [Bulletin Board](examples/bulletin-board.md) — 3 circuits, 8/8 tests. Witness authentication, ownership, CRUD.
- [Fungible Token](examples/fungible-token.md) — 7 circuits, 6/6 tests. ERC20-equivalent with OZ module composition.
- [NFT](examples/nft.md) — 7 circuits, 6/6 tests. Commitment-based ownership, mint/burn/transfer/approve.
- [Rock-Paper-Scissors](examples/rock-paper-scissors.md) — 3 circuits, 6/6 tests. Minimal commit-reveal 2-player game.

**Privacy Patterns:**
- [Shielded Voting](examples/shielded-voting.md) — 6 circuits, 9/9 tests. Commit-reveal private ballot.
- [Sealed-Bid Auction](examples/sealed-bid-auction.md) — 6 circuits, 8/8 tests. Commit-reveal with ZK verification.
- [Identity Proof](examples/identity-proof.md) — 4 circuits, 6/6 tests. Selective disclosure, parameterized witnesses.
- [Credential Registry](examples/credential-registry.md) — 5 circuits, 6/6 tests. Nullifier-based double-use prevention.
- [Prescription](examples/prescription.md) — 5 circuits, 6/6 tests. Batch registration with Vector, nullifier for double-fill.
- [Privacy Mixer](examples/privacy-mixer.md) — 3 circuits, 7/7 tests. Commitment deposits, nullifier withdrawals.

**DeFi & Escrow:**
- [Escrow](examples/escrow.md) — 5 circuits, 8/8 tests. Two-party conditional exchange with deadline.
- [Time Lock](examples/time-lock.md) — 3 circuits, 7/7 tests. LOK/RELEASE pattern for timed asset release.
- [Multi-Sig](examples/multi-sig.md) — 6 circuits, 6/6 tests. M-of-N authorization, composite keys.
- [Staking](examples/staking.md) — 5 circuits, 6/6 tests. Lock period, ZK-friendly reward calculation.
- [Crowdfunding](examples/crowdfunding.md) — 5 circuits, 6/6 tests. Anonymous backing with ZK refund proofs.
- [Lending](examples/lending.md) — 6 circuits, 6/6 tests. Collateral, health factor, liquidation.
- [Prediction Market](examples/prediction-market.md) — 5 circuits, 7/7 tests. Commitment-based bets with ZK payout.
- [Vesting](examples/vesting.md) — 4 circuits, 8/8 tests. Time-based tranche release schedule.
- [Revenue Sharing](examples/revenue-sharing.md) — 3 circuits, 7/7 tests. Private share allocations, ZK withdrawal.
- [Lottery](examples/lottery.md) — 4 circuits, 8/8 tests. Commit-reveal multi-party randomness.

**Advanced:**
- [Oracle Feed](examples/oracle-feed.md) — 5 circuits, 6/6 tests. External data, freshness checks.
- [Token Swap](examples/token-swap.md) — 6 circuits. Atomic swap with `receiveShielded`/`sendImmediateShielded`, preprod deployed.
- [Access Control](examples/access-control.md) — 8 circuits, 6/6 tests. Role hierarchy, internal guards.
- [DID Registry](examples/did-registry.md) — 5 circuits, 6/6 tests. Document lifecycle (create/update/deactivate).
- [Micro-DAO](examples/micro-dao.md) — 7 circuits, 7/7 tests. Token-gated voting, treasury, governance.
- [Contract Upgradability](examples/contract-upgradability.md) — V1: 3 + V2: 7 circuits, 8/8 tests. Migration pattern.
- [Token Minting](examples/token-minting.md) — 3 circuits. Zswap coin creation (`mintShieldedToken`), preprod deployed.
- [Supply Chain](examples/supply-chain.md) — 4 circuits, 7/7 tests. Selective disclosure provenance tracking.

## Production References

Open-source Midnight contracts and tools for studying real implementations:

**OpenZeppelin Compact Contracts (Canonical Reference):**
- [OpenZeppelin/compact-contracts](https://github.com/OpenZeppelin/compact-contracts) — Ownable, Pausable, AccessControl, FungibleToken, Capped, Nonces. Module composition pattern. Production-grade.

**Brick Towers (Most Active Community Builder):**
- [midnight-seabattle](https://github.com/bricktowers/midnight-seabattle) — Full-stack dApp (game). Multi-user, shielded state, E2E tests. Best reference for real dApp architecture.
- [midnight-local-network](https://github.com/bricktowers/midnight-local-network) — Docker Compose for local development (node + indexer + proof server). Community standard.
- [midnight-proof-server](https://github.com/bricktowers/midnight-proof-server) — Pre-baked proof server with circuit parameters. Eliminates download timeouts.
- [midnight-rwa](https://github.com/bricktowers/midnight-rwa) — Real-world asset tokenization.

**Official Midnight Examples:**
- [example-counter](https://github.com/midnightntwrk/example-counter) — Official counter (simplest contract). Template for `create-mn-app`.
- [example-bboard](https://github.com/midnightntwrk/example-bboard) — Official bulletin board. Canonical witness + auth pattern.
- [midnight-awesome-dapps](https://github.com/midnightntwrk/midnight-awesome-dapps) — Curated list of community dApps.

**Community Projects:**
- [midnight-kitties](https://github.com/riusricardo/midnight-kitties) — CryptoKitties-style NFT dApp.
- [compact-by-example](https://github.com/Olanetsoft/compact-by-example) — Learn Compact through practical examples.
- [pulse-finance/midnight-dex-contract](https://github.com/pulse-finance/midnight-dex-contract) — AMM DEX in Compact.

**Developer Tools:**
- [midnight-mcp](https://www.npmjs.com/package/midnight-mcp) — MCP server for Midnight (Idris, Midnight team).
- [compact-vscode](https://github.com/foxytanuki/compact-vscode) — VSCode syntax highlighting.
- [compact.vim](https://github.com/1NickPappas/compact.vim) — Vim/Neovim tree-sitter plugin.
- [Midnight docs (open source)](https://github.com/midnightntwrk/midnight-docs) — Official documentation source.

**Key Community Experts:**
- **Sergey | Brick Towers** — de facto community expert. 836+ Discord messages. Maintains midnight-seabattle, midnight-local-network, midnight-proof-server. Most practical SDK knowledge.
- **newton_meter (Kevin Millikin)** — Compact language designer (Midnight team). Most authoritative on language semantics.
- **gilescope** — Cryptography details, proving system (Midnight team).
- **Facu | Midnames** — Active builder, circuit optimization insights.
