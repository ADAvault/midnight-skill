# Security Patterns

## Midnight ZK Security Model

Midnight's privacy-first architecture eliminates several vulnerability classes common
in transparent blockchains:

- **Front-running:** Mitigated. Transaction contents are shielded; observers cannot
  extract trade parameters to front-run.
- **MEV extraction:** Mitigated. Private inputs are not visible to block producers.
- **Balance snooping:** Mitigated. Shielded coins hide amounts and ownership.

However, the ZK/privacy model introduces its own attack surface that every Compact
contract must guard against. The dual-state model (public ledger + private off-chain),
the witness trust boundary, and the circuit compilation model create vulnerability
categories that have no analogue in transparent chains.

## Attack Vectors

### 1. Privacy Leakage

**What:** Private values are unintentionally revealed through direct disclosure,
inference from public state changes, or transaction pattern analysis. In Midnight,
privacy is the core value proposition — any leakage is a critical vulnerability.

**Subtypes:**

**1a. Direct over-disclosure:** Using `disclose()` on values that should remain private.
Every `disclose()` call adds information to the public proof transcript. Developers
often disclose more than necessary for convenience.

**1b. Inference from public constants:** Comparing a private value against a public
constant and branching on the result reveals information. If the branch outcome is
observable (through ledger state changes), an observer can deduce the private value.

**1c. Ledger operation pattern leakage:** Operations like `map.insert()`,
`map.remove()`, and `map.member()` on public ledger state reveal information about
keys being accessed. Even when the values are not disclosed, the pattern of insertions
and removals leaks structural information.

**1d. Transaction graph analysis:** Repeated interactions between the same parties,
timing patterns, and transaction sizes can deanonymize participants even when
individual transactions are shielded.

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger balances: Map<Bytes<32>, Uint<64>>;
export ledger lastAction: Bytes<32>;

witness getSecretThreshold(): Uint<64>;

// BAD — discloses the actual balance, not just whether the check passes
export circuit withdraw(addr: Bytes<32>, amount: Uint<64>): [] {
  const balance = balances.lookup(addr);
  const threshold = getSecretThreshold();
  // Leaks the exact balance to the public ledger
  assert(disclose(balance) >= amount, "Insufficient balance");
  // Leaks which address is acting — linkable across transactions
  lastAction = disclose(addr);
  balances.insert(addr, balance - amount);
}
```

**Exploitation scenario:** An observer watches the public ledger state. Each
`withdraw` call discloses the caller's full balance (not just whether they have
enough) and their address. Over time, the observer builds a complete map of all
balances and links addresses to transaction patterns.

**Mitigation — disclose only boolean results, use transientHash for internal
comparisons:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger balances: Map<Bytes<32>, Uint<64>>;
ledger actionLog: Counter;  // NOT exported — private to contract

witness getSecretThreshold(): Uint<64>;

// GOOD — discloses only the boolean check result, not the values
export circuit withdraw(addr: Bytes<32>, amount: Uint<64>): [] {
  const balance = balances.lookup(addr);
  // Only disclose the comparison result, not the balance itself
  assert(disclose(balance >= amount), "Insufficient balance");
  // Use internal counter instead of leaking address
  actionLog.increment(1);
  balances.insert(addr, balance - amount);
}
```

**Key rules:**
- Wrap only boolean expressions in `disclose()`, never raw values, unless the
  value genuinely must be public.
- Use `transientHash` (Poseidon) for in-circuit comparisons — it is 10x cheaper
  than `persistentHash` (SHA-256) and avoids disclosing raw values.
- Make ledger fields non-exported (`ledger` not `export ledger`) unless external
  read access is required.
- Consider whether ledger Map key patterns reveal private information.

---

### 2. Witness Manipulation

**What:** Witness code runs off-chain in the user's browser and is never verified by
the ZK proof. The circuit proves that *given the witness outputs*, the computation is
correct — but it cannot prove the witness outputs themselves are honest. A malicious
user can replace witness implementations to provide arbitrary private inputs.

**This is the most critical trust boundary in Midnight.** Any validation logic that
exists only in witness code can be bypassed.

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger owner: Bytes<32>;
export ledger balances: Map<Bytes<32>, Uint<64>>;

// Witness returns caller identity — BUT user controls this code
witness getCaller(): Bytes<32>;

// BAD — trusts witness to return the real caller
export circuit adminTransfer(from: Bytes<32>, to: Bytes<32>, amount: Uint<64>): [] {
  const caller = getCaller();
  // This check is useless — attacker's witness returns the owner's key
  assert(disclose(caller == owner), "Not admin");
  const balance = balances.lookup(from);
  balances.insert(from, balance - amount);
  balances.insert(to, amount);
}
```

```typescript
// Attacker's modified witness — returns the admin's public key
export const witnesses = {
  getCaller: ({ privateState }) => {
    // Malicious: return the known admin key instead of own key
    const adminKey = hexToBytes("aabb...the_admin_public_key...");
    return [privateState, adminKey];
  },
};
```

**Exploitation scenario:** The attacker inspects the public ledger to read the
`owner` field, then modifies their local witness to return that value. The circuit
happily proves `caller == owner` is true because the witness fed in the owner's key.
The attacker can now drain any account.

**Mitigation — all critical validation must use circuit-verifiable cryptography:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger owner: Bytes<32>;
export ledger balances: Map<Bytes<32>, Uint<64>>;
ledger nonces: Map<Bytes<32>, Counter>;

witness getSecretKey(): Bytes<32>;

// GOOD — derives public key from secret key inside the circuit
// The user cannot fake the public key without knowing the secret key
export circuit adminTransfer(from: Bytes<32>, to: Bytes<32>, amount: Uint<64>): [] {
  const sk = getSecretKey();
  // publicKey() is computed IN THE CIRCUIT — cannot be faked
  const caller = disclose(publicKey(sk));
  assert(caller == owner, "Not admin");
  const balance = balances.lookup(from);
  assert(disclose(balance >= amount), "Insufficient balance");
  balances.insert(from, balance - amount);
  const toBalance = balances.lookup(to);
  balances.insert(to, toBalance + amount);
}
```

**Key rules:**
- Never trust a witness to return identity — derive public keys from secret keys
  inside the circuit using `publicKey()`.
- Never trust a witness to enforce business rules — all `assert()` and conditional
  logic must be in circuit code.
- Witnesses are input sources only. Treat them like untrusted user input in a web
  application.
- Follow the bboard pattern: witness provides secret key, circuit derives the public
  key and compares against the stored owner.

---

### 3. Circuit Complexity Attacks

**What:** Each Compact circuit compiles to a ZK proof with a complexity parameter `k`.
Higher `k` means exponentially more resources for proof generation. An attacker can
trigger circuits with worst-case inputs to exhaust the proof server's memory and CPU,
causing denial of service.

Ledger operations (`Map.insert`, `Map.remove`, `Map.lookup`, `Set.insert`, etc.) are
especially expensive because they generate Merkle tree operations in the circuit.
Multiple ledger operations in a single circuit multiply the complexity.

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger registry: Map<Bytes<32>, Uint<64>>;

// BAD — O(n) ledger operations in a loop-like pattern
// Each insert/lookup is a Merkle tree operation, k grows fast
export circuit batchRegister(
  addr1: Bytes<32>, val1: Uint<64>,
  addr2: Bytes<32>, val2: Uint<64>,
  addr3: Bytes<32>, val3: Uint<64>,
  addr4: Bytes<32>, val4: Uint<64>,
  addr5: Bytes<32>, val5: Uint<64>
): [] {
  // 5 lookups + 5 inserts = 10 Merkle tree operations
  // k value will be very high, proof generation extremely slow
  registry.insert(addr1, registry.lookup(addr1) + val1);
  registry.insert(addr2, registry.lookup(addr2) + val2);
  registry.insert(addr3, registry.lookup(addr3) + val3);
  registry.insert(addr4, registry.lookup(addr4) + val4);
  registry.insert(addr5, registry.lookup(addr5) + val5);
}
```

**Exploitation scenario:** An attacker calls `batchRegister` with inputs designed
to maximize proof generation time. If the proof server is shared (as in early
Midnight deployments), this degrades service for all users. Even with a dedicated
proof server, the circuit may take minutes to prove, making the dApp unusable.

**Mitigation — minimize ledger operations per circuit, use internal circuits:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger registry: Map<Bytes<32>, Uint<64>>;

// Internal circuit — lower overhead, no external proof generation
circuit doRegister(addr: Bytes<32>, val: Uint<64>): [] {
  registry.insert(addr, registry.lookup(addr) + val);
}

// GOOD — single ledger operation per external circuit call
// Users call this multiple times instead of one bloated circuit
export circuit register(addr: Bytes<32>, val: Uint<64>): [] {
  doRegister(addr, val);
}
```

**Key rules:**
- Limit ledger operations to 2-3 per circuit. Each Map/Set operation adds
  significant circuit complexity.
- Use internal (non-exported) circuits to factor out reusable logic — they add
  less overhead than duplicating operations.
- Profile `k` values during development using `compact compile` output.
  A `k` above 20 is a warning sign; above 25 will cause proof server timeouts.
- Avoid patterns that would be loops in other languages — Compact has no loops,
  but unrolled repetition has the same complexity cost.
- Consider splitting complex multi-step operations across multiple transactions
  using a state machine pattern.

---

### 4. State Manipulation

**What:** When multiple users submit transactions that interact with the same contract
ledger state concurrently, race conditions can occur. Midnight processes transactions
sequentially within a block, but the order is not controlled by the contract.
A circuit reads state at proof-generation time, but the state may change before the
transaction is included in a block.

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger pool: Counter;
export ledger lastDepositor: Bytes<32>;

witness getSecretKey(): Bytes<32>;

// BAD — non-atomic read-then-write with no sequencing
export circuit deposit(amount: Uint<64>): [] {
  const sk = getSecretKey();
  const depositor = disclose(publicKey(sk));
  // Read current pool value (captured at proof generation time)
  const current = pool.read();
  // By the time this transaction lands, 'current' may be stale
  // Another deposit may have changed pool between read and write
  lastDepositor = depositor;
  pool.increment(amount as Field);
}

// BAD — withdraw trusts a stale read
export circuit withdraw(amount: Uint<64>): [] {
  const sk = getSecretKey();
  const depositor = disclose(publicKey(sk));
  assert(depositor == lastDepositor, "Not last depositor");
  // Race: someone else may deposit between this proof and inclusion
  pool.decrement(amount as Field);
}
```

**Exploitation scenario:** Alice and Bob both call `deposit` at roughly the same time.
Alice's transaction is included first, setting `lastDepositor = Alice`. Bob's
transaction overwrites it to `lastDepositor = Bob`. Now only Bob can withdraw, but
the pool contains both deposits. If Alice used the `withdraw` circuit, her proof
was generated with stale state (`lastDepositor` was still her key at proof time)
and the transaction fails on-chain.

**Mitigation — use atomic operations within single circuits, add sequence counters:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger pool: Counter;
export ledger depositors: Map<Bytes<32>, Uint<64>>;
export ledger sequence: Counter;

witness getSecretKey(): Bytes<32>;

// GOOD — each user's balance is tracked independently, no shared mutable state
export circuit deposit(amount: Uint<64>): [] {
  const sk = getSecretKey();
  const depositor = disclose(publicKey(sk));
  const existing = depositors.lookup(depositor);
  depositors.insert(depositor, existing + amount);
  pool.increment(amount as Field);
  sequence.increment(1);
}

// GOOD — withdraw only touches the caller's own balance
export circuit withdraw(amount: Uint<64>): [] {
  const sk = getSecretKey();
  const depositor = disclose(publicKey(sk));
  const balance = depositors.lookup(depositor);
  assert(disclose(balance >= amount), "Insufficient balance");
  depositors.insert(depositor, balance - amount);
  pool.decrement(amount as Field);
  sequence.increment(1);
}
```

**Key rules:**
- Design state so each user operates on independent data (per-user Map entries)
  rather than a single shared variable.
- Use `Counter` for values that must be atomically incremented/decremented — the
  protocol handles counter contention more gracefully than overwrites.
- Add sequence counters to detect stale proofs — the proof server can re-prove
  if the sequence has advanced since the original proof.
- Keep all related state changes within a single circuit call to maintain atomicity.
- Understand that ledger state read during proof generation may differ from state
  at block inclusion time.

---

### 5. Token/Coin Security

**What:** Midnight's Zswap protocol supports shielded coins (private amounts and
ownership) and unshielded coins (public). A critical design property: once a coin
leaves a contract via `sendImmediate()`, it becomes a general-purpose coin and is
no longer subject to the contract's rules. This means contract-enforced constraints
(vesting schedules, transfer limits, etc.) cannot survive a shielded transfer.

Additionally, total supply guarantees are impossible for shielded tokens because
individual coin balances are hidden.

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger totalSupply: Counter;
ledger vestingEnd: Uint<64>;

witness getSecretKey(): Bytes<32>;
witness getRecipient(): ZswapCoinPublicKey;

// BAD — sends coins out of contract, losing all vesting enforcement
export circuit claimVested(amount: Uint<64>): [] {
  const sk = getSecretKey();
  const caller = disclose(publicKey(sk));
  const recipient = getRecipient();
  const coin = tokenType(pad(32, "VESTED"), kernel.self());
  // Once sent, recipient can freely transfer — vesting is gone
  sendImmediate(coin, left<ZswapCoinPublicKey, ContractAddress>(recipient), amount);
  totalSupply.decrement(amount as Field);
}

// BAD — assumes totalSupply accurately reflects all tokens in existence
export circuit checkSupply(): Uint<64> {
  // Shielded coins that left the contract are not tracked here
  return totalSupply.read() as Uint<64>;
}
```

**Exploitation scenario:** A token with a 1-year vesting schedule mints coins into
the contract. The `claimVested` circuit sends coins to the user's wallet. Once in the
wallet, the coins are standard shielded coins — the user can immediately transfer
them to anyone, completely bypassing the vesting schedule. The `totalSupply` counter
also becomes inaccurate because it cannot track shielded transfers outside the
contract.

**Mitigation — keep programmable tokens inside the contract, use unshielded for
rule enforcement:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger balances: Map<Bytes<32>, Uint<64>>;
export ledger vestingSchedule: Map<Bytes<32>, Uint<64>>;
export ledger currentEpoch: Counter;

witness getSecretKey(): Bytes<32>;

// GOOD — tokens stay inside the contract where rules are enforced
export circuit transfer(to: Bytes<32>, amount: Uint<64>): [] {
  const sk = getSecretKey();
  const caller = disclose(publicKey(sk));
  const callerBalance = balances.lookup(caller);

  // Vesting check is enforced by the circuit — cannot be bypassed
  const vestingEpoch = vestingSchedule.lookup(caller);
  const epoch = currentEpoch.read();
  assert(disclose(epoch >= vestingEpoch as Field), "Still vesting");
  assert(disclose(callerBalance >= amount), "Insufficient balance");

  balances.insert(caller, callerBalance - amount);
  const toBalance = balances.lookup(to);
  balances.insert(to, toBalance + amount);
}

// GOOD — only allow withdrawal after vesting, and accept that supply
// tracking ends once coins leave the contract
export circuit withdrawVested(amount: Uint<64>): [] {
  const sk = getSecretKey();
  const caller = disclose(publicKey(sk));
  const vestingEpoch = vestingSchedule.lookup(caller);
  const epoch = currentEpoch.read();
  assert(disclose(epoch >= vestingEpoch as Field), "Still vesting");
  // Explicitly documented: coins leaving contract lose programmability
  const callerBalance = balances.lookup(caller);
  assert(disclose(callerBalance >= amount), "Insufficient balance");
  balances.insert(caller, callerBalance - amount);
}
```

**Key rules:**
- Prefer in-contract balance tracking (`Map<Bytes<32>, Uint<64>>`) over shielded
  coin transfers when you need to enforce rules on tokens.
- Use `sendImmediate()` only for final withdrawal after all conditions are met.
- Accept that total supply accounting is approximate once coins are shielded and
  leave the contract.
- For tokens that need strict supply control, keep all balances in contract ledger
  state (unshielded tracking with private amounts via non-exported ledger).
- Document clearly to users which operations cause coins to leave contract
  governance.

---

### 6. Authentication Bypass

**What:** Circuits that fail to properly verify caller identity allow unauthorized
access. Common mistakes include: missing owner checks entirely, using weak key
derivation with predictable domain separators, and omitting sequence numbers in
key derivation (enabling replay attacks).

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger owner: Bytes<32>;
export ledger data: Bytes<32>;

witness getSecretKey(): Bytes<32>;

// BAD — no authentication at all
export circuit updateData(newData: Bytes<32>): [] {
  data = newData;
}

// BAD — weak key derivation, predictable domain separator, no sequence
export circuit weakAuth(newData: Bytes<32>): [] {
  const sk = getSecretKey();
  // Domain separator is just the contract name — same across all instances
  const key = persistentHash<Vector<1, Bytes<32>>>([sk]);
  assert(disclose(key == owner), "Not owner");
  data = newData;
}
```

**Exploitation scenario (missing auth):** Anyone can call `updateData` and overwrite
contract state. There is no check that the caller is authorized.

**Exploitation scenario (weak auth):** The key derivation uses only the secret key
with no domain separator or sequence number. If the same secret key is used across
contracts (common with wallet-derived keys), the derived key is identical — an
attacker who compromises auth on one contract can replay against all contracts
using the same derivation.

**Mitigation — follow the bboard pattern with domain separator and sequence counter:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger owner: Bytes<32>;
export ledger data: Bytes<32>;
ledger nonce: Counter;

witness getSecretKey(): Bytes<32>;

// GOOD — follows bboard canonical auth pattern
constructor() {
  const sk = getSecretKey();
  // Domain separator + contract address + initial nonce = unique key
  const domainSep = pad(32, "myApp.owner.v1");
  const contractAddr = kernel.self() as Bytes<32>;
  const keyHash = persistentHash<Vector<3, Bytes<32>>>(
    [domainSep, contractAddr, sk]
  );
  owner = disclose(keyHash);
  nonce.increment(1);
}

// GOOD — proper authentication with anti-replay
export circuit updateData(newData: Bytes<32>): [] {
  const sk = getSecretKey();
  const domainSep = pad(32, "myApp.owner.v1");
  const contractAddr = kernel.self() as Bytes<32>;
  const keyHash = persistentHash<Vector<3, Bytes<32>>>(
    [domainSep, contractAddr, sk]
  );
  assert(disclose(keyHash == owner), "Not owner");
  // Nonce increment prevents proof replay
  nonce.increment(1);
  data = newData;
}
```

**Key rules:**
- Every state-modifying circuit must authenticate the caller.
- Use the bboard pattern: `persistentHash([domainSeparator, contractAddress, secretKey])`.
- Include `kernel.self()` (contract address) in the hash to prevent cross-contract
  replay.
- Include a domain separator string to prevent cross-purpose key reuse within the
  same contract.
- Increment a nonce counter in every authenticated circuit to prevent proof replay.
- Use `publicKey()` when you need the actual public key for external verification;
  use hash-based auth when you only need to verify ownership internally.

---

### 7. Integer and Field Arithmetic

**What:** Compact's numeric types have several sharp edges. The `Field` type
represents a finite field element, and overflow behavior is currently broken —
arithmetic on `Field` values can produce silently incorrect results when values
exceed the field modulus. There is no modulo operator. `Uint<N>` is limited to
`N <= 128` (no `Uint<256>` support). Unchecked arithmetic can lead to logic
errors, fund loss, or bypassed constraints.

**Example vulnerable code:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger balance: Counter;

// BAD — Field arithmetic overflow is broken
export circuit addReward(amount: Field): [] {
  // If balance.read() + amount overflows the field, result wraps
  // silently to an incorrect value
  const newBalance = balance.read() + amount;
  // This assertion may pass with a wrapped value
  assert(disclose(newBalance > balance.read()), "Overflow");
  balance.increment(amount);
}

// BAD — no bounds checking on Uint
export circuit transferUint(amount: Uint<64>): [] {
  // If amount is 0, this succeeds but does nothing useful
  // If internal math exceeds Uint<64> max, behavior is undefined
  const fee = amount / 100 as Uint<64>;  // Integer division truncates
  const net = amount - fee;
  // No check that net + fee == amount (rounding may lose dust)
}
```

**Exploitation scenario:** An attacker provides an `amount` value that, when added
to the current balance, causes a field overflow. The balance wraps to a small number,
effectively destroying funds. Alternatively, the attacker exploits integer division
truncation to transfer more value than they should (rounding errors accumulate
across many transactions).

**Mitigation — use Uint types with explicit bounds checking, avoid Field arithmetic:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger balance: Counter;
export ledger balanceMap: Map<Bytes<32>, Uint<64>>;

// GOOD — use Uint with explicit bounds, avoid Field for accounting
export circuit addReward(amount: Uint<64>): [] {
  const currentRaw = balance.read();
  // Bounds check BEFORE arithmetic
  // Using Uint<64> for the amount ensures it fits
  assert(disclose(amount > 0 as Uint<64>), "Zero amount");
  // Use Counter.increment which handles the internal Field arithmetic
  balance.increment(amount as Field);
}

// GOOD — explicit rounding accounting
export circuit transferWithFee(
  from: Bytes<32>,
  to: Bytes<32>,
  amount: Uint<64>
): [] {
  assert(disclose(amount >= 100 as Uint<64>), "Minimum transfer is 100");
  const fee = amount / 100 as Uint<64>;
  const net = amount - fee;
  // Verify no rounding loss: net + fee must equal amount
  assert(disclose(net + fee == amount), "Rounding error");

  const fromBal = balanceMap.lookup(from);
  assert(disclose(fromBal >= amount), "Insufficient balance");
  balanceMap.insert(from, fromBal - amount);

  const toBal = balanceMap.lookup(to);
  balanceMap.insert(to, toBal + net);
}
```

**Key rules:**
- **Avoid raw `Field` arithmetic for accounting or business logic.** The field
  overflow bug (as of Compact 0.20) produces silent incorrect results. Use
  `Uint<N>` types instead.
- **No `Uint<256>`** — the maximum is `Uint<128>`. Design around this constraint.
- **No modulo operator** — if you need modular arithmetic, implement it via
  division and multiplication: `a % b == a - (a / b) * b` (but beware truncation).
- Always validate that amounts are non-zero and within expected ranges before
  arithmetic operations.
- Use `Counter` for ledger-backed accumulators — it handles Field internals more
  safely than manual arithmetic.
- Verify conservation: `sum of debits == sum of credits` in every transfer circuit.
- Use bounded integer types (`Uint<MIN..MAX>`) where the valid range is known.

---

### 8. Cross-Contract Risks

**What:** As of Compact 0.20, Midnight does not support contract-to-contract calls.
Contracts cannot invoke circuits on other contracts. This limits composability but
also eliminates reentrancy attacks. However, this limitation shapes contract design
in important ways, and future cross-contract support will introduce new risks.

**Current risks:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

// BAD — trying to "compose" contracts by sharing state off-chain
// Contract A stores a reference to Contract B's address
export ledger oracleContract: ContractAddress;

// This circuit CANNOT call oracleContract to get a price
// The developer may try to work around this with witnesses,
// but that moves trust off-chain
witness getOraclePrice(): Uint<64>;

export circuit swap(amount: Uint<64>): [] {
  // This price comes from an unverified witness, not from
  // a verified oracle contract circuit
  const price = getOraclePrice();
  // All math based on potentially fake price
}
```

**Exploitation scenario (current):** Without cross-contract calls, developers use
witnesses to bridge data between contracts. The witness fetches data from Contract B
and provides it to Contract A's circuit. But the witness is unverified — an attacker
can return any price, bypassing the oracle entirely.

**Future risks (when cross-contract calls arrive):**
- Reentrancy patterns may emerge if Contract A calls Contract B which calls back
  into Contract A.
- State inconsistency if a cross-contract call fails partway through.
- Complexity explosion as multiple contracts' circuits are composed.

**Mitigation — design for current limitations, plan for future:**

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

// GOOD — use commit-verify pattern instead of cross-contract calls
// Oracle publishes a signed commitment, consumer verifies in-circuit
export ledger oracleCommitment: Bytes<32>;
export ledger oracleOwner: Bytes<32>;

witness getOracleData(): Bytes<32>;
witness getOracleSignature(): Bytes<32>;

// Verify oracle data against a known commitment
// This is the best current workaround for cross-contract data
export circuit useOracleData(expectedPrice: Uint<64>): [] {
  const data = getOracleData();
  // Verify the data matches the commitment stored by the oracle
  const commitment = persistentHash<Vector<1, Bytes<32>>>([data]);
  assert(disclose(commitment == oracleCommitment), "Invalid oracle data");
}
```

**Key rules:**
- Accept the current limitation: no contract-to-contract calls.
- Use commit-verify patterns for cross-contract data: one contract stores a hash
  commitment, the other verifies data against it.
- Avoid witness-based bridges for critical data — the witness is unverified.
- When cross-contract calls become available, audit all existing patterns that
  assumed isolation. Reentrancy guards will become necessary.
- Monitor Compact release notes — cross-contract calls are on the roadmap and
  will change the security model significantly.

---

### 9. Private State Loss

**What:** Midnight's private state (the user's off-chain data, including secret keys,
private balances, and local contract state) is stored in the browser's local storage
by default. This storage is unencrypted, vulnerable to browser cleanup, and has no
built-in recovery mechanism. Lost private state means permanently lost access to
contract interactions and potentially lost funds.

**Example vulnerable setup:**

```typescript
// BAD — default browser storage with no backup or encryption
import { IndexedDBPrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";

const provider = new IndexedDBPrivateStateProvider();
// Private state stored in browser IndexedDB
// - Cleared by "Clear browsing data"
// - No encryption at rest
// - No sync across devices
// - No recovery mechanism

const contract = new Contract<PrivateState>(witnesses);
const { currentPrivateState } = contract.initialState(
  createConstructorContext(privateState, walletSeed)
);
// If the user clears their browser, privateState is gone
// The user can never interact with this contract again
```

**Exploitation scenario:** A user deploys a contract and interacts with it for weeks.
Their browser auto-clears storage (privacy settings, storage quota exceeded, or
manual cleanup). The private state, including the secret key used in the contract's
owner hash, is permanently lost. The contract's funds are locked forever because
no one can produce a valid proof without the secret key.

More insidiously, an attacker with local access to the machine can read the
unencrypted IndexedDB and extract secret keys.

**Mitigation — encrypted storage, explicit backup, user-controlled providers:**

```typescript
// GOOD — encrypted storage with backup strategy
import { EncryptedStorageProvider } from "./providers/encrypted-storage";

// Encrypt private state with a user-provided passphrase
const provider = new EncryptedStorageProvider({
  // Derive encryption key from passphrase using Argon2
  passphrase: await promptUserPassphrase(),
  // Store encrypted blob in IndexedDB
  backend: "indexeddb",
});

// Backup strategy: export encrypted state
async function backupPrivateState(provider: EncryptedStorageProvider) {
  const encrypted = await provider.export();
  // Offer download as file
  downloadBlob(encrypted, "midnight-backup.enc");
  // Or store in user-chosen cloud provider
  await uploadToUserCloud(encrypted);
}

// Recovery: import from backup
async function restorePrivateState(
  provider: EncryptedStorageProvider,
  backupFile: Uint8Array,
) {
  await provider.import(backupFile);
}

// GOOD — warn users about state criticality
function showStateWarning() {
  console.warn(
    "Your private state contains secret keys. " +
      "If lost, you cannot recover access to your contracts. " +
      "Please create a backup.",
  );
}
```

**Key rules:**
- Never store private state unencrypted in production.
- Implement an explicit backup/restore flow — users must be able to export and
  re-import their private state.
- Warn users clearly that private state loss is permanent and unrecoverable.
- Consider server-side encrypted storage for dApps where UX demands it
  (the user chooses the storage provider; the dApp should not custody keys).
- Test the recovery flow: deploy contract, backup state, clear browser,
  restore state, verify contract interaction still works.
- Use deterministic key derivation from a seed phrase where possible, so that
  keys can be re-derived without a backup (follow HD wallet patterns).

---

### 10. Version Mismatch Vulnerabilities

**What:** Midnight's toolchain has multiple components that must be version-aligned:
the Compact compiler, the SDK (`@midnight-ntwrk/*` npm packages), the proof server,
and the network (devnet/testnet). Version misalignment causes silent failures —
circuits compile but produce invalid proofs, proof servers reject valid proofs,
or transactions fail on-chain with no clear error message.

**Example vulnerable configuration:**

```json
{
  "dependencies": {
    "@midnight-ntwrk/compact-runtime": "0.18.0",
    "@midnight-ntwrk/midnight-js-contracts": "0.20.0",
    "@midnight-ntwrk/midnight-js-types": "0.19.0",
    "@midnight-ntwrk/wallet-api": "0.20.0"
  }
}
```

```bash
# Compiler version does not match SDK version
compact --version   # 0.17.0
# Proof server expects circuits from compiler 0.20.0
# Result: proofs generate but are rejected by the network
```

**Exploitation scenario:** A developer upgrades the SDK packages to 0.20.0 but
forgets to update the Compact compiler. The contract compiles with the old compiler,
producing circuits in the old format. The proof server (version 0.20.0) accepts the
circuits but produces proofs that the new network rejects. All transactions fail
silently — users lose gas fees and the dApp appears broken. In a worse case, a
partially-compatible version combination produces valid-looking proofs that encode
incorrect logic, leading to state corruption.

**Mitigation — strict version pinning and compatibility checks:**

```json
{
  "dependencies": {
    "@midnight-ntwrk/compact-runtime": "0.20.0",
    "@midnight-ntwrk/midnight-js-contracts": "0.20.0",
    "@midnight-ntwrk/midnight-js-types": "0.20.0",
    "@midnight-ntwrk/wallet-api": "0.20.0"
  },
  "scripts": {
    "check-versions": "node scripts/check-midnight-versions.mjs",
    "precompile": "npm run check-versions"
  }
}
```

```typescript
// scripts/check-midnight-versions.mjs
// GOOD — verify all Midnight packages are aligned before compile
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const midnightPackages = Object.entries(pkg.dependencies).filter(([name]) =>
  name.startsWith("@midnight-ntwrk/"),
);

const versions = new Set(midnightPackages.map(([, version]) => version));
if (versions.size > 1) {
  console.error("VERSION MISMATCH in @midnight-ntwrk packages:");
  midnightPackages.forEach(([name, version]) =>
    console.error(`  ${name}: ${version}`),
  );
  console.error("All @midnight-ntwrk packages must use the same version.");
  process.exit(1);
}

// Check compiler version matches SDK
import { execSync } from "child_process";
const compilerVersion = execSync("compact --version").toString().trim();
const sdkVersion = midnightPackages[0][1];
if (!compilerVersion.includes(sdkVersion.replace(/^\^|~/, ""))) {
  console.error(
    `Compiler version (${compilerVersion}) does not match SDK (${sdkVersion})`,
  );
  console.error("Run: compact self update && compact update " + sdkVersion);
  process.exit(1);
}

console.log(`All Midnight versions aligned at ${[...versions][0]}`);
```

**Key rules:**
- Pin all `@midnight-ntwrk/*` packages to the exact same version. Do not use
  `^` or `~` version ranges.
- Update the Compact compiler, SDK packages, and proof server together as a
  single atomic operation.
- Run version compatibility checks in CI before compilation.
- When upgrading, recompile all contracts and re-run the full test suite. Do not
  assume backward compatibility between minor versions.
- Track the Midnight release notes for breaking changes — the platform is
  pre-mainnet and breaking changes are frequent.
- Test against the same network version you will deploy to. A contract that
  passes on devnet may fail on testnet if they run different versions.

---

## Security Checklist

For every Compact contract, verify:

**Privacy:**
- [ ] **Disclosures:** Every `disclose()` call is necessary and minimal
- [ ] **Witness values:** No private values are disclosed unnecessarily
- [ ] **Boolean disclosure:** Comparisons disclose only `true/false`, not operand values
- [ ] **Ledger visibility:** Non-public fields use `ledger` not `export ledger`
- [ ] **Pattern leakage:** Map/Set operations do not reveal private key existence
- [ ] **Transaction patterns:** Repeated interactions are not linkable

**Trust Boundaries:**
- [ ] **Witness trust:** No business logic depends solely on witness correctness
- [ ] **Identity verification:** Caller identity derived via `publicKey(secretKey)` in-circuit
- [ ] **Auth on all mutations:** Every state-modifying circuit authenticates the caller
- [ ] **Replay prevention:** Nonce/sequence counter incremented in every authenticated circuit
- [ ] **Domain separation:** Key derivation includes domain separator and contract address

**Circuit Design:**
- [ ] **Complexity:** `k` value is acceptable (target < 20, hard limit < 25)
- [ ] **Ledger operations:** Maximum 2-3 Map/Set operations per circuit
- [ ] **No unrolled loops:** Repetitive ledger operations are split across transactions
- [ ] **Internal circuits:** Reusable logic factored into non-exported circuits

**State Management:**
- [ ] **Race conditions:** Concurrent access uses per-user state, not shared variables
- [ ] **Counters for contention:** Shared accumulators use `Counter` type
- [ ] **Sequence tracking:** Stale-proof detection via sequence counters
- [ ] **Atomic operations:** Related state changes are in a single circuit

**Tokens and Coins:**
- [ ] **Rule enforcement:** Tokens requiring programmable rules stay in-contract
- [ ] **Supply tracking:** Documented whether supply is exact or approximate
- [ ] **Withdrawal gating:** `sendImmediate()` only after all conditions verified
- [ ] **Shielded limitations:** Users understand coins lose contract rules after transfer

**Arithmetic:**
- [ ] **No Field accounting:** Business logic uses `Uint<N>`, not `Field`
- [ ] **Bounds checking:** All arithmetic inputs are range-checked before operations
- [ ] **Conservation:** Debits equal credits in every transfer circuit
- [ ] **Division rounding:** Integer division truncation is explicitly handled

**Infrastructure:**
- [ ] **Version alignment:** Compiler, SDK, proof server, and network versions match
- [ ] **Private state backup:** Users can export and restore encrypted private state
- [ ] **Storage encryption:** Private state is not stored in plaintext
- [ ] **Recovery tested:** Backup/restore flow verified end-to-end

## Resources

- [Midnight documentation](https://docs.midnight.network/) — official language and SDK reference
- [OpenZeppelin Compact Contracts](https://github.com/OpenZeppelin/compact-contracts) — production-grade contract patterns (Ownable, AccessControl, FungibleToken)
- [example-bboard](https://github.com/midnightntwrk/example-bboard) — canonical witness authentication pattern
- [midnight-seabattle](https://github.com/bricktowers/midnight-seabattle) — full-stack dApp with multi-user privacy patterns
- [Compact release notes](https://github.com/midnightntwrk/compact/releases) — breaking changes and version compatibility
- [Auditing guide](auditing.md) — structured audit methodology for reviewing Compact contracts
