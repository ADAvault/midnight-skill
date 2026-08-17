# Midnight Compact Smart Contract Skill

An [Agent Skill](https://agentskills.io) for writing, testing, and deploying **Compact smart contracts** on the **Midnight blockchain**. Built from Discord community knowledge, compiler validation, and real-world gotchas. This project extends the [Midnight Network](https://midnight.network) with additional developer tooling.

Supports Claude Code, Cursor, Gemini CLI, VS Code Copilot, and 30+ other AI coding assistants.

> **Important:** These examples are educational references. Any smart contract generated using this skill should be professionally audited before deployment to mainnet. AI-assisted code generation does not replace security review.

## Compiler-Validated

All examples compiled and tested against **Compact 0.30.0** (`compact-runtime` 0.15.0, ledger v8). Also compatible with Compact 0.29.0 (ledger v7). See gotcha #74 for migration guide.

> ### ✅ Re-validated 2026-08-17 — all 29 examples compile on Compact 0.31.1
>
> Every published example was recompiled from source against the current compiler.
>
> | set | result |
> |---|---|
> | 10 standalone validation contracts | **10/10 PASS** |
> | 19 remaining + new contracts | **19/19 PASS** |
> | vendored OpenZeppelin `compact-contracts` | 9/10 — see below |
>
> **Toolchain:** `compact` CLI **0.5.1**, compiler **0.31.1**, `compact-runtime` **0.16.0**,
> Midnight.js **4.1.1**, Node 1.0.1, Ledger 8.1.0.
> ([support matrix](https://docs.midnight.network/relnotes/support-matrix))
>
> ⚠ `compact --version` reports the **CLI wrapper** (0.5.1), not the compiler (0.31.1). Easy
> to confuse when checking which you are on.
>
> **🔴 Compact 0.31.0 has a soundness bug** that can silently drop a range constraint. Use
> **0.31.1**+. If you deployed anything built with 0.31.0, diff the verifier key — source
> review is explicitly *not* reliable for finding it. Details in `SKILL.md`.
>
> **Breaking changes found, and what they mean for older code:**
> - `CoinInfo` is now an **unbound identifier** — hit by OZ's `archive/ShieldedToken.compact`,
>   which upstream has already retired. Expected, not a regression, but relevant to anyone
>   carrying older Zswap coin code.
> - Zswap operators were **renamed**: `receive` → `receiveShielded`,
>   `sendImmediate` → `sendImmediateShielded`. The compiler names the replacement in the error,
>   so this migrates cleanly. All current examples already use the new names.
>
> The per-example **test counts** in the table below were measured in March against Compact
> 0.29.0/0.30.0 and have not been re-run — only compilation was re-verified today.

| Example | Circuits | Tests | Status |
|---------|----------|-------|--------|
| [Counter](examples/counter.md) | 3 | 5/5 | Validated |
| [Bulletin Board](examples/bulletin-board.md) | 3 | 8/8 | Validated |
| [Fungible Token](examples/fungible-token.md) | 7 | 6/6 | Validated (OZ modules) |
| [NFT](examples/nft.md) | 7 | 6/6 | Validated |
| [Rock-Paper-Scissors](examples/rock-paper-scissors.md) | 3 | 6/6 | Validated |
| [Shielded Voting](examples/shielded-voting.md) | 6 | 9/9 | Validated |
| [Sealed-Bid Auction](examples/sealed-bid-auction.md) | 6 | 8/8 | Validated |
| [Identity Proof](examples/identity-proof.md) | 4 | 6/6 | Validated |
| [Credential Registry](examples/credential-registry.md) | 5 | 6/6 | Validated |
| [Prescription](examples/prescription.md) | 5 | 6/6 | Validated |
| [Escrow](examples/escrow.md) | 5 | 8/8 | Validated |
| [Time Lock](examples/time-lock.md) | 3 | 7/7 | Validated |
| [Multi-Sig](examples/multi-sig.md) | 6 | 6/6 | Validated |
| [Staking](examples/staking.md) | 5 | 6/6 | Validated |
| [Crowdfunding](examples/crowdfunding.md) | 5 | 6/6 | Validated |
| [Lending](examples/lending.md) | 6 | 6/6 | Validated |
| [Prediction Market](examples/prediction-market.md) | 5 | 7/7 | Validated |
| [Oracle Feed](examples/oracle-feed.md) | 5 | 6/6 | Validated |
| [Access Control](examples/access-control.md) | 8 | 6/6 | Validated |
| [DID Registry](examples/did-registry.md) | 5 | 6/6 | Validated |
| [Micro-DAO](examples/micro-dao.md) | 7 | 7/7 | Validated |
| [Contract Upgradability](examples/contract-upgradability.md) | V1: 3, V2: 7 | 8/8 | Validated |
| [Token Swap](examples/token-swap.md) | 6 | — | Preprod deployed |
| [Token Minting](examples/token-minting.md) | 3 | — | Preprod deployed |
| [Privacy Mixer](examples/privacy-mixer.md) | 3 | 7/7 | Validated |
| [Lottery](examples/lottery.md) | 4 | 8/8 | Validated |
| [Vesting](examples/vesting.md) | 4 | 8/8 | Validated |
| [Revenue Sharing](examples/revenue-sharing.md) | 3 | 7/7 | Validated |
| [Supply Chain](examples/supply-chain.md) | 4 | 7/7 | Validated |
| **[Native Shielded Token](examples/native-shielded-token.md)** | 2 | — | **Compiled 0.31.1** |

**30 examples. 29/29 re-verified compiling on Compact 0.31.1 (2026-08-17); 10/10 test suites, 69 tests passing on compact-runtime 0.16.0. Native Shielded Token added 2026-08-17, compiles on 0.31.1 (no test suite yet). 6 contracts deployed on v8 preprod.**

Token Swap and Token Minting use Zswap coin operations (`receiveShielded`, `sendImmediateShielded`, `mintToken`) that require the full network stack for circuit calls. Both compile and deploy successfully.

## Preprod Deployment

### v8 (Ledger 8.0.3, March 2026)

6 contracts deployed to Midnight **preprod** on Ledger v8 (protocol v22000). Representative sample validating all major patterns.

| Contract | Pattern | Circuits | DUST Fee | Deploy Time | Block |
|----------|---------|----------|---------|-------------|-------|
| Counter | simplest | 3 | 252B | 17.8s | 114208 |
| Bulletin Board | auth | 2 | 267B | 19.1s | 114211 |
| Sealed-Bid Auction | commit-reveal + state machine | 5 | 554B | 16.9s | 114214 |
| Oracle Feed | time-based | 5 | 504B | 19.0s | 114217 |
| Multi-Sig | multi-party | 6 | 574B | 17.5s | 114220 |
| LOK | token ops (receiveUnshielded) | 4 | 423B | 17.4s | 114223 |

`receiveUnshielded` (wallet→contract token transfer) confirmed working on v8 — Issue #151 resolved.

### v7 (historical, chain wiped)

30 contracts were previously deployed on Ledger v7 (protocol v21000). Chain state was reset with the v8 upgrade on March 25, 2026.

### DUST Fee Economics

DUST is Midnight's fee token — generated continuously from tNight. Must register NIGHT UTxOs for dust generation before any deployment (gotcha #75).

- **Generation rate**: 5 DUST per NIGHT, ~1 week to cap
- **Deploy time**: 16-22s per contract on preprod
- **Practical cost**: 1000 tNight from faucet generates ample DUST for dozens of deployments

## What's Covered

- **Compact language** — types, syntax, circuits, witnesses, disclosure, module system
- **Privacy model** — shielded vs unshielded state, ZK proof flow, witness security
- **Security** — 10 ZK-specific attack categories with mitigations
- **Testing** — simulator, standalone network, testnet (3-level testing approach)
- **Design patterns** — authentication, OZ composition, off-chain computation, circuit optimization
- **Off-chain integration** — TypeScript SDK, wallet connectivity, provider pattern, deployment
- **Gotchas** — compiler bugs, SDK pitfalls, proof server issues, design traps (sourced from Discord + real compilation)
- **30 worked examples** — core patterns through DeFi, governance, identity, contract upgradability, supply chain, and native shielded tokens

## Installation

### Project-level (recommended)

```bash
mkdir -p .claude/skills
git clone https://github.com/adavault/midnight-skill.git .claude/skills/midnight-compact
```

### Personal (all projects)

```bash
git clone https://github.com/adavault/midnight-skill.git ~/.claude/skills/midnight-compact
```

## Usage

The skill auto-activates on keywords: `Midnight`, `Compact`, `circuit`, `witness`, `ledger`, `disclose`, `proof server`, `DUST`, `NIGHT`, `Zswap`, `shielded`.

Or invoke explicitly: `/midnight-compact`

## Structure

```
midnight-skill/
├── SKILL.md                    # Core skill — workflow, syntax, patterns
├── README.md                   # This file
├── LICENSE                     # MIT
├── reference/                  # Deep-dive reference documents
│   ├── language.md            # Compact types, syntax, modules, operators
│   ├── privacy-model.md       # Shielded/unshielded state, ZK proof flow
│   ├── security.md            # 10 ZK attack categories and mitigations
│   ├── testing.md             # Simulator, standalone, testnet testing
│   ├── patterns.md            # Design patterns and circuit optimization
│   ├── stdlib.md              # CompactStandardLibrary reference
│   ├── gotchas.md             # 79 real-world issues from Discord + compilation
│   ├── offchain.md            # TypeScript SDK, wallet, deployment
│   └── auditing.md            # ZK contract audit methodology
└── examples/                   # Working examples with tests
    ├── counter.md             # Simplest contract — state + increment
    ├── bulletin-board.md      # Witness auth, CRUD, multi-user
    ├── fungible-token.md      # OZ module composition (FT + Ownable + Pausable)
    ├── nft.md                 # Commitment-based NFT ownership
    ├── rock-paper-scissors.md # Commit-reveal 2-player game
    ├── shielded-voting.md     # Commit-reveal private ballot
    ├── sealed-bid-auction.md  # Commit-reveal with state machine
    ├── identity-proof.md      # Selective disclosure, parameterized witnesses
    ├── credential-registry.md # Nullifier-based double-use prevention
    ├── prescription.md        # Batch registration, nullifier for healthcare
    ├── escrow.md              # Two-party exchange with deadline
    ├── time-lock.md           # Time-based LOK/RELEASE pattern
    ├── multi-sig.md           # M-of-N authorization, composite keys
    ├── staking.md             # Lock period + ZK reward calculation
    ├── crowdfunding.md        # Anonymous backing, ZK refund proofs
    ├── lending.md             # Collateral, health factor, liquidation
    ├── prediction-market.md   # Commitment-based bets, ZK payout
    ├── oracle-feed.md         # External data, freshness checks
    ├── token-swap.md          # Atomic swap (coin operations)
    ├── access-control.md      # Role hierarchy, internal guards
    ├── did-registry.md        # DID document lifecycle management
    ├── micro-dao.md           # Token-gated voting, treasury
    ├── contract-upgradability.md # V1/V2 migration pattern
    ├── token-minting.md       # Zswap coin creation (mintShieldedToken)
    ├── privacy-mixer.md       # Nullifier-based deposit/withdraw mixer
    ├── lottery.md             # Commit-reveal multi-party randomness
    ├── vesting.md             # Time-based tranche release schedule
    ├── revenue-sharing.md     # Private share allocations, ZK withdrawal
    ├── supply-chain.md        # Selective disclosure provenance tracking
    └── native-shielded-token.md # Contract-minted shielded token + coin-info hazard
```

## Key Findings from Validation

Compiling all examples against the real compiler uncovered several patterns not documented elsewhere:

- **No sequence counter for registered key sets** — contracts with multi-party key registries (multi-sig, ACL, oracle, identity) must use deterministic keys. A sequence increment invalidates all registered keys.
- **`Uint<N> + literal` type widening** — `Uint<32> + 1` produces `Uint<0..4294967297>`. Fix: `(expr + 1) as Uint<32>`.
- **Parameterized witnesses work** — `witness fn(param: T): U` passes circuit arguments to TypeScript witnesses as additional function parameters.
- **Internal circuits can access ledger** — non-exported `circuit` (not `pure circuit`) can read/write `export ledger` state, enabling reusable guard patterns.
- **Boolean/literal assignments skip `disclose()`** — compile-time constants written to `export ledger` don't need disclosure wrapping.

All findings are documented in [gotchas.md](reference/gotchas.md) (#49-#52) and in each example's Key Concepts section.

### v8 Migration Findings

The Ledger v8 release (March 2026) introduced significant SDK changes discovered during validation:

- **Witness tuple return** — witnesses now return `[nextPrivateState, value]` instead of just `value` (gotcha #79)
- **Simulator API** — `contract.initialState(ctx, ...args)` replaces `contract.constructor(ctx)` (gotcha #79)
- **Dust registration required** — must call `registerNightUtxosForDustGeneration()` before any deployment (gotcha #75)
- **`signRecipe` bug fixed** — wallet-sdk-facade 3.0.0 handles proof markers correctly (gotcha #76)
- **`nativeToken()` trap** — use `unshieldedToken().raw` from ledger-v7 for balance lookups (gotcha #77)
- **Private state encryption** — `levelPrivateStateProvider` now requires encryption config (gotcha #78)

### 0.31.1 re-validation findings (August 2026)

Re-compiling every example against Compact 0.31.1 surfaced these:

- **`CoinInfo` is now an unbound identifier** — older Zswap coin code referencing it no longer
  compiles. OpenZeppelin has moved the affected contract to `archive/`.
- **Zswap operators renamed** — `receive` → `receiveShielded`, `sendImmediate` →
  `sendImmediateShielded`. The compiler names the replacement in the error, so migration is
  mechanical.
- **`Opaque<"string">` cannot be constructed in Compact** — a string literal is `Bytes<N>` and
  there is no cast between them. Names, symbols and descriptions must arrive as parameters from
  TypeScript. OpenZeppelin's own mocks follow this pattern.
- **Module prefixes concatenate, they do not dot** — `import "./X" prefix Token_` gives
  `Token__mint(...)`, not `Token_._mint(...)`.
- **`compact --version` reports the CLI, not the compiler** — CLI 0.5.1 ships compiler 0.31.1.
  Easy to misread when checking which version you are on.
- **Simulator API stable across `compact-runtime` 0.14 → 0.16** — test suites pinned at `^0.14.0`
  pass unchanged against 0.16.0.

## Sources

Built from:
- **Midnight Discord dev-chat** (Feb 2024 — Mar 2026)
- **OpenZeppelin/compact-contracts** — canonical Compact library
- **Official Midnight examples** — counter, bulletin board, counter-cli migration guide
- **Brick Towers** projects — seabattle, local-network, proof-server, RWA
- **Existing community skills** — UvRoxx, FractionEstate, OverGuild, mzf11125
- **Compiler validation** — every example compiled against Compact 0.29.0 and 0.30.0
- **Simulator validation** — 29/29 examples pass on compact-runtime 0.15.0
- **Preprod deployment** — 6 contracts deployed on v8 preprod (Ledger 8.0.3, protocol v22000)
- **[midnight-mcp](https://github.com/Olanetsoft/midnight-mcp)** — MCP server for searching across 102+ Midnight repos. Complementary tool: the MCP provides live search, this skill provides validated patterns. Several gotchas (#64, #65) were discovered via MCP search.
- **[docs.midnight.network/relnotes/overview](https://docs.midnight.network/relnotes/overview)** — official v8 compatibility matrix

## Contributing

PRs welcome — especially from Midnight developers, ZK researchers, and privacy protocol builders. Areas of interest:

- New contract patterns or examples
- Security findings or additional ZK attack vectors
- Corrections to existing reference material
- Off-chain integration patterns for new SDK versions

## Companion Skills

- [cardano-skill](https://github.com/ADAvault/cardano-skill) — Aiken smart contracts on Cardano (eUTxO, multi-validator, CIP-113)
- [cardano-offchain-skill](https://github.com/ADAvault/cardano-offchain-skill) — CIP-30 wallets, MeshJS transactions, Ogmios/Kupo, Playwright testing

## License

MIT — see [LICENSE](LICENSE).

---

Built by [ADAvault](https://github.com/adavault)
