# Midnight Compact Smart Contract Skill

An [Agent Skill](https://agentskills.io) for writing, testing, and deploying **Compact smart contracts** on the **Midnight blockchain**. Built from Discord community knowledge, compiler validation, and real-world gotchas.

Supports Claude Code, Cursor, Gemini CLI, VS Code Copilot, and 30+ other AI coding assistants.

## Compiler-Validated

All examples compiled and tested against **Compact 0.29.0** and `@midnight-ntwrk/compact-runtime` 0.29.0.

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
| [Token Swap](examples/token-swap.md) | — | — | Network validation pending |
| [Token Minting](examples/token-minting.md) | 3 | — | Preprod deployed |

**22/24 validated. 127 circuits compiled. 145/145 tests passing. 13 contracts deployed on preprod.**

Token Swap uses Zswap coin operations (`mintShieldedToken`, `tokenType`, `kernel.self()`) that require the full network stack and cannot be tested in the simulator.

## Preprod Deployment

13 contracts from this skill deployed to Midnight **preprod** (protocol v21000, March 2026). All transactions confirmed on-chain with ZK proofs generated and verified.

| Contract | Circuits | DUST Fee | Deploy Time | Block |
|----------|----------|----------|-------------|-------|
| Rock-Paper-Scissors | 3 | 367B | 18.8s | 623130 |
| NFT | 7 | 712B | 21.7s | 623134 |
| Credential Registry | 5 | 479B | 20.1s | 623138 |
| DID Registry | 5 | 526B | 21.5s | 623142 |
| Micro-DAO | 7 | 697B | 20.1s | 623146 |
| Prescription | 5 | 480B | 21.6s | 623150 |
| Upgradability V1 | 3 | 331B | 21.7s | 623154 |
| Upgradability V2 | 3 | 721B | 20.2s | 623158 |
| Token Minting | 3 | 349B | 21.5s | 623162 |
| Prediction Market | 5 | 523B | 20.1s | 623166 |
| Staking | 5 | 548B | 21.6s | 623170 |
| Crowdfunding | 5 | 564B | 20.2s | 623174 |
| Lending | 6 | 629B | 16.2s | 623177 |

**Total: 6,926B DUST across 13 deployments. Average: ~533B DUST per contract.**

### DUST Fee Economics

DUST is Midnight's fee token — a high-precision micro-token generated continuously from tNight (the staking/governance token). Values above are in the smallest indivisible DUST unit.

- **Generation rate**: `nightDustRatio = 5,000,000,000` — each tNight generates up to 5B DUST/sec, decaying over ~7 days (`timeToCapSeconds = 604,815`)
- **Fee range**: 331B–721B DUST per deployment, correlating with contract size and circuit count
- **Practical cost**: with 2,000 tNight (~$2 from faucet), DUST generation far outpaces deployment fees — all 13 contracts deployed with DUST to spare
- **Fee = estimated**: `paidFees` matched `estimatedFees` exactly for every deployment, indicating deterministic fee calculation

## What's Covered

- **Compact language** — types, syntax, circuits, witnesses, disclosure, module system
- **Privacy model** — shielded vs unshielded state, ZK proof flow, witness security
- **Security** — 10 ZK-specific attack categories with mitigations
- **Testing** — simulator, standalone network, testnet (3-level testing approach)
- **Design patterns** — authentication, OZ composition, off-chain computation, circuit optimization
- **Off-chain integration** — TypeScript SDK, wallet connectivity, provider pattern, deployment
- **Gotchas** — compiler bugs, SDK pitfalls, proof server issues, design traps (sourced from Discord + real compilation)
- **24 worked examples** — core patterns through DeFi, governance, identity, and contract upgradability

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
│   ├── gotchas.md             # 52 real-world issues from Discord + compilation
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
    └── token-minting.md       # Zswap coin creation (mintShieldedToken)
```

## Key Findings from Validation

Compiling all examples against the real compiler uncovered several patterns not documented elsewhere:

- **No sequence counter for registered key sets** — contracts with multi-party key registries (multi-sig, ACL, oracle, identity) must use deterministic keys. A sequence increment invalidates all registered keys.
- **`Uint<N> + literal` type widening** — `Uint<32> + 1` produces `Uint<0..4294967297>`. Fix: `(expr + 1) as Uint<32>`.
- **Parameterized witnesses work** — `witness fn(param: T): U` passes circuit arguments to TypeScript witnesses as additional function parameters.
- **Internal circuits can access ledger** — non-exported `circuit` (not `pure circuit`) can read/write `export ledger` state, enabling reusable guard patterns.
- **Boolean/literal assignments skip `disclose()`** — compile-time constants written to `export ledger` don't need disclosure wrapping.

All findings are documented in [gotchas.md](reference/gotchas.md) (#49-#52) and in each example's Key Concepts section.

## Sources

Built from:
- **Midnight Discord dev-chat** (Feb 2024 — Mar 2026)
- **OpenZeppelin/compact-contracts** — canonical Compact library
- **Official Midnight examples** — counter, bulletin board
- **Brick Towers** projects — seabattle, local-network, proof-server, RWA
- **Existing community skills** — UvRoxx, FractionEstate, OverGuild, mzf11125
- **Compiler validation** — every example compiled and tested against Compact 0.29.0
- **Preprod deployment** — 13 contracts deployed on Midnight preprod with ZK proofs verified on-chain

## Companion Skill

See also: [cardano-skill](https://github.com/adavault/cardano-skill) — the equivalent skill for smart contracts on Cardano (Aiken, Plutus, Marlowe).

## License

MIT — see [LICENSE](LICENSE).

---

Built by [ADAvault](https://github.com/adavault)
