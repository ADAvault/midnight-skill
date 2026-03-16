# Midnight Compact Smart Contract Skill

An [Agent Skill](https://agentskills.io) for writing, testing, and deploying **Compact smart contracts** on the **Midnight blockchain**. Built from Discord community knowledge, compiler validation, and real-world gotchas.

Supports Claude Code, Cursor, Gemini CLI, VS Code Copilot, and 30+ other AI coding assistants.

> **Important:** These examples are educational references. Any smart contract generated using this skill should be professionally audited before deployment to mainnet. AI-assisted code generation does not replace security review.

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
| [Token Swap](examples/token-swap.md) | 6 | — | Preprod deployed |
| [Token Minting](examples/token-minting.md) | 3 | — | Preprod deployed |
| [Privacy Mixer](examples/privacy-mixer.md) | 3 | 7/7 | Validated |
| [Lottery](examples/lottery.md) | 4 | 8/8 | Validated |
| [Vesting](examples/vesting.md) | 4 | 8/8 | Validated |
| [Revenue Sharing](examples/revenue-sharing.md) | 3 | 7/7 | Validated |
| [Supply Chain](examples/supply-chain.md) | 4 | 7/7 | Validated |

**27/29 validated. 151 circuits compiled. 182/182 tests passing. 30 contracts deployed on preprod.**

Token Swap and Token Minting use Zswap coin operations (`receiveShielded`, `sendImmediateShielded`, `mintToken`, `tokenType`, `kernel.self()`) that require the full network stack and cannot be tested in the simulator. Both are compiled and deployed on preprod.

## Preprod Deployment

30 contracts from this skill deployed to Midnight **preprod** (protocol v21000, March 2026). All transactions confirmed on-chain with ZK proofs generated and verified.

| Contract | Circuits | DUST Fee | Deploy Time | Block |
|----------|----------|----------|-------------|-------|
| Counter | 3 | 252B | 21.1s | 624936 |
| Bulletin Board | 2 | 267B | 17.8s | 624939 |
| Fungible Token | 7 | 560B | 18.6s | 625467 |
| Rock-Paper-Scissors | 3 | 367B | 18.8s | 623130 |
| NFT | 7 | 712B | 21.7s | 623134 |
| Escrow | 3 | 360B | 17.8s | 624942 |
| Time Lock | 3 | 363B | 18.9s | 624945 |
| Multi-Sig | 6 | 574B | 18.3s | 624948 |
| Identity Proof | 4 | 451B | 17.7s | 624957 |
| Credential Registry | 5 | 479B | 20.1s | 623138 |
| Prescription | 5 | 480B | 21.6s | 623150 |
| Privacy Mixer | 3 | 294B | 21.3s | 624854 |
| Shielded Voting | 6 | 660B | 19.4s | 624960 |
| Sealed-Bid Auction | 5 | 554B | 17.7s | 624963 |
| Oracle Feed | 5 | 504B | 17.2s | 624951 |
| Access Control | 8 | 931B | 17.8s | 624954 |
| DID Registry | 5 | 526B | 21.5s | 623142 |
| Micro-DAO | 7 | 697B | 20.1s | 623146 |
| Upgradability V1 | 3 | 331B | 21.7s | 623154 |
| Upgradability V2 | 3 | 721B | 20.2s | 623158 |
| Token Swap | 6 | 645B | 18.6s | 625619 |
| Token Minting | 3 | 349B | 21.5s | 623162 |
| Prediction Market | 5 | 523B | 20.1s | 623166 |
| Staking | 5 | 548B | 21.6s | 623170 |
| Crowdfunding | 5 | 564B | 20.2s | 623174 |
| Lending | 6 | 629B | 16.2s | 623177 |
| Lottery | 4 | 485B | 16.9s | 624857 |
| Vesting | 4 | 418B | 18.9s | 624860 |
| Revenue Sharing | 3 | 332B | 18.0s | 624863 |
| Supply Chain | 4 | 390B | 17.8s | 624866 |

**Total: 15,011B DUST across 30 deployments. Average: ~500B DUST per contract.**

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
- **29 worked examples** — core patterns through DeFi, governance, identity, contract upgradability, and supply chain

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
│   ├── gotchas.md             # 69 real-world issues from Discord + compilation
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
    └── supply-chain.md        # Selective disclosure provenance tracking
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
- **Preprod deployment** — 30 contracts deployed on Midnight preprod with ZK proofs verified on-chain
- **[midnight-mcp](https://github.com/Olanetsoft/midnight-mcp)** — MCP server for searching across 102+ Midnight repos. Complementary tool: the MCP provides live search, this skill provides validated patterns. Several gotchas (#64, #65) were discovered via MCP search.

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
