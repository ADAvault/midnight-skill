# Auditing Methodology for Midnight Compact Contracts

A structured approach to auditing Compact smart contracts, adapted for Midnight's
privacy-preserving ZK architecture.

## Overview

Auditing Midnight contracts differs fundamentally from auditing Solidity or Aiken contracts:

- **Privacy is a first-class concern** — information leakage is a vulnerability category
- **Witness code is unverified** — the trust boundary between circuit and witness is critical
- **Circuit complexity has cost** — inefficient circuits waste proof generation resources
- **Dual-state model** — public ledger state and private off-chain state must be analysed separately

## Phase 1: Contract Mapping

### 1.1 Ledger State Inventory

Enumerate all ledger declarations and classify:

| Declaration | Visibility | Mutability | Purpose |
|-------------|-----------|------------|---------|
| `export ledger X` | Public | Mutable | Readable by anyone |
| `export sealed ledger X` | Public | Immutable (set once) | Set in constructor only |
| `ledger X` | Contract-private | Mutable | Not exported, internal only |

For each: document the type, initial value, and which circuits read/write it.

### 1.2 Circuit Inventory

Enumerate all circuits:

| Circuit | Exported | Pure | Parameters | Return | Ledger Reads | Ledger Writes |
|---------|----------|------|------------|--------|-------------|---------------|
| `increment` | Yes | No | none | `[]` | counter | counter |
| `helper` | No | Yes | `x: Field` | `Field` | none | none |

Identify: entry points (exported), internal helpers, pure computations.

### 1.3 Witness Inventory

Enumerate all witness declarations and their TypeScript implementations:

| Witness | Compact Declaration | TS Return Type | Accesses Private State? |
|---------|-------------------|----------------|------------------------|
| `localSecretKey` | `(): Bytes<32>` | `Uint8Array` | Yes — reads secretKey |

### 1.4 Trust Boundary Map

Draw the boundary between:
- **Circuit code** (proven, trusted, enforced by ZK)
- **Witness code** (unproven, runs locally, user-controlled)
- **Off-chain code** (TypeScript SDK, providers, UI)

Any value crossing from witness → circuit must be treated as untrusted input that the circuit must validate.

## Phase 2: Privacy Analysis

### 2.1 Disclosure Audit

For every `disclose()` call:

1. **What is disclosed?** — the exact value or expression
2. **Is it necessary?** — could the logic work without this disclosure?
3. **What can be inferred?** — even if the raw value is hidden, can it be deduced?
4. **Is it minimal?** — is the smallest possible amount of information revealed?

Flag: unnecessary disclosures, disclosures of sensitive identifiers, disclosures that enable tracking.

### 2.2 Indirect Leakage

Check for information leakage through:

- **Ledger operation patterns** — map insert/remove sequences reveal key existence
- **Circuit call patterns** — which circuits are called reveals user intent
- **Timing** — circuit complexity differences reveal which code path was taken
- **Transaction graph** — who transacts with whom (partially mitigated by Zswap)
- **Error messages** — different assertion messages reveal which check failed
- **Return values** — public return values from circuits

### 2.3 Constant Comparison

If a private value is compared against a hardcoded constant in the contract:
- The constant is PUBLIC (the script is visible on-chain)
- If the comparison succeeds, the private value equals the known constant
- This is only safe when the constant set is large (e.g., checking membership in a large set)

### 2.4 Witness Privacy

- Does the witness access data that should remain private?
- Could a malicious witness implementation leak data (e.g., via side channels)?
- Is private state stored securely (encrypted LevelDB, not plaintext)?

## Phase 3: Security Vulnerability Scan

Systematic check against each attack category from [security.md](security.md):

### 3.1 Authentication

- [ ] All state-modifying circuits verify caller identity
- [ ] Key derivation uses domain separator + sequence/nonce
- [ ] No circuits bypass ownership checks
- [ ] Constructor sets initial owner correctly

### 3.2 State Integrity

- [ ] All ledger writes are intentional (no unguarded writes)
- [ ] State transitions are valid (enum states follow expected flow)
- [ ] Sequence/nonce counters prevent replay
- [ ] Sealed ledger fields cannot be modified after construction

### 3.3 Arithmetic Safety

- [ ] No Field arithmetic that could overflow (known bug)
- [ ] Division done via witness with circuit verification
- [ ] Uint bounds are appropriate (no silent truncation)
- [ ] No reliance on mod operator (not supported)

### 3.4 Token/Coin Safety

- [ ] Shielded token operations handle all edge cases
- [ ] Mint operations use unique nonces
- [ ] Token type derivation uses consistent domain separators
- [ ] Total supply tracking is accurate (if applicable)

### 3.5 Assertion Coverage

- [ ] All error conditions have assertions
- [ ] Assertions use `disclose()` when checking private values
- [ ] Error messages don't leak sensitive information
- [ ] No code paths bypass critical assertions

## Phase 4: Circuit Complexity Analysis

### 4.1 k-Value Assessment

For each exported circuit:
- What is the expected `k` value?
- Does it call other exported circuits (increases k dramatically)?
- Could internal circuits replace exported-to-exported calls?
- Are ledger operations minimised?

Targets:
- `k <= 14` — fast proof generation
- `k 15-16` — acceptable
- `k >= 17` — problematic, especially with coin operations

### 4.2 Ledger Operation Costs

- Maps and Sets are "super expensive" in-circuit
- Counter operations in loops are extremely expensive
- Vector operations are cheaper but still costly at scale
- transientHash is 10x cheaper than persistentHash in-circuit

### 4.3 Optimisation Opportunities

- Can exported circuits be refactored to use internal circuits?
- Can computation move off-chain (witness + verify pattern)?
- Can Map iterations be replaced with per-item circuit calls?

## Phase 5: SDK Integration Review

### 5.1 Version Alignment

- [ ] All `@midnight-ntwrk/*` packages are compatible versions
- [ ] Compact compiler version matches SDK expectations
- [ ] Proof server version aligns with compiled contract version
- [ ] Node.js version is 22+ (avoids ESM/CJS issues)

### 5.2 Provider Configuration

- [ ] Private state provider uses encryption
- [ ] Public data provider points to correct indexer
- [ ] Proof server is accessible and correct version
- [ ] Network ID is set correctly

### 5.3 Witness Implementation

- [ ] All Compact witness declarations have TypeScript implementations
- [ ] Witness return types match Compact declarations
- [ ] Private state mutations are correct
- [ ] No witness implementation leaks sensitive data

## Phase 6: Test Coverage Assessment

### 6.1 Coverage Matrix

For each circuit, verify tests exist for:

| Circuit | Happy Path | Auth Failure | State Precondition | Edge Cases | Multi-User |
|---------|-----------|-------------|-------------------|-----------|------------|
| `post` | Yes | Yes | Yes | ? | ? |

### 6.2 Missing Tests

Identify:
- Untested circuits
- Untested error conditions
- Missing multi-user interaction tests
- Missing privacy verification tests (confirming values are NOT leaked)

## Severity Classification

| Severity | Definition | Example |
|----------|-----------|---------|
| **Critical** | Funds at risk or complete privacy breach | Missing auth check allows anyone to drain contract |
| **High** | Significant privacy leak or state corruption | Disclosure reveals user identity across transactions |
| **Medium** | Limited privacy leak or degraded functionality | Unnecessary disclosure reduces anonymity set |
| **Low** | Code quality or optimisation issue | Exported circuit calls increase k unnecessarily |
| **Informational** | Best practice recommendation | Missing test coverage for edge case |

## Report Format

```markdown
## Finding: [Title]

**Severity:** Critical / High / Medium / Low / Informational
**Category:** Privacy / Authentication / Arithmetic / Token / State / Complexity
**Location:** `contract.compact:L42` — `circuit transferFrom`

### Description
[What the issue is]

### Privacy Impact
[What information is leaked and to whom — Midnight-specific]

### Proof of Concept
[Steps to exploit or demonstrate the issue]

### Recommendation
[How to fix, with code example]
```
