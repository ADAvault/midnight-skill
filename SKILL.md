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
compact update 0.31.1                  # then update toolchain — see the 0.31.0 warning below

# Scaffold, compile, test
npx create-mn-app my-project           # scaffold new project
compact compile src/contract.compact src/managed/contract  # compile
compact fmt src/contract.compact       # format (compiler 0.25.0+)
npm test                               # run tests (Vitest/Jest)
```

## ⚠ SECURITY: do not compile with Compact 0.31.0

**Compact 0.31.0 has a soundness bug.** It can silently **drop a range constraint** from a
circuit. Fixed in **0.31.1** — use that or later for anything you will deploy.

If you deployed anything compiled with 0.31.0, Midnight's guidance is:

1. Recompile the same source with 0.31.1.
2. **Diff the resulting verifier key against the one deployed on-chain.**
3. Keys identical → the bug did not fire; that deployment is fine.
4. Keys differ → the bug may have dropped a range constraint. Assess exposure: does any
   `Uint<N>` cast feed a **balance, quorum, counter, index**, or other security-relevant sink?
5. Exposed → redeploy with 0.31.1. The on-chain verifier key **cannot be patched in place**;
   it can only be replaced by redeploying, or via maintenance authority if you have a
   reachable committee.

⚠ **Do not try to find this by reading your source.** Midnight's own analysis: *"the trigger
has too many non-obvious origins for pattern review to be reliable. The VK diff is the
authoritative check."*

This matters most for the patterns in `examples/` that touch value or authority —
`fungible-token`, `lending`, `multi-sig` (quorum), `crowdfunding`, `sealed-bid-auction`.

## Current versions (verified 2026-08-17)

Authoritative matrix: <https://docs.midnight.network/relnotes/support-matrix>

| component | version |
|---|---|
| Compact compiler | **0.31.1** |
| `@midnight-ntwrk/compact-runtime` | **0.16.0** |
| Midnight.js (`midnight-js-*`) | **4.1.1** |
| DApp Connector API | 4.0.1 |
| Node | 1.0.1 |
| Ledger | 8.1.0 |
| Indexer | 4.3.3 |
| Proof Server | 8.1.0 |

⚠ **Keep every `@midnight-ntwrk/midnight-js-*` package on the same major line.** Mixing 3.x
and 4.x produces `Cannot read properties of undefined (reading 'ctor')` — an error that looks
like a contract problem and is not. **Ledger v7 is no longer supported.**

The simulator API used throughout this skill (`createConstructorContext`,
`createCircuitContext`, `sampleContractAddress`) was **verified present in compact-runtime
0.16.0** on 2026-08-17.

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
- On preprod, request tNight from the faucet (below) — 1,000 tNight per request is sufficient
  for dozens of deployments

⚠ **DUST ordering matters.** Create wallet → request tNight → designate a DUST address. If you
funded the wallet *before* designating, send tNight to yourself to create a new UTXO that will
generate DUST. Getting this order wrong leaves the send option greyed out with no explanation.

## Networks (verified 2026-08-17)

**Mainnet is live** — Node 1.0.0 from 20 Jul 2026, 1.0.1 from 29 Jul. It runs in **federated**
mode: block production is operated by the foundation, and third-party validation has not opened.
An Incentivised Testnet is expected to precede it.

| | endpoint |
|---|---|
| mainnet RPC | `https://rpc.mainnet.midnight.network/` |
| mainnet indexer | `https://indexer.mainnet.midnight.network/api/v4/graphql` |
| **preprod faucet** | `https://midnight-tmnight-preprod.nethermind.dev/` |
| **preview faucet** | `https://midnight-tmnight-preview.nethermind.dev/` |
| status | `https://status.shielded.tools/preprod` · `/preview` |
| service desk | <https://midnightntwrk.github.io/servicedesk/> |

⚠ **Check network health before a deploy session, not during one.** The `/api/health` endpoint
on either Nethermind faucet returns the real state — testnets are reset and go out of service
with some regularity. Measured 2026-08-17: preprod `{"status":"ok"}` while preview returned
`{"status":"NOT_SERVING","reason":"SYNC_STUCK_RECOVERY"}`. Community advice about which network
to prefer goes stale within days; the health endpoint does not.

⚠ **Lace Midnight Preview (the standalone extension) is deprecated.** Midnight support is in
the main Lace wallet now; `1AM` is the Midnight-native alternative.

Report infrastructure problems through the service desk rather than chat — it is the monitored
triage route.

## Common errors (observed in the wild)

Errors whose message points somewhere other than the cause. Each of these cost a real developer
material time in the Midnight dev channels.

**`Cannot read properties of undefined (reading 'ctor')`** — usually thrown from
`findDeployedContract`, and it looks like the contract is missing or the address is wrong. It
is neither. Two causes, in order of likelihood:
1. **Mixed SDK majors.** `@midnight-ntwrk/midnight-js-contracts` and `midnight-js-protocol` (and
   the rest of `midnight-js-*`) must be on the **same 4.x line**. Check every one of them.
2. Passing the **raw compiled contract object** where a `CompiledContract` is required. Wrap it:
   `CompiledContract.make(tag, ctor)`.

**Wallet connects but never syncs / send greyed out** — see the DUST ordering note above. Also
check you are on the current Lace, not the deprecated standalone Midnight Preview extension.

**Deploy or sync hangs with no error** — check the network health endpoint before debugging your
code. Testnet sync outages are common and present as your application being broken.

**`1014` reject (dust contention)** — reported as potentially leaving a wallet's dust note
marked spent indefinitely. If a wallet becomes stuck after a reject, a fresh wallet is the
known workaround; report it to the service desk.

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

30 examples (27 validated + 2 network-only + 1 compiled-only). 151 circuits compiled, 182/182 tests passing on the original March run; re-verified 2026-08-17 on Compact 0.31.1 (29/29 compile) with 10/10 simulator suites / 69 tests passing. 30 contracts deployed on preprod:

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
- [Native Shielded Token](examples/native-shielded-token.md) — 2 circuits. Contract-issued shielded token via OZ `NativeShieldedTokenCore`. ⚠ Documents the coin-info hazard: contract-minted coins create NO ciphertext, so the returned `ShieldedCoinInfo` is the recipient's only copy — drop it and the value is stranded permanently.
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
