# Midnight Compact Smart Contract Skill

A comprehensive [Agent Skill](https://agentskills.io) for writing, testing, and deploying **Compact smart contracts** on the **Midnight blockchain**. Built from production experience, Discord community knowledge, and real-world gotchas.

Supports Claude Code, Cursor, Gemini CLI, VS Code Copilot, and 30+ other AI coding assistants.

## What's Covered

- **Compact language** — types, syntax, circuits, witnesses, disclosure, module system
- **Privacy model** — shielded vs unshielded state, ZK proof flow, witness security
- **Security** — 10 ZK-specific attack categories with mitigations
- **Testing** — simulator, standalone network, testnet (3-level testing approach)
- **Design patterns** — authentication, OZ composition, off-chain computation, circuit optimization
- **Off-chain integration** — TypeScript SDK, wallet connectivity, provider pattern, deployment
- **35+ gotchas** — compiler bugs, SDK pitfalls, proof server issues (sourced from 9,000+ Discord messages)
- **12 worked examples** — counter through escrow, time-lock, and access control

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
│   ├── gotchas.md             # 35+ real-world issues from Discord
│   ├── offchain.md            # TypeScript SDK, wallet, deployment
│   └── auditing.md            # ZK contract audit methodology
└── examples/                   # Working examples with tests
    ├── counter.md             # Simplest contract
    ├── bulletin-board.md      # Witness auth pattern
    ├── fungible-token.md      # OZ module composition
    ├── shielded-voting.md     # Private ballot
    ├── sealed-bid-auction.md  # Commit-reveal with ZK
    ├── identity-proof.md      # Attribute verification
    ├── escrow.md              # Two-party exchange
    ├── time-lock.md           # Time-based release
    ├── multi-sig.md           # M-of-N authorization
    ├── oracle-feed.md         # External data integration
    ├── token-swap.md          # Atomic swap
    └── access-control.md      # Role-based permissions
```

## Sources

Built from:
- **8,948 dev-chat messages** from the Midnight Discord (Feb 2024 — Mar 2026)
- **OpenZeppelin/compact-contracts** — canonical Compact library
- **Official Midnight examples** — counter, bulletin board
- **Brick Towers** projects — seabattle, local-network, proof-server, RWA
- **Existing community skills** — UvRoxx, FractionEstate, OverGuild, mzf11125

## Companion Skill

See also: [aiken-skill](https://github.com/adavault/aiken-skill) — the equivalent skill for Aiken smart contracts on Cardano.

## License

MIT — see [LICENSE](LICENSE).

---

Built by [ADAvault](https://github.com/adavault)
