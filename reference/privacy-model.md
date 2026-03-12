# Privacy Model

Midnight's privacy model is fundamentally different from transparent blockchains. Every
design decision in a Compact contract has privacy implications. This document explains
the mechanisms, trust boundaries, and tradeoffs so you can make informed decisions about
what to reveal, what to hide, and what the consequences are.

## 1. The Dual-State Architecture

Midnight contracts operate across three distinct state domains. Understanding where data
lives determines who can see it.

### Public Ledger State

Exported ledger fields are stored on-chain and visible to everyone -- indexers, block
explorers, other contracts, and any observer of the network.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

// Visible to all network participants
export ledger totalSupply: Counter;
export ledger paused: Boolean;
export ledger admin: Bytes<32>;
```

**When to use:** Aggregate counters, contract configuration, governance flags -- anything
that must be publicly verifiable or that other contracts need to read.

### Private State (Off-Chain, Per-User)

Private state exists only on the user's device. It is never transmitted to the chain.
Each user has their own independent private state object, managed by the TypeScript
witness layer.

```typescript
// Each user's private state lives in their browser/local environment
interface PrivateState {
  secretKey: Uint8Array;      // never leaves the device
  commitmentNonce: bigint;    // per-user randomness
  myVote: string;             // user's private choice
}
```

Private state is:
- **Invisible to the chain** -- not included in transactions, not in proofs
- **Per-user** -- two users calling the same contract have independent private states
- **Mutable only via witnesses** -- witnesses return `[newPrivateState, returnValue]`
- **Volatile** -- stored in browser LevelDB/IndexedDB, can be lost (see Section 7)

### Contract-Private State

Ledger fields declared without `export` are stored on-chain but are not exposed through
the contract's public API. They are accessible only to the contract's own circuits.

```compact
export ledger owner: Bytes<32>;         // public -- anyone can read
ledger secretThreshold: Uint<64>;       // contract-private -- only circuits can access
ledger commitmentHash: Bytes<32>;       // contract-private -- stored on-chain but not exported
```

**Important nuance:** Contract-private state is on the ledger. A sufficiently motivated
observer with direct ledger access (not through the contract API) may still read the raw
bytes. Contract-private is access control, not cryptographic privacy. For true secrecy,
keep data in private state or commit hashes of private data.

### How They Interact During Circuit Execution

When a user calls a circuit, the three state domains converge:

```
User's Device                          Chain
+------------------+                   +------------------+
| Private State    |                   | Public Ledger    |
| - secretKey      |                   | - totalSupply    |
| - commitmentNonce|                   | - paused         |
+--------+---------+                   | - admin          |
         |                             +--------+---------+
         v                                      |
+------------------+                             |
| Witness runs     |                             |
| (off-chain,      |                             |
|  unverified)     |                             |
+--------+---------+                             |
         |                                       |
         v                                       v
+------------------------------------------------+
| Circuit Execution (ZK proof generated)          |
| - Reads public ledger state                     |
| - Reads witness outputs (private inputs)        |
| - Reads contract-private ledger state           |
| - Computes over all inputs                      |
| - Produces: ZK proof + public outputs + tx      |
+------------------------------------------------+
         |
         v
+------------------+
| Submitted to     |
| chain: proof +   |
| public outputs   |
| (no private data)|
+------------------+
```

The circuit sees everything. The chain sees only proof and public outputs.

## 2. The ZK Proof Flow

### End-to-End Execution

Every circuit call follows this sequence:

1. **User calls circuit** via TypeScript SDK
2. **Witnesses execute** off-chain, providing private inputs from user's local state
3. **Circuit computes** over public ledger state + private witness inputs
4. **ZK proof generated** by the proof server (client-side)
5. **Proof + public outputs submitted** to the chain as a transaction
6. **Chain verifies proof** -- valid proof means the circuit logic was followed correctly

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger commitmentCount: Counter;
export ledger commitments: Map<Bytes<32>, Boolean>;

// Witness: user provides their secret off-chain
witness getSecret(): Bytes<32>;

export circuit commitSecret(): [] {
  // Step 1: Witness provides secret (private, never on-chain)
  const secret = getSecret();

  // Step 2: Compute commitment (ZK circuit -- all intermediate values hidden)
  const commitment = persistentHash<Vector<1, Bytes<32>>>([secret]);

  // Step 3: Write to public ledger (only the hash is disclosed)
  commitments.insert(disclose(commitment), true);
  commitmentCount.increment(1);
}
```

### What the Proof Proves

The ZK proof is a mathematical guarantee:

> "I know private inputs (witness values) that, when processed through this exact circuit
> logic, produce these specific public outputs and ledger state changes."

The verifier (every node on the chain) checks:
- The proof is valid for this specific circuit
- The public outputs match the claimed state changes
- The circuit constraints were satisfied

### What Remains Hidden

After the proof is verified and the transaction is on-chain, the following are **never
revealed**:

- All witness return values (the raw private inputs)
- All intermediate computation within the circuit
- Private state reads and writes
- Which specific branch was taken in `if` statements (unless the branch affects
  public state differently -- see Section 8 on privacy leaks)
- The relationship between private inputs and public outputs (beyond what the
  outputs themselves reveal)

```compact
export circuit proveEligibility(): [] {
  const age = getAge();             // HIDDEN: actual age
  const income = getIncome();       // HIDDEN: actual income
  const score = age * 2 + income;   // HIDDEN: intermediate calculation

  // Only this boolean is revealed: "eligible or not"
  assert(disclose(score > 100), "Not eligible");
  eligible.insert(disclose(publicKey(getSecretKey())), true);
}
```

In this example, the chain learns that someone is eligible and their public key. It
learns nothing about their age, income, or how the score was calculated.

## 3. Disclosure Rules

`disclose()` is the boundary between private and public. Every call to `disclose()` is
an explicit, irreversible decision to make a value visible on-chain.

### When `disclose()` Is Required

**Ledger writes:** Any value written to an `export ledger` field must be disclosed.

```compact
export ledger owner: Bytes<32>;

export circuit setOwner(): [] {
  const sk = getSecretKey();
  // REQUIRED: value is being written to public ledger
  owner = disclose(publicKey(sk));
}
```

**Assertions affecting public state:**

```compact
export circuit withdraw(): [] {
  const caller = publicKey(getSecretKey());
  // REQUIRED: boolean result controls public state change
  assert(disclose(caller == owner), "Not owner");
  balance.decrement(1);
}
```

**Conditionals affecting public state:**

```compact
export circuit conditionalUpdate(threshold: Uint<64>): [] {
  const secret = getPrivateValue();
  // REQUIRED: branch outcome affects public ledger
  if (disclose(secret > threshold)) {
    counter.increment(1);
  }
}
```

### When `disclose()` Is NOT Needed

**Pure circuit computation with no public effect:**

```compact
circuit computeInternally(): Bytes<32> {
  const a = getValueA();
  const b = getValueB();
  // No disclose needed -- result stays within circuit, no ledger write
  return persistentHash<Vector<2, Bytes<32>>>([a, b]);
}
```

**Witness-only values used for internal branching with identical public outcomes:**

```compact
export circuit process(): [] {
  const mode = getMode();
  // Both branches produce the same public effect -- no disclosure needed
  if (mode == 1) {
    counter.increment(computeA());
  } else {
    counter.increment(computeB());
  }
  // WARNING: only safe if computeA() and computeB() always produce the same
  // increment amount. If they differ, the chain learns which branch was taken
  // from the counter change, and the compiler will require disclose().
}
```

**Reading contract-private (non-exported) ledger fields:**

```compact
ledger internalThreshold: Uint<64>;    // not exported

export circuit checkThreshold(): [] {
  const val = getPrivateValue();
  // internalThreshold is contract-private, not public
  // But if the assert result affects public state, disclose is still needed
  assert(disclose(val > internalThreshold), "Below threshold");
}
```

### The Privacy Cost of Each Disclosure

Think of each `disclose()` as a one-way door. Once a value is disclosed, it is
permanently on-chain. Consider the information each disclosure reveals:

| Disclosure | What the chain learns |
|---|---|
| `disclose(publicKey(sk))` | Caller's public key (identity linkable if reused) |
| `disclose(amount)` | Exact transfer amount |
| `disclose(a == b)` | Whether two values are equal (but not what they are) |
| `disclose(score > 100)` | Score exceeds threshold (but not exact score) |
| `disclose(hash)` | Commitment value (hides preimage) |

**Design principle:** Disclose the minimum necessary. Prefer disclosing booleans or
hashes over raw values.

```compact
// BAD: discloses the actual vote
votes.insert(disclose(publicKey(sk)), disclose(myVote));

// BETTER: disclose only a commitment, reveal vote later in tallying phase
const commitment = persistentHash<Vector<2, Bytes<32>>>([myVote, nonce]);
commitments.insert(disclose(publicKey(sk)), disclose(commitment));
```

## 4. Witness Security Model

### Trust Boundary

This is the most critical security concept in Midnight:

- **Circuit code is enforced** -- the ZK proof guarantees every circuit instruction
  executed correctly. No one can fake circuit logic.
- **Witness code is trusted** -- witnesses run off-chain with no proof. The contract
  trusts whatever the witness returns.

```
+--------------------------------------------+
|  VERIFIED (ZK-proven)                      |
|                                            |
|  circuit transfer(): [] {                  |
|    const amount = getAmount();  <--------- | -- trust boundary
|    assert(disclose(amount > 0), "...");     |
|    balance.decrement(amount);              |
|  }                                         |
+--------------------------------------------+

+--------------------------------------------+
|  UNVERIFIED (runs locally, no proof)       |
|                                            |
|  witnesses = {                             |
|    getAmount: ({ privateState }) =>        |
|      [privateState, privateState.amount]   |  <-- could return anything
|  }                                         |
+--------------------------------------------+
```

### What a Malicious Witness Can Do

A tampered witness can return **any value of the correct type**. The circuit will
process it as if it were legitimate.

```typescript
// Honest witness
getAmount: ({ privateState }) => [privateState, privateState.amount],

// Malicious witness -- returns max amount regardless of actual balance
getAmount: ({ privateState }) => [privateState, BigInt(2) ** BigInt(64) - BigInt(1)],
```

**However**, a malicious witness can only hurt the user who runs it. The circuit's
assertions and ledger operations still execute correctly:

- If the circuit checks `amount <= balance`, the proof will fail if the malicious
  amount exceeds the on-chain balance
- If the circuit writes to ledger, the state transition is still valid per the
  circuit logic
- Other users' private state and funds are never affected

### Who Can Be Hurt

| Scenario | Affected party |
|---|---|
| User runs modified witness | Only that user |
| Malicious dApp serves bad witness code | Users of that dApp |
| Witness returns out-of-range value | Circuit assertion catches it (if present) |
| Witness lies about private state | User's local state becomes inconsistent |

### Defensive Circuit Design

Never trust a witness value without circuit-level validation:

```compact
witness getTransferAmount(): Uint<64>;

export circuit transfer(): [] {
  const amount = getTransferAmount();

  // DEFENSIVE: validate witness output in the circuit
  assert(disclose(amount > 0), "Amount must be positive");
  assert(disclose(amount <= 1000), "Amount exceeds maximum");

  // Now safe to use -- these constraints are ZK-proven
  balance.decrement(disclose(amount));
}
```

```compact
// BAD: trusts witness to return the correct owner key
witness getOwnerKey(): Bytes<32>;

export circuit dangerousSetOwner(): [] {
  owner = disclose(publicKey(getOwnerKey()));
  // Anyone can set themselves as owner by modifying the witness
}

// GOOD: verify caller identity against on-chain state
witness getSecretKey(): Bytes<32>;

export circuit safeAction(): [] {
  const caller = publicKey(getSecretKey());
  assert(disclose(caller == owner), "Not authorized");
  // Caller proved they know the secret key corresponding to the stored owner
}
```

## 5. Identity and Anonymity

### ZswapCoinPublicKey

Midnight uses `ZswapCoinPublicKey` for wallet identity. By design, these keys are
**unlinkable** -- the Zswap protocol ensures that different transactions from the same
wallet cannot be correlated by an observer.

```compact
// Get the caller's public key (provided by the wallet)
const callerKey: ZswapCoinPublicKey = ownPublicKey();
```

**Unlinkability means:** If user A calls `circuit1()` and then `circuit2()`, an observer
cannot determine that the same wallet made both calls -- unless the contract logic
itself creates a link (e.g., by storing the key in public ledger state).

### `ownPublicKey()` -- Caller Identity

`ownPublicKey()` returns the `ZswapCoinPublicKey` of the transaction sender. It is the
primary mechanism for caller identification within circuits.

```compact
export ledger members: Map<Bytes<32>, Boolean>;

export circuit register(): [] {
  // ownPublicKey() is the caller's wallet key
  // Storing it in public ledger DOES link this registration to this key
  const keyHash = persistentHash<Vector<1, ZswapCoinPublicKey>>([ownPublicKey()]);
  members.insert(disclose(keyHash), true);
}
```

**Privacy implication:** `ownPublicKey()` itself is private within the circuit. It only
becomes public if you `disclose()` it or a derivative of it.

### Secret Key Derivation Pattern

For contracts that need persistent user identity separate from the wallet key, the
standard pattern derives a per-contract secret key from the user's private state:

```compact
witness localSecretKey(): Bytes<32>;

export circuit register(): [] {
  const sk = localSecretKey();
  const pk = publicKey(sk);

  // Store derived public key -- this is a contract-specific identity
  owner = disclose(pk);
}
```

```typescript
// TypeScript: derive a deterministic key per contract using domain separation
export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, PrivateState>):
    [PrivateState, Uint8Array] => {
    // Domain separator ensures different keys for different contracts
    const domainSeparator = new TextEncoder().encode("my-contract-v1");
    const material = new Uint8Array([...domainSeparator, ...privateState.masterSeed]);
    const derived = sha256(material);  // deterministic derivation
    return [privateState, derived];
  },
};
```

**Why domain separation matters:** Without it, the same secret key would be used across
contracts, allowing cross-contract identity linking. The domain separator creates an
independent identity per contract.

### Privacy of Transaction Participants

| What an observer sees | What remains hidden |
|---|---|
| A transaction was submitted | Who submitted it |
| The proof is valid for circuit X | Which wallet created the proof |
| Public ledger state changed | The private inputs that caused the change |
| Shielded coins moved (Zswap) | Sender, receiver, and amount |

**Exception:** If the circuit itself stores `ownPublicKey()` or a wallet identifier in
public state, the caller is de-anonymized for that transaction.

## 6. Shielded Tokens

### Coin Model

Midnight's shielded tokens use a UTXO-based coin model (via Zswap). Shielded coins have:

- **Hidden owners** -- the coin's owner is not visible on-chain
- **Hidden amounts** -- the coin's value is not visible on-chain
- **On-chain locations** -- coins exist at ledger positions unknown to the creator

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export circuit mintAndSend(
  recipientKey: ZswapCoinPublicKey,
  amount: Uint<64>
): [] {
  // Mint a new shielded token
  const domainSep = pad(32, "myToken");
  const nonce = getUniqueNonce();
  mintToken(domainSep, disclose(amount), disclose(nonce), recipientKey);
}

export circuit transferToken(
  coin: CoinInfo,
  recipientKey: ZswapCoinPublicKey,
  amount: Uint<64>
): [] {
  receive(coin);                                    // accept coin into contract
  sendImmediate(coin, recipientKey, amount);         // send to recipient
}

export circuit getTokenType(): Bytes<32> {
  return tokenType(pad(32, "myToken"), kernel.self());
}
```

### Location Semantics

Once minted, a coin exists at a ledger location that is deterministic but opaque:

- The **creator does not know** the coin's on-chain location after creation
- The **recipient** can find their coins using their private key to scan the chain
- This is analogous to stealth addresses -- the sender cannot track the coin after
  sending it

### Spend Rules and the Custody Boundary

This is a critical design consideration:

> Once a shielded coin leaves a contract's custody, the contract's rules no longer
> apply to that coin.

```compact
// Contract enforces transfer limits while coin is inside the contract
export circuit controlledTransfer(
  coin: CoinInfo,
  recipient: ZswapCoinPublicKey,
  amount: Uint<64>
): [] {
  assert(disclose(amount <= 1000), "Exceeds daily limit");
  receive(coin);
  sendImmediate(coin, recipient, amount);
  // After sendImmediate, the contract has no further control over this coin.
  // The recipient can transfer it freely without any daily limit.
}
```

**Implication for contract design:** If you need ongoing control over token behavior
(e.g., compliance rules, transfer restrictions), you must keep the tokens within the
contract and mediate all transfers through circuits. Once coins are sent to a wallet,
they are free.

### EXPERIMENTAL Status

**OpenZeppelin's ShieldedToken module is marked "DO NOT USE IN PRODUCTION."**

The reason: there is no mechanism to enforce custom spend logic on shielded coins once
they leave the issuing contract. This means:

- A compliance token with transfer restrictions can be circumvented once shielded
  coins are withdrawn
- Programmable token features (blacklists, freeze, clawback) cannot follow shielded
  coins across the Zswap layer
- The Zswap protocol treats all coins of the same type as fungible -- the contract of
  origin has no further say

```compact
// This compliance check only works while tokens are inside the contract
export circuit restrictedTransfer(
  coin: CoinInfo,
  recipient: ZswapCoinPublicKey,
  amount: Uint<64>
): [] {
  // This assertion is enforced here...
  assert(disclose(isWhitelisted(recipient)), "Recipient not whitelisted");
  receive(coin);
  sendImmediate(coin, recipient, amount);
  // ...but the recipient can freely send to non-whitelisted addresses
  // because Zswap does not enforce contract-specific rules
}
```

**Until this is resolved:** Use shielded tokens only where unrestricted post-issuance
transfers are acceptable (e.g., utility tokens, game currencies). Do not use them for
securities, regulated assets, or anything requiring enforceable transfer restrictions.

## 7. Private State Storage

### Where Private State Lives

Private state is stored in LevelDB via the browser's IndexedDB. This is the user's
local, off-chain data.

```typescript
import {
  levelPrivateStateProvider,
} from "@midnight-ntwrk/midnight-js-level-private-state-provider";

// As of recent SDK versions, encryption is REQUIRED
const privateStateProvider = levelPrivateStateProvider({
  privacyStateStoreName: "my-contract-private-state",
  walletProvider,  // provides encryption key from wallet
});
```

### Encryption Requirements

In earlier SDK versions, private state was stored **unencrypted by default**. The
`levelPrivateStateProvider` now requires either a `walletProvider` or an explicit
password to encrypt the stored data.

```typescript
// Option A: wallet-based encryption (recommended)
const provider = levelPrivateStateProvider({
  privacyStateStoreName: "my-dapp-state",
  walletProvider: walletProvider,
});

// Option B: password-based encryption
const provider = levelPrivateStateProvider({
  privacyStateStoreName: "my-dapp-state",
  password: userProvidedPassword,
});
```

### Risks

**Browser cleanup can wipe private state.** If a user clears their browser data,
IndexedDB is deleted, and their private state is gone. This can mean:

- Loss of secret keys derived from private state
- Inability to prove ownership of previously committed values
- Loss of local balances or accumulated private data

**Best practice:** Let users choose their storage provider and implement backup
mechanisms:

```typescript
// Export private state for backup
async function exportPrivateState(provider: PrivateStateProvider): Promise<string> {
  const state = await provider.get("my-contract");
  return JSON.stringify(state);  // user saves this securely
}

// Restore from backup
async function importPrivateState(
  provider: PrivateStateProvider,
  backup: string
): Promise<void> {
  const state = JSON.parse(backup);
  await provider.set("my-contract", state);
}
```

### Design Guidance

- **Never store irreplaceable data solely in private state** without a recovery path
- **Inform users** that clearing browser data can result in permanent loss
- **Consider server-side encrypted backup** for critical private state (user holds
  the decryption key, server holds ciphertext)
- **Use deterministic key derivation** from a seed phrase where possible, so private
  keys can be reconstructed from the wallet

## 8. Common Privacy Leaks

These are patterns that unintentionally reveal private information. Every Compact
contract should be audited for these.

### Leak 1: Hardcoded Constants in Comparisons

When a circuit compares a private value against a hardcoded constant, the constant is
embedded in the compiled circuit (which is public). An observer who reads the circuit
bytecode knows the comparison target.

```compact
// BAD: the number 42 is visible in the compiled circuit
export circuit checkSecret(): [] {
  const secret = getSecret();
  assert(disclose(secret == 42), "Wrong secret");
  // Attacker reads circuit bytecode, sees "42", passes the check
}

// BETTER: compare against a hash stored on-chain during setup
export ledger secretHash: Bytes<32>;

constructor() {
  // Hash of the actual secret, set during deployment
  secretHash = disclose(persistentHash<Vector<1, Bytes<32>>>([getSecret()]));
}

export circuit checkSecret(): [] {
  const secret = getSecret();
  const hash = persistentHash<Vector<1, Bytes<32>>>([secret]);
  assert(disclose(hash == secretHash), "Wrong secret");
  // Attacker sees only the hash comparison -- cannot reverse to find the secret
}
```

### Leak 2: Ledger Operation Patterns

Even when values are private, the **pattern** of ledger operations can leak
information. An observer can see which ledger keys are written, how many operations
occur, and when.

```compact
// BAD: number of insert operations reveals vote distribution
export circuit vote(): [] {
  const choice = getVoteChoice();
  if (disclose(choice == 0)) {
    votesForA.increment(1);    // observer sees increment on votesForA
  } else {
    votesForB.increment(1);    // observer sees increment on votesForB
  }
  // Each individual vote's target is visible from which counter changed
}

// BETTER: use a commitment scheme, tally later
export ledger commitments: Map<Bytes<32>, Bytes<32>>;

export circuit vote(): [] {
  const choice = getVoteChoice();
  const nonce = getNonce();
  const commitment = persistentHash<Vector<2, Bytes<32>>>([choice, nonce]);
  const voterKey = persistentHash<Vector<1, Bytes<32>>>([publicKey(getSecretKey())]);
  commitments.insert(disclose(voterKey), disclose(commitment));
  // All votes look the same -- just a hash stored against a key
}
```

### Leak 3: Timing and Circuit Complexity

Different code paths through a circuit can have different proving times. If path A
takes 2 seconds to prove and path B takes 5 seconds, an observer measuring transaction
submission timing can infer which path was taken.

```compact
// RISKY: vastly different computation per branch
export circuit process(): [] {
  const mode = getMode();
  if (disclose(mode == 1)) {
    // Simple path -- fast proof
    counter.increment(1);
  } else {
    // Complex path with many hash operations -- slow proof
    const h1 = persistentHash<Vector<1, Bytes<32>>>([getData()]);
    const h2 = persistentHash<Vector<1, Bytes<32>>>([h1]);
    const h3 = persistentHash<Vector<1, Bytes<32>>>([h2]);
    results.insert(disclose(h3), true);
  }
}
```

**Mitigation:** Design circuits so all paths have similar computational complexity, or
accept that the timing difference is an acceptable information leak.

### Leak 4: Transaction Graph Analysis

Even with Zswap's unlinkability, patterns emerge over time:

- **Temporal correlation:** If Alice deposits and Bob withdraws moments later with
  the same amount, the link is probable
- **Amount correlation:** Unique amounts create fingerprints (depositing exactly
  1,337 tokens is distinctive)
- **Interaction patterns:** Repeated interactions between the same contract addresses
  reveal relationships

```compact
// RISKY: unique amounts create linkable transactions
export circuit deposit(): [] {
  const amount = getDepositAmount();
  // If amount is 1337.42, it is trivially linkable to a matching withdrawal
  balance.increment(disclose(amount));
}

// BETTER: use fixed denomination pools (like Tornado Cash)
export circuit depositFixed(): [] {
  const DENOMINATION: Uint<64> = 1000;
  balance.increment(DENOMINATION);
  // All deposits look identical
}
```

**Mitigations:**
- Use fixed denominations where possible
- Add random delays between related transactions (application layer)
- Use multiple intermediary addresses
- Note: Zswap provides base-layer unlinkability, but application-layer patterns
  can undo it

### Privacy Audit Checklist

When reviewing a contract for privacy leaks:

| Check | Question |
|---|---|
| Hardcoded values | Are any secret values or thresholds embedded as literals? |
| Disclosure scope | Is each `disclose()` disclosing the minimum necessary? |
| Ledger patterns | Can an observer distinguish users by which ledger keys change? |
| Branch asymmetry | Do different code paths produce different observable effects? |
| Key reuse | Is the same public key stored in multiple public fields? |
| Amount uniqueness | Are transaction amounts distinctive enough to fingerprint? |
| Temporal patterns | Can timing of transactions reveal relationships? |
| Witness trust | Does the circuit validate all witness inputs it relies on? |
| Private state loss | What happens if the user's browser data is wiped? |

## Summary: Privacy Decision Framework

When designing a Compact contract, evaluate every piece of data against this framework:

```
                    Must other contracts read it?
                           /           \
                         Yes            No
                          |              |
                   export ledger    Must it persist across transactions?
                   (fully public)        /                    \
                                       Yes                    No
                                        |                      |
                              Must the contract's        Keep in private state
                              own circuits read it?      (per-user, off-chain)
                                  /          \
                                Yes           No
                                 |             |
                          ledger (contract-    Witness return value
                          private, on-chain)   (ephemeral, in-circuit only)
```

The tightest privacy comes from keeping data in private state and only exposing
commitments (hashes) to the ledger. The loosest privacy comes from `export ledger`
with raw values. Most contracts need a mix -- the art is minimizing the public surface
while maintaining the contract's functionality.
