# Midnight Compact Smart Contract Skill

A comprehensive [Agent Skill](https://agentskills.io) for writing, testing, and deploying **Compact smart contracts** on the **Midnight blockchain**. Built from production experience, Discord community knowledge, and real-world gotchas.

Supports Claude Code, Cursor, Gemini CLI, VS Code Copilot, and 30+ other AI coding assistants.

## Compiler-Validated

All examples have been compiled and tested against **Compact 0.29.0** and `@midnight-ntwrk/compact-runtime` 0.29.0. This is not aspirational documentation — every contract compiles, every test passes.

| Example | Circuits | Tests | Status |
|---------|----------|-------|--------|
| [Counter](examples/counter.md) | 3 | 5/5 | Validated |
| [Bulletin Board](examples/bulletin-board.md) | 3 | 8/8 | Validated |
| [Fungible Token](examples/fungible-token.md) | 7 | 6/6 | Validated (OZ modules) |
| [Shielded Voting](examples/shielded-voting.md) | 6 | 9/9 | Validated |
| [Sealed-Bid Auction](examples/sealed-bid-auction.md) | 6 | 8/8 | Validated |
| [Escrow](examples/escrow.md) | 5 | 8/8 | Validated |
| [Time Lock](examples/time-lock.md) | 3 | 7/7 | Validated |
| [Identity Proof](examples/identity-proof.md) | 4 | 6/6 | Validated |
| [Multi-Sig](examples/multi-sig.md) | 6 | 6/6 | Validated |
| [Oracle Feed](examples/oracle-feed.md) | 5 | 6/6 | Validated |
| [Access Control](examples/access-control.md) | 8 | 6/6 | Validated |
| [Token Swap](examples/token-swap.md) | — | — | Network validation pending |

**11/12 validated. 56 circuits compiled. 75/75 tests passing.**

Token Swap uses Zswap coin operations (`receive`, `sendImmediate`, `tokenType`) that require the full network stack and cannot be tested in the simulator.

## What's Covered

- **Compact language** — types, syntax, circuits, witnesses, disclosure, module system
- **Privacy model** — shielded vs unshielded state, ZK proof flow, witness security
- **Security** — 10 ZK-specific attack categories with mitigations
- **Testing** — simulator, standalone network, testnet (3-level testing approach)
- **Design patterns** — authentication, OZ composition, off-chain computation, circuit optimization
- **Off-chain integration** — TypeScript SDK, wallet connectivity, provider pattern, deployment
- **52 gotchas** — compiler bugs, SDK pitfalls, proof server issues, design traps (sourced from Discord + real compilation)
- **12 worked examples** — counter through escrow, time-lock, identity proof, and access control

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
    ├── shielded-voting.md     # Commit-reveal private ballot
    ├── sealed-bid-auction.md  # Commit-reveal with state machine
    ├── identity-proof.md      # Selective disclosure, parameterized witnesses
    ├── escrow.md              # Two-party exchange with deadline
    ├── time-lock.md           # Time-based LOK/RELEASE pattern
    ├── multi-sig.md           # M-of-N authorization, composite keys
    ├── oracle-feed.md         # External data, freshness checks
    ├── token-swap.md          # Atomic swap (coin operations)
    └── access-control.md      # Role hierarchy, internal guards
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
- **8,948 dev-chat messages** from the Midnight Discord (Feb 2024 — Mar 2026)
- **OpenZeppelin/compact-contracts** — canonical Compact library
- **Official Midnight examples** — counter, bulletin board
- **Brick Towers** projects — seabattle, local-network, proof-server, RWA
- **Existing community skills** — UvRoxx, FractionEstate, OverGuild, mzf11125
- **Compiler validation** — every example compiled and tested against Compact 0.29.0

## Companion Skill

See also: [cardano-skill](https://github.com/adavault/cardano-skill) — the equivalent skill for smart contracts on Cardano (Aiken, Plutus, Marlowe).

## License

MIT — see [LICENSE](LICENSE).

---

Built by [ADAvault](https://github.com/adavault)
