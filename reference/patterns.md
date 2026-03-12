# Design Patterns

Advanced architectural patterns for production Midnight Compact contracts.
Sourced from OpenZeppelin compact-contracts, official Midnight examples (bboard, counter),
community projects (Brick Towers seabattle, Midnames), and Discord knowledge from
newton_meter (Compact designer), Sergey (Brick Towers), Facu (Midnames), and gilescope.

---

## 1. Authentication Pattern

**Status:** Battle-tested (bboard canonical example, OZ Ownable)

**Problem:** Midnight has no native `msg.sender`. You need a way to prove identity
without revealing the secret key, and prevent replay attacks across contracts.

**Solution:** Derive a public key from a secret key using a domain-separated hash,
binding it to the contract's sequence number. The secret key never leaves the user's
machine -- it enters through a witness.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

// Secret key stays off-chain, provided by TypeScript witness
witness localSecretKey(): Bytes<32>;

// Derive public key with domain separator + sequence binding
export circuit publicKey(sk: Bytes<32>, sequence: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "domain:pk:"), sequence, sk]);
}

export ledger owner: Bytes<32>;
export ledger sequence: Counter;

constructor() {
  // Register deployer as owner
  owner = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
}

export circuit post(msg: Opaque<"string">): [] {
  // Prove you're the owner by deriving the same pubkey from your secret
  owner = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  // ... store message ...
}

export circuit takeDown(): [] {
  // Assert-based auth for non-mutating ownership check
  assert(owner == publicKey(localSecretKey(), sequence as Field as Bytes<32>), "Not owner");
  // ... remove message ...
}
```

**TypeScript witness implementation:**

```typescript
export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, PrivateState>):
    [PrivateState, Uint8Array] => [privateState, privateState.secretKey],
};
```

**Why domain separator + sequence:**
- `"domain:pk:"` prevents the hash from colliding with other uses of `persistentHash`
- `sequence` (the contract's Counter) binds the key derivation to the contract instance, preventing replay across contracts
- `persistentHash` (SHA-256) is used because the result goes on-chain (persistent state)

**Key insight:** The secret key NEVER appears on-chain or in the proof. The ZK proof
demonstrates knowledge of a secret that produces the expected public key, without
revealing the secret itself.

---

## 2. OZ Module Composition Pattern

**Status:** Battle-tested (OpenZeppelin compact-contracts)

**Problem:** Compact has no inheritance or traits. You need a way to compose reusable
security primitives (ownership, pausability, access control) into contracts.

**Solution:** Import modules with `prefix` to namespace their circuits and ledger.
Call module initializers in the constructor. Guard exported circuits with module assertions.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;
import "./Ownable" prefix Ownable_;
import "./Pausable" prefix Pausable_;
import "./FungibleToken" prefix FungibleToken_;

witness localSecretKey(): Bytes<32>;

constructor(initOwner: Bytes<32>) {
  Ownable_initialize(initOwner);
  FungibleToken_initialize(
    pad(32, "MyToken"),    // name
    pad(32, "MTK"),        // symbol
    pad(32, "18")          // decimals
  );
}

// Guarded transfer -- pausable + token logic composed
export circuit transfer(to: Bytes<32>, value: Uint<64>): Boolean {
  Pausable_assertNotPaused();
  return FungibleToken_transfer(to, value);
}

// Only owner can pause
export circuit pause(): [] {
  Ownable_assertIsOwner(localSecretKey());
  Pausable_pause();
}

// Only owner can unpause
export circuit unpause(): [] {
  Ownable_assertIsOwner(localSecretKey());
  Pausable_unpause();
}
```

**How prefixing works:**
- `import "./Ownable" prefix Ownable_` makes all Ownable exports available as `Ownable_xyz`
- Ledger variables from Ownable become `Ownable_owner`, etc.
- Each module's state is isolated by prefix -- no naming collisions
- The prefix applies to ALL exports: circuits, ledger, enums, structs

**Available OZ modules:**
| Module | Purpose | Key circuits |
|--------|---------|-------------|
| `Ownable` | Single-owner auth | `initialize`, `assertIsOwner`, `transferOwnership` |
| `Pausable` | Emergency stop | `pause`, `unpause`, `assertNotPaused` |
| `AccessControl` | Role-based auth | `grantRole`, `revokeRole`, `assertHasRole` |
| `FungibleToken` | ERC20-equivalent | `transfer`, `approve`, `transferFrom` |
| `Capped` | Supply cap | `assertNotExceeded` |
| `Nonces` | Replay protection | `useNonce`, `useCheckedNonce` |

---

## 3. Off-Chain Computation Pattern

**Status:** Battle-tested (core Midnight philosophy, used throughout)

**Problem:** ZK circuit computation is expensive. Every operation increases the
circuit size (k value) and proving time. Complex math, iteration, and data
processing should not run inside the circuit.

**Solution:** Move expensive logic to TypeScript witnesses. The circuit only
validates the result, not how it was computed. "Structure your program so Compact
validates stuff, logic should be as much as possible offchain" (Sergey).

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

// Expensive computation happens in TypeScript
witness computeDivision(x: Uint<64>, y: Uint<64>): [Uint<64>, Uint<64>];

// Circuit only VERIFIES the result -- much cheaper
export circuit verifiedDivision(x: Uint<64>, y: Uint<64>): Uint<64> {
  const [quotient, remainder] = computeDivision(x, y);
  // One multiplication + one addition + one comparison = cheap
  assert(disclose(quotient * y + remainder == x), "Invalid division");
  assert(disclose(remainder < y), "Invalid remainder");
  return disclose(quotient);
}
```

**TypeScript witness:**

```typescript
export const witnesses = {
  computeDivision: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    x: bigint,
    y: bigint,
  ): [PrivateState, [bigint, bigint]] => {
    const quotient = x / y;
    const remainder = x % y;
    return [privateState, [quotient, remainder]];
  },
};
```

**Real-world examples of this pattern:**
- Square root: witness computes, circuit verifies `result * result == input`
- Sorting: witness sorts off-chain, circuit verifies each pair is ordered
- Merkle proofs: witness provides the path, circuit hashes up and compares root
- Search: witness finds the index, circuit verifies `array[index] == target`

**Key insight:** Verification is almost always cheaper than computation. A division
proof costs 3 operations in-circuit. The actual division would cost far more. This
asymmetry is the foundation of practical ZK programming.

---

## 4. Circuit Optimization Patterns

**Status:** Battle-tested (community-proven, multiple Discord confirmations)

**Problem:** Circuit size (measured by k value) directly impacts proving time,
memory usage, and user experience. Large k values can make a contract unusable
on consumer hardware.

### 4a. Avoid Cross-Circuit Calls

Calling an exported circuit from another exported circuit dramatically increases k.
Use internal (non-exported) circuits or inline the logic instead.

```compact
// BAD -- exported calling exported, k explodes
export circuit helper(): Uint<64> {
  return counter.read();
}
export circuit main(): [] {
  const val = helper();  // k increases dramatically
}

// GOOD -- internal circuit, k stays low
circuit helperInternal(): Uint<64> {
  return counter.read();
}
export circuit main(): [] {
  const val = helperInternal();  // no k penalty
}
```

"k=16 circuits dropped to k=14 or less" (Facu) after refactoring exported calls
to internal circuits.

### 4b. Minimize Ledger Operations

Ledger reads and writes are the most expensive circuit operations. Each one
adds significant circuit overhead.

```compact
// BAD -- multiple reads of the same value
export circuit process(): [] {
  if (counter.lessThan(100)) {
    const val = counter.read();
    // ... use val ...
  }
}

// GOOD -- read once, use the value
export circuit process(): [] {
  const val = counter.read();
  if (val < 100) {
    // ... use val ...
  }
}
```

### 4c. Use transientHash Over persistentHash Where Possible

`transientHash` (Poseidon) is approximately 10x cheaper in-circuit than
`persistentHash` (SHA-256). Use Poseidon for any hash that does not need to
persist on the ledger or be verified externally.

```compact
// For in-circuit comparison (e.g., commit-reveal within a single proof)
const cheapHash = transientHash<Vector<2, Bytes<32>>>([data1, data2]);

// For values stored on ledger or shared cross-contract
const expensiveHash = persistentHash<Vector<2, Bytes<32>>>([data1, data2]);
```

### 4d. Prefer Vectors Over Maps/Sets

Maps and Sets are "super expensive" (community consensus). Vectors have
fixed-size circuit overhead. When you know the maximum size, use a Vector.

```compact
// EXPENSIVE -- Map with dynamic size
export ledger entries: Map<Bytes<32>, Uint<64>>;

// CHEAPER -- Fixed-size Vector when you know the bound
export ledger entries: Vector<10, Uint<64>>;
```

### 4e. Avoid Counter Iteration

Iterating with a Counter in a circuit is extremely expensive because the
circuit must handle every possible iteration count. Move iteration off-chain.

**Cost hierarchy (cheapest to most expensive):**
1. Arithmetic operations (add, multiply, compare)
2. `transientHash` (Poseidon)
3. `persistentHash` (SHA-256)
4. Ledger reads/writes
5. Map/Set operations
6. Counter iteration
7. Cross-exported-circuit calls

---

## 5. Off-Chain Map Iteration Pattern

**Status:** Battle-tested (necessary for any contract using Maps)

**Problem:** Maps cannot be iterated inside a circuit. There is no `forEach`,
`map`, or `reduce` for Map types in Compact. But many use cases require
processing all entries (e.g., distributing rewards, tallying votes, batch settlement).

**Solution:** Add a `processed` flag per entry. Create a circuit that processes
ONE entry at a time. Iterate off-chain in TypeScript, calling the circuit for
each entry.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger entries: Map<Bytes<32>, Uint<64>>;
export ledger processed: Set<Bytes<32>>;
export ledger totalProcessed: Counter;

// Processes exactly ONE entry -- called repeatedly from TypeScript
export circuit processOne(key: Bytes<32>): [] {
  assert(entries.member(key), "Key not found");
  assert(!processed.member(key), "Already processed");

  const value = entries.lookup(key);
  // ... do something with value ...

  processed.insert(key);
  totalProcessed.increment(1);
}

// Query whether all entries are done
export circuit isComplete(expectedCount: Uint<64>): Boolean {
  return totalProcessed.read() == expectedCount;
}
```

**TypeScript orchestration:**

```typescript
// Off-chain loop drives one-at-a-time processing
async function processAllEntries(
  contract: DeployedContract,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    const txData = await contract.callTx.processOne(key);
    // Each call generates its own ZK proof and transaction
    await txData.public.wait();
  }
}
```

**Variants:**
- **Batch processing:** Pass a `Vector<N, Bytes<32>>` of keys to process N entries per circuit call (fixed N, higher k but fewer transactions)
- **Priority processing:** Witness selects which entry to process next based on off-chain logic
- **Cleanup pattern:** After all entries processed, a separate circuit clears the processed set

---

## 6. Commit-Reveal Pattern

**Status:** Experimental (architecture proven, no canonical open-source implementation)

**Problem:** Sealed-bid auctions, private voting, and hidden moves require
submitting a value that is hidden at first and revealed later.

**Solution:** Two-phase protocol. Commit phase stores a hash of the secret value.
Reveal phase provides the secret and verifies the hash matches.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger commitments: Map<Bytes<32>, Bytes<32>>;  // bidder -> commitment hash
export ledger reveals: Map<Bytes<32>, Uint<64>>;        // bidder -> revealed value
export ledger phase: Field;                              // 0 = commit, 1 = reveal

witness localSecretKey(): Bytes<32>;
witness getBidAmount(): Uint<64>;
witness getBidSalt(): Bytes<32>;

// Commit: store hash(salt + bid amount) -- bid stays private
export circuit commitBid(): [] {
  assert(phase == 0 as Field, "Not in commit phase");

  const sk = localSecretKey();
  const bidAmount = getBidAmount();
  const salt = getBidSalt();

  // Hash the bid with a salt for privacy
  const commitment = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "bid:commit:"),
    salt,
    bidAmount as Field as Bytes<32>
  ]);

  const bidder = disclose(publicKey(sk));
  commitments.insert(bidder, disclose(commitment));
}

// Reveal: provide the original values, circuit verifies hash matches
export circuit revealBid(): [] {
  assert(phase == 1 as Field, "Not in reveal phase");

  const sk = localSecretKey();
  const bidAmount = getBidAmount();
  const salt = getBidSalt();

  const bidder = disclose(publicKey(sk));
  const storedCommitment = commitments.lookup(bidder);

  // Recompute the commitment and verify
  const recomputed = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "bid:commit:"),
    salt,
    bidAmount as Field as Bytes<32>
  ]);

  assert(disclose(recomputed == storedCommitment), "Commitment mismatch");
  reveals.insert(bidder, disclose(bidAmount));
}

// Helper for auth
circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "domain:pk:"), sk]);
}
```

**ZK advantage over Ethereum commit-reveal:**
On Ethereum, the reveal transaction exposes the plaintext value on-chain. On Midnight,
the ZK proof can verify the commitment matches without ever disclosing the salt.
The `disclose(bidAmount)` is a choice -- you could keep bids private and only disclose
the winner, or disclose all bids only after the reveal phase closes. The privacy
boundary is programmable.

---

## 7. Shielded Coin Pattern

**Status:** Battle-tested (core Midnight primitive, Zswap protocol)

**Problem:** You need to create, transfer, and receive tokens within a contract
while preserving transaction privacy through the Zswap shielded pool.

**Solution:** Use Compact's built-in coin operations. Tokens flow through the
Zswap protocol, which provides unlinkability between sender and receiver.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger tokenName: Bytes<32>;

constructor() {
  tokenName = pad(32, "myToken");
}

// Mint new tokens to a recipient wallet
export circuit mint(
  amount: Uint<64>,
  nonce: Bytes<32>,
  recipient: ZswapCoinPublicKey
): [] {
  // Only owner can mint (auth pattern omitted for brevity)
  mintToken(tokenName, amount, nonce, recipient);
}

// Accept incoming tokens into the contract
export circuit deposit(coin: CoinInfo): [] {
  const expectedType = tokenType(tokenName, kernel.self());
  // Verify the coin is our token type
  receive(coin);
}

// Send tokens from contract to a wallet
export circuit withdraw(
  coin: CoinInfo,
  recipient: ZswapCoinPublicKey,
  amount: Uint<64>
): [] {
  sendImmediate(coin, recipient, amount);
}

// Get the token type identifier for this contract's token
export pure circuit getTokenType(): Bytes<32> {
  return tokenType(pad(32, "myToken"), kernel.self());
}
```

**Critical warnings:**
- Once tokens leave the contract via `sendImmediate`, the contract's rules NO LONGER APPLY. The tokens are free-floating in the Zswap pool. If you need ongoing transfer restrictions, you need a different architecture (e.g., all transfers route through the contract).
- `mintToken` requires a unique `nonce` per mint call -- reusing a nonce causes undefined behavior.
- `tokenType(domainSeparator, contractAddress)` derives a deterministic token type ID. The same contract always produces the same token type.
- `kernel.self()` returns the current contract's address. Only valid inside non-pure circuits.

---

## 8. State Machine Pattern

**Status:** Battle-tested (used in seabattle, escrow contracts)

**Problem:** Contract has discrete states with specific allowed transitions.
You need to enforce that only valid transitions occur.

**Solution:** Use Compact enums for states and assert the current state before
allowing transitions.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export enum AuctionState { registration, bidding, reveal, settled }

export ledger state: AuctionState;
export ledger itemDescription: Opaque<"string">;
export ledger seller: Bytes<32>;
export ledger winningBid: Uint<64>;
export ledger winner: Bytes<32>;

witness localSecretKey(): Bytes<32>;

constructor(description: Opaque<"string">) {
  state = AuctionState.registration;
  itemDescription = description;
  seller = disclose(publicKey(localSecretKey()));
}

// Only seller can advance phases
circuit assertSeller(): [] {
  assert(
    seller == publicKey(localSecretKey()),
    "Not seller"
  );
}

export circuit openBidding(): [] {
  assertSeller();
  assert(state == AuctionState.registration, "Must be in registration");
  state = AuctionState.bidding;
}

export circuit closeAndReveal(): [] {
  assertSeller();
  assert(state == AuctionState.bidding, "Must be in bidding");
  state = AuctionState.reveal;
}

export circuit settle(winnerKey: Bytes<32>, amount: Uint<64>): [] {
  assertSeller();
  assert(state == AuctionState.reveal, "Must be in reveal");
  winner = winnerKey;
  winningBid = amount;
  state = AuctionState.settled;
}

// Helper
circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "domain:pk:"), sk]);
}
```

**State transition diagram:**
```
registration --> bidding --> reveal --> settled
     |              |           |
     v              v           v
  (no backward transitions allowed)
```

**Design guidelines:**
- Make state an `export ledger` so off-chain code can read the current phase
- Use `assert(state == ExpectedState, ...)` as the FIRST check in each circuit
- Keep the enum variants simple -- complex sub-states belong in separate ledger variables
- Consider adding a `cancelled` state reachable from any pre-settled state

---

## 9. Access Control Pattern (OZ)

**Status:** Battle-tested (OpenZeppelin compact-contracts)

**Problem:** Single-owner contracts are too rigid. You need role-based permissions
where different addresses can perform different actions.

**Solution:** Use the OZ AccessControl module. Roles are `Bytes<32>` identifiers.
Each role tracks which public keys hold it.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;
import "./AccessControl" prefix AC_;

witness localSecretKey(): Bytes<32>;

const ADMIN_ROLE: Bytes<32> = pad(32, "ADMIN");
const MINTER_ROLE: Bytes<32> = pad(32, "MINTER");
const PAUSER_ROLE: Bytes<32> = pad(32, "PAUSER");

constructor() {
  const deployer = disclose(ownPublicKey());
  AC_initialize();
  AC_grantRole(ADMIN_ROLE, deployer);
  AC_grantRole(MINTER_ROLE, deployer);
}

// Only ADMIN can grant roles
export circuit grantMinter(account: Bytes<32>): [] {
  AC_assertHasRole(ADMIN_ROLE, disclose(ownPublicKey()));
  AC_grantRole(MINTER_ROLE, account);
}

// Only MINTER can mint
export circuit mint(to: Bytes<32>, amount: Uint<64>): [] {
  AC_assertHasRole(MINTER_ROLE, disclose(ownPublicKey()));
  // ... minting logic ...
}

// Only PAUSER can pause
export circuit emergencyPause(): [] {
  AC_assertHasRole(PAUSER_ROLE, disclose(ownPublicKey()));
  // ... pause logic ...
}

// Only ADMIN can revoke
export circuit revokeMinter(account: Bytes<32>): [] {
  AC_assertHasRole(ADMIN_ROLE, disclose(ownPublicKey()));
  AC_revokeRole(MINTER_ROLE, account);
}

circuit ownPublicKey(): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "domain:pk:"), localSecretKey()]);
}
```

**Privacy consideration:** `disclose(ownPublicKey())` reveals the caller's public key
on-chain. If role membership should be private, you can use a pattern where the circuit
asserts the role internally without disclosing the key:

```compact
// Private role check -- proves membership without revealing identity
export circuit mintPrivate(to: Bytes<32>, amount: Uint<64>): [] {
  assert(
    AC_hasRole(MINTER_ROLE, ownPublicKey()),  // no disclose
    "Not a minter"
  );
  // Key never appears on-chain -- ZK proof demonstrates role membership
}
```

**NOTE:** Whether this private variant works depends on AC module internals
and how `hasRole` interacts with `disclose` requirements. Check the current
OZ implementation for exact API.

---

## 10. Nonce / Sequence Pattern

**Status:** Battle-tested (OZ Nonces module, bboard sequence)

**Problem:** Prevent replay attacks. Without nonces, a valid proof could be
resubmitted to repeat an action (e.g., double-withdraw, double-vote).

**Solution:** Maintain a monotonically increasing counter. Each operation must
provide the expected nonce value.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger nonce: Counter;

export circuit execute(expectedNonce: Uint<64>, payload: Bytes<32>): [] {
  // Verify caller knows the current nonce
  const currentNonce = nonce.read();
  assert(disclose(currentNonce == expectedNonce), "Invalid nonce - replay?");

  // Increment BEFORE processing to prevent reentrancy-like issues
  nonce.increment(1);

  // ... process payload ...
}
```

**Per-user nonces (for multi-user contracts):**

```compact
export ledger userNonces: Map<Bytes<32>, Uint<64>>;

export circuit executeAs(expectedNonce: Uint<64>, payload: Bytes<32>): [] {
  const caller = disclose(ownPublicKey());

  if (userNonces.member(caller)) {
    assert(disclose(userNonces.lookup(caller) == expectedNonce), "Invalid nonce");
  } else {
    assert(disclose(expectedNonce == 0 as Uint<64>), "First nonce must be 0");
  }

  userNonces.insert(caller, expectedNonce + 1);
  // ... process payload ...
}
```

**OZ Nonces module approach:**

```compact
import "./Nonces" prefix N_;

export circuit doSomething(userNonce: Uint<64>): [] {
  const caller = disclose(ownPublicKey());
  N_useCheckedNonce(caller, userNonce);  // asserts + increments
  // ... logic ...
}
```

**Why not just rely on the blockchain rejecting duplicates?**
The Midnight ledger model does include transaction-level dedup, but application-level
nonces provide stronger guarantees: they enforce ordering (nonce 5 must come before
nonce 6), prevent front-running of identical payloads, and make replay attempts
fail with a clear error message rather than a silent rejection.

---

## 11. Time-Based Conditions

**Status:** Experimental (witness-based, not cryptographically enforced)

**Problem:** Many contracts need time gates: lock expiry, vesting schedules,
auction deadlines. Compact has no native `block.timestamp` equivalent.

**Solution:** Use a witness to provide the current time. The circuit checks
the time condition. This relies on the caller providing honest timestamps,
which is acceptable when only the caller benefits from honest behavior.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

witness getCurrentTime(): Uint<64>;

export ledger lockDeadline: Uint<64>;
export ledger beneficiary: Bytes<32>;
export ledger locked: Boolean;

constructor(deadline: Uint<64>, beneficiaryKey: Bytes<32>) {
  lockDeadline = deadline;
  beneficiary = beneficiaryKey;
  locked = true;
}

export circuit claimAfterDeadline(): [] {
  assert(locked, "Already claimed");

  const now = getCurrentTime();
  assert(disclose(now > lockDeadline), "Lock has not expired");

  // Verify caller is the beneficiary (auth pattern)
  assert(
    beneficiary == publicKey(localSecretKey()),
    "Not beneficiary"
  );

  locked = false;
  // ... release funds ...
}
```

**TypeScript witness:**

```typescript
export const witnesses = {
  getCurrentTime: ({ privateState }: WitnessContext<Ledger, PrivateState>):
    [PrivateState, bigint] => {
    // Unix timestamp in seconds
    const now = BigInt(Math.floor(Date.now() / 1000));
    return [privateState, now];
  },
};
```

**Trust analysis:**
- The caller provides the timestamp via the witness
- The circuit only checks `now > deadline` -- it cannot verify `now` is truthful
- This is safe when only the claimant benefits from a correct timestamp (they want to claim, so they provide real time or a time that is too early and fails)
- NOT safe when the caller benefits from lying (e.g., claiming before the deadline expires)

**For adversarial time conditions,** newer Compact/Midnight versions may support
`blockTimeGreaterThan` as a ledger ADT or native circuit operation. Check the
current toolchain version for availability. In the meantime, consider using an
oracle pattern (a trusted third party attests to the current time via a separate
transaction).

---

## 12. Oracle Feed Pattern

**Status:** Experimental (architecture sound, no canonical implementation)

**Problem:** Contracts need external data (prices, timestamps, real-world events)
but Compact circuits cannot make HTTP calls or access external state.

**Solution:** A trusted oracle posts data to the contract's ledger. Other circuits
read and verify the oracle-signed data.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger oracle: Bytes<32>;
export ledger priceData: Map<Bytes<32>, Uint<64>>;    // asset -> price
export ledger lastUpdate: Uint<64>;

witness localSecretKey(): Bytes<32>;

constructor(oracleKey: Bytes<32>) {
  oracle = oracleKey;
}

// Only the oracle can post price updates
export circuit updatePrice(asset: Bytes<32>, price: Uint<64>, timestamp: Uint<64>): [] {
  assert(
    oracle == publicKey(localSecretKey()),
    "Not oracle"
  );
  priceData.insert(asset, disclose(price));
  lastUpdate = disclose(timestamp);
}

// Anyone can read the price (it's on public ledger)
export circuit getPrice(asset: Bytes<32>): Uint<64> {
  assert(priceData.member(asset), "Asset not found");
  return priceData.lookup(asset);
}

// Use price in a conditional (e.g., liquidation check)
export circuit checkLiquidation(
  asset: Bytes<32>,
  collateralValue: Uint<64>,
  debtValue: Uint<64>
): Boolean {
  const price = priceData.lookup(asset);
  const currentValue = collateralValue * price;
  return disclose(currentValue < debtValue * 150 / 100);  // 150% collateral ratio
}

circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "domain:pk:"), sk]);
}
```

**Trust model:** The oracle key is trusted. For decentralized price feeds, consider
a multi-oracle pattern where N-of-M oracles must agree on a value. However, the Map
operations involved make this expensive -- consider off-chain aggregation with a single
on-chain submission of the aggregated result.

---

## 13. Escrow Pattern

**Status:** Experimental (architecturally standard, directly relevant to LOKx)

**Problem:** Two parties want to exchange assets atomically. Neither trusts the
other to go first.

**Solution:** A contract holds both deposits and releases them when conditions
are met, or refunds if the escrow expires or is cancelled by mutual agreement.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export enum EscrowState { created, funded, completed, refunded, disputed }

export ledger state: EscrowState;
export ledger party_a: Bytes<32>;
export ledger party_b: Bytes<32>;
export ledger amount_a: Uint<64>;
export ledger amount_b: Uint<64>;
export ledger deadline: Uint<64>;
export ledger funded_a: Boolean;
export ledger funded_b: Boolean;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

constructor(
  a: Bytes<32>,
  b: Bytes<32>,
  amtA: Uint<64>,
  amtB: Uint<64>,
  expiry: Uint<64>
) {
  party_a = a;
  party_b = b;
  amount_a = amtA;
  amount_b = amtB;
  deadline = expiry;
  state = EscrowState.created;
  funded_a = false;
  funded_b = false;
}

export circuit fund(coin: CoinInfo): [] {
  assert(state == EscrowState.created, "Not in funding phase");

  const caller = publicKey(localSecretKey());

  if (caller == party_a) {
    funded_a = true;
  } else {
    assert(caller == party_b, "Not a party to this escrow");
    funded_b = true;
  }

  receive(coin);

  // Auto-advance when both funded
  if (funded_a && funded_b) {
    state = EscrowState.funded;
  }
}

export circuit complete(coin: CoinInfo): [] {
  assert(state == EscrowState.funded, "Not fully funded");
  // Both parties can trigger completion
  // Release logic: send A's deposit to B, B's deposit to A
  state = EscrowState.completed;
}

export circuit refundExpired(coin: CoinInfo): [] {
  assert(state == EscrowState.created || state == EscrowState.funded, "Cannot refund");
  const now = getCurrentTime();
  assert(disclose(now > deadline), "Escrow not expired");
  state = EscrowState.refunded;
  // Return funds to original depositors
}

circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "domain:pk:"), sk]);
}
```

**LOKx primitives mapping:**
- `LOK` = create escrow + fund phase (lock asset with conditions)
- `RELEASE` = complete circuit with ZK condition verification
- `ESCROW` = full two-party flow above

---

## 14. Multi-Signature Pattern

**Status:** Experimental (no canonical implementation)

**Problem:** Critical operations require M-of-N approvals. A single compromised
key should not be able to drain the contract.

**Solution:** Track approvals per operation using a Map. Each signer calls an
approval circuit. When the threshold is met, the operation executes.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger signers: Map<Bytes<32>, Boolean>;     // authorized signers
export ledger threshold: Uint<32>;                   // M required
export ledger approvals: Map<Bytes<32>, Uint<32>>;  // operationId -> approval count
export ledger hasApproved: Map<Bytes<32>, Boolean>;  // hash(operationId + signer) -> approved

witness localSecretKey(): Bytes<32>;

export circuit approve(operationId: Bytes<32>): [] {
  const caller = publicKey(localSecretKey());
  assert(signers.member(caller), "Not an authorized signer");

  // Prevent double-approval
  const approvalKey = persistentHash<Vector<2, Bytes<32>>>([operationId, caller]);
  assert(!hasApproved.member(disclose(approvalKey)), "Already approved");
  hasApproved.insert(disclose(approvalKey), true);

  // Increment approval count
  if (approvals.member(operationId)) {
    const current = approvals.lookup(operationId);
    approvals.insert(operationId, current + 1);
  } else {
    approvals.insert(operationId, 1);
  }
}

export circuit execute(operationId: Bytes<32>): [] {
  assert(approvals.member(operationId), "No approvals");
  const count = approvals.lookup(operationId);
  assert(count >= threshold, "Insufficient approvals");

  // ... execute the authorized operation ...

  // Clean up (optional -- saves ledger space)
  approvals.remove(operationId);
}

circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "domain:pk:"), sk]);
}
```

**Performance warning:** This pattern uses multiple Map operations per call.
For large signer sets, consider an off-chain aggregation approach: witnesses
collect all signatures off-chain, submit a batch proof that M valid signatures
exist, and the circuit only verifies the aggregate.

---

## 15. Privacy-Preserving Voting Pattern

**Status:** Experimental (architecture sound, builds on commit-reveal)

**Problem:** Voters must be able to vote without revealing their choice until
the tally. The tally must be verifiable. No one should vote twice.

**Solution:** Combine the authentication pattern with a commit-reveal flow.
The vote itself is private (never disclosed). Only the aggregate tally is public.

```compact
pragma language_version >= 0.20;
import CompactStandardLibrary;

export ledger votesFor: Counter;
export ledger votesAgainst: Counter;
export ledger hasVoted: Set<Bytes<32>>;
export ledger votingOpen: Boolean;

witness localSecretKey(): Bytes<32>;
witness getVote(): Boolean;  // true = for, false = against

export circuit vote(): [] {
  assert(votingOpen, "Voting is closed");

  const voter = disclose(publicKey(localSecretKey()));
  assert(!hasVoted.member(voter), "Already voted");
  hasVoted.insert(voter);

  // Vote is computed privately -- only the counter increment is visible
  const myVote = getVote();
  if (disclose(myVote)) {
    votesFor.increment(1);
  } else {
    votesAgainst.increment(1);
  }
}
```

**Privacy analysis:**
- The voter's identity (public key) IS disclosed -- needed to prevent double voting
- The vote direction is NOT directly disclosed, BUT an observer watching the ledger
  can see which counter incremented, correlating it with the voter's transaction
- For stronger privacy, accumulate votes off-chain and submit batch tallies, or use
  a more sophisticated cryptographic protocol where votes are homomorphically encrypted

**For truly private voting** (no correlation between voter and vote), consider:
1. Use `transientHash` for the vote commitment (cheaper, doesn't persist)
2. Separate the vote submission from the tally update into different phases
3. Have a trusted tallier (or MPC protocol) that decrypts and counts

---

## Pattern Maturity Legend

| Status | Meaning |
|--------|---------|
| **Battle-tested** | Used in production-grade code (OZ, bboard, seabattle). Safe to use as-is. |
| **Experimental** | Architecturally sound but no canonical open-source reference. Test thoroughly. |

---

## Patterns NOT Applicable to Midnight

Some common blockchain patterns do not translate to Midnight's model:

- **Reentrancy guards:** Not needed. Compact circuits execute atomically -- there are no external calls mid-execution that could re-enter the contract.
- **Gas optimization:** No gas model. Circuit size (k value) is the relevant cost metric. See Pattern 4.
- **Proxy/upgradeable contracts:** Midnight contracts are deployed at fixed addresses with fixed code. Upgradeability requires deploying a new contract and migrating state. There is no delegatecall equivalent.
- **Flash loans:** The Zswap model does not support borrow-and-return-in-same-tx patterns in the way Ethereum does.
- **Storage layout optimization:** Ledger state is not slot-based. Maps, Sets, and Counters have their own Merkle-tree backed storage. Packing multiple values into a single slot is not relevant.
