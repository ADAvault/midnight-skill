# Compact Standard Library & Built-in Reference

Quick-reference for every built-in function, ledger type, and core type in Compact.

---

## 1. CompactStandardLibrary

Every Compact file must import the standard library. There is no opt-out.

```compact
import CompactStandardLibrary;
```

This import provides all built-in functions, ledger collection types, coin operations, and helper utilities documented below. Omitting it causes "unknown identifier" errors on even basic operations like `assert`.

---

## 2. Built-in Functions

### Cryptographic

#### `persistentHash<T>(data: T): Bytes<32>`

SHA-256 hash. Deterministic across all platforms and runtimes.

```compact
const h = persistentHash<Vector<2, Bytes<32>>>([data1, data2]);
```

**When to use:** Any value that persists on-chain, is stored in a Map key, or needs to be verified off-chain or cross-contract. This is the default choice unless you have a specific reason to use `transientHash`.

**WARNING:** The type parameter `T` must match the argument exactly. Wrapping a single `Bytes<32>` requires `Vector<1, Bytes<32>>`.

---

#### `transientHash<T>(data: T): Bytes<32>`

Poseidon hash. Approximately 10x cheaper in-circuit than `persistentHash`.

```compact
const h = transientHash<Vector<1, Bytes<32>>>([secret]);
```

**When to use:** Internal comparisons within a single proof where the hash never leaves the circuit. Typical use: comparing a witness-provided value against a previously stored commitment within the same transaction.

**WARNING:** Poseidon hashes are NOT compatible with SHA-256. A value hashed with `transientHash` cannot be verified against a `persistentHash` output. Do not mix them for the same logical value.

---

#### `persistentCommit<T>(value: T): Bytes<32>`

Hiding commitment (Pedersen-style). Produces a commitment that conceals the input value.

```compact
const commitment = persistentCommit<Bytes<32>>(secret);
```

**When to use:** Commit-reveal patterns (sealed bids, hidden votes). The commitment hides the value until the owner chooses to reveal it.

**WARNING:** A commitment is NOT the same as a hash. Two calls with the same input may produce different outputs (the commitment includes randomness). Do not use for equality checks -- use `persistentHash` for that.

---

### Privacy

#### `disclose(expr): T`

Make a private (witness-derived) value public. Returns the value unchanged but marks it as disclosed for the circuit verifier.

```compact
owner = disclose(publicKey(localSecretKey()));
assert(disclose(caller == storedOwner), "Not authorized");
if (disclose(amount > 0)) { /* ... */ }
```

**When to use:** Required in three situations:
1. Writing a witness-derived value to public ledger state
2. Using a witness-derived value in a conditional (`if`, `assert`)
3. Returning a witness-derived value from an exported circuit

**WARNING (Compact 0.16+):** `disclose()` is MANDATORY for all three cases above. Omitting it causes a compilation error, not a warning. This is the single most common compiler error for developers upgrading from earlier versions.

**WARNING:** Every `disclose()` call reveals information to on-chain observers. Audit each one carefully. Over-disclosure is a privacy leak; under-disclosure is a compiler error.

---

#### `ownPublicKey(): ZswapCoinPublicKey`

Returns the calling user's unlinkable public key for coin operations.

```compact
const recipient = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
mintToken(domain, amount, nonce, recipient);
```

**When to use:** Identifying the caller for token minting or sending operations. The key is unlinkable -- two calls from the same wallet in different transactions produce different keys (privacy by design).

**WARNING:** This is NOT a stable identifier. Do not store it as an "owner" field for access control. Use `persistentHash(publicKey(localSecretKey()))` for persistent identity instead.

---

### Token / Coin Operations

#### `mintToken(domain: Bytes<32>, amount: Uint<64>, nonce: Bytes<32>, recipient: Either<ZswapCoinPublicKey, ContractAddress>)`

Create new shielded tokens. The token type is derived from `domain` + the contract address.

```compact
const domain = pad(32, "myToken");
const recipient = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
mintToken(domain, 1000 as Uint<64>, evolveNonce(nonceCounter, nonce), recipient);
```

**WARNING:** Each mint call MUST use a unique nonce. Reusing a nonce produces a duplicate coin that will be rejected by the ledger. Use `evolveNonce` with a Counter to guarantee uniqueness.

**WARNING:** `amount` must be `Uint<64>`. Passing a literal without a cast may cause type errors.

---

#### `tokenType(domain: Bytes<32>, contractAddr: ContractAddress): TokenType`

Derive the token type identifier from a domain separator and contract address.

```compact
const ttype = tokenType(pad(32, "myToken"), kernel.self());
```

**When to use:** Verifying that a received coin's `.color` matches the expected token type, or for token type comparisons in deposit/send operations.

---

#### `receiveShielded(coin: ShieldedCoinInfo)`

Accept an incoming shielded coin into the contract. Must be called inside a circuit to process a coin transfer to this contract. The `coin` parameter is a `ShieldedCoinInfo` struct with fields `nonce` (`Bytes<32>`), `color` (`Bytes<32>`), and `value` (`Uint<128>`).

```compact
export circuit deposit(coin: ShieldedCoinInfo): [] {
  receiveShielded(disclose(coin));
}
```

**WARNING:** If a coin is sent to a contract that does not call `receiveShielded`, the coin is lost.

**NOTE:** Previously named `receive()`. Using the old name produces a helpful error: `apparent use of an old standard-library / ledger operator name receive: the new name is receiveShielded`.

---

#### `sendImmediateShielded(coin: ShieldedCoinInfo, recipient: Either<ZswapCoinPublicKey, ContractAddress>, amount: Uint<64>): SendResult`

Send a shielded coin from the contract to a recipient. The `coin` parameter is a `ShieldedCoinInfo` struct.

```compact
const recipient = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
sendImmediateShielded(disclose(coin), recipient, disclose(amount));
```

**When to use:** Transferring tokens out of the contract to a wallet or another contract.

**WARNING:** The coin must have sufficient balance. Insufficient balance causes the transaction to fail at proof verification.

**NOTE:** Previously named `sendImmediate()`. Using the old name produces a helpful error: `apparent use of an old standard-library / ledger operator name sendImmediate: the new name is sendImmediateShielded`.

---

### Unshielded Token Operations

These work with unshielded tokens (NIGHT and custom unshielded tokens). Amounts are visible on-chain.

#### `receiveUnshielded(color: Bytes<32>, amount: Uint<128>)`

Accept unshielded tokens into the contract.

```compact
receiveUnshielded(disclose(color), disclose(amount));
```

**NOTE:** On ledger v7, this fails via `callTx` with error 139 (gotcha #69). Fixed in ledger v8 / Compact 0.30.0 (Issue #151).

---

#### `sendUnshielded(color: Bytes<32>, amount: Uint<128>, recipient: Either<ContractAddress, UserAddress>)`

Send unshielded tokens from the contract to a recipient.

```compact
sendUnshielded(disclose(color), disclose(amount), right<ContractAddress, UserAddress>(disclose(recipientAddr)));
```

---

#### `mintUnshieldedToken(domainSep: Bytes<32>, value: Uint<64>, recipient: Either<ContractAddress, UserAddress>): Bytes<32>`

Mint new unshielded tokens. Returns the token color.

```compact
const color = mintUnshieldedToken(disclose(domainSep), disclose(amount), right<ContractAddress, UserAddress>(disclose(recipient)));
```

---

#### `unshieldedBalance(color: Bytes<32>): Uint<128>`

Query the contract's own unshielded token balance.

```compact
const bal = unshieldedBalance(disclose(color));
```

---

### Block Time Operations

Protocol-enforced time comparisons. Validated by the block producer — cannot be spoofed.

#### `blockTimeGte(time: Uint<64>): Boolean` / `blockTimeLt` / `blockTimeGt` / `blockTimeLte`

Compare the current block time against a Unix timestamp (seconds since epoch). Returns `Boolean` — wrap in `assert()` to enforce.

```compact
assert(blockTimeGte(disclose(unlockTime)), "Too early");
```

**Simulator limitation:** Not enforced in `compact-runtime` simulator. On-chain, the block producer validates against the actual block timestamp (gotcha #65).

---

#### `evolveNonce(index: Uint<64>, nonce: Bytes<32>): Bytes<32>`

Derive a unique nonce from a counter index and a prior nonce. Used for `mintShieldedToken` which requires unique nonces per call.

```compact
counter.increment(1);
const newNonce = evolveNonce(counter, currentNonce);
mintShieldedToken(domain, amount, newNonce, recipient);
nonce = newNonce;
```

---

#### `nativeToken(): TokenType`

Returns the DUST token type (Midnight's native token).

```compact
// In Compact — compare against received coin type
const isDust = (coinType == nativeToken());
```

**NOTE (JS side):** In TypeScript, import `nativeToken` from the midnight-js package, not from the contract.

---

### Utility

#### `pad(N: number, str: string): Bytes<N>`

Pad a string literal to exactly N bytes (zero-padded on the right).

```compact
const domain = pad(32, "myToken");
const label = pad(16, "escrow");
```

**When to use:** Creating fixed-size byte arrays from string literals, most commonly for `mintToken` domain separators and Map keys.

**WARNING:** `N` must be a compile-time constant. The string must be shorter than or equal to N bytes.

---

#### `default<T>`

Returns the zero/default value for any type.

```compact
const empty: Bytes<32> = default<Bytes<32>>;   // 0x000...000
const zero: Uint<64> = default<Uint<64>>;       // 0
const fresh: Boolean = default<Boolean>;         // false
```

**When to use:** Initializing ledger state, checking if a value has been set (compare against default), resetting values.

---

#### `kernel.self(): ContractAddress`

Returns the address of the currently executing contract.

```compact
const myAddr = kernel.self();
const ttype = tokenType(pad(32, "myToken"), kernel.self());
const asRecipient = right<ZswapCoinPublicKey, ContractAddress>(kernel.self());
```

**When to use:** Self-referencing the contract for token type derivation, sending coins to self, or passing the contract address as a parameter.

---

#### `evolveNonce(counter: Counter, nonce: Bytes<32>): Bytes<32>`

Derive a new unique nonce from a counter and a seed nonce. Deterministic: same counter value + same nonce = same output.

```compact
export ledger nonceCounter: Counter;

const uniqueNonce = evolveNonce(nonceCounter, baseSeed);
nonceCounter.increment(1);
```

**When to use:** Generating unique nonces for `mintToken` calls. The counter ensures each derived nonce is distinct.

**WARNING:** Always increment the counter AFTER calling `evolveNonce`, not before. The counter's current value is used in the derivation.

---

#### `convertFieldToBytes(N: number, field: Field, context: string): Bytes<N>`

Convert a Field element to a fixed-size byte array at runtime.

```compact
const bytes: Bytes<32> = convertFieldToBytes(32, myField, "conversion context");
```

**When to use:** Bridging between Field-based computation and byte-based storage or hashing. The `context` string is for error reporting only.

**WARNING:** If the Field value does not fit in N bytes, this fails at runtime. Prefer `as` casts when the type relationship is known at compile time.

---

## 3. Ledger Types

### Counter

A monotonic counter backed by ledger state. The most circuit-efficient ledger type.

```compact
export ledger myCounter: Counter;
```

| Operation | Signature | Notes |
|-----------|-----------|-------|
| `increment(n)` | `(Uint<16>) -> void` | Increase by n |
| `decrement(n)` | `(Uint<16>) -> void` | Decrease by n (fails if result < 0) |
| `read()` | `() -> Uint<64>` | Get current value |
| `lessThan(n)` | `(Uint<64>) -> Boolean` | Comparison |
| `resetToDefault()` | `() -> void` | Reset to zero |

```compact
myCounter.increment(1);
const val = myCounter.read();
assert(myCounter.lessThan(100), "Counter overflow");
```

**WARNING:** `counter.value()` does NOT exist. Use `counter.read()`. This is the single most common API mistake.

**WARNING:** Counter operations inside loops are extremely expensive in-circuit. Each operation adds full circuit constraints. Prefer a single `increment(n)` over n calls to `increment(1)`.

---

### Map<K, V>

Key-value store backed by a Merkle tree on the ledger.

```compact
export ledger balances: Map<Bytes<32>, Uint<64>>;
```

| Operation | Signature | Notes |
|-----------|-----------|-------|
| `insert(key, value)` | `(K, V) -> void` | Upsert (insert or overwrite) |
| `remove(key)` | `(K) -> void` | Delete entry |
| `lookup(key)` | `(K) -> V` | Get value (fails if key missing) |
| `member(key)` | `(K) -> Boolean` | Check existence |
| `isEmpty()` | `() -> Boolean` | Check if map has no entries |
| `size()` | `() -> Uint<64>` | Number of entries |
| `resetToDefault()` | `() -> void` | Clear all entries |

```compact
balances.insert(userHash, 100 as Uint<64>);
if (balances.member(userHash)) {
  const bal = balances.lookup(userHash);
}
```

**WARNING:** Cannot iterate over a Map in-circuit. There is no `forEach`, `keys()`, or `entries()`. If you need iteration, redesign using off-chain witnesses.

**WARNING:** Cannot use Map as a witness return type. The compiler will reject it.

**WARNING:** Each Map operation requires a Merkle proof, making them expensive. Minimize the number of Map operations per circuit.

---

### Set<T>

Unique-value collection backed by a Merkle tree on the ledger.

```compact
export ledger voters: Set<Bytes<32>>;
```

| Operation | Signature | Notes |
|-----------|-----------|-------|
| `insert(value)` | `(T) -> void` | Add value (no-op if exists) |
| `remove(value)` | `(T) -> void` | Remove value |
| `member(value)` | `(T) -> Boolean` | Check membership |
| `isEmpty()` | `() -> Boolean` | Check if set has no entries |
| `size()` | `() -> Uint<64>` | Number of entries |
| `resetToDefault()` | `() -> void` | Clear all entries |

```compact
assert(!voters.member(voterHash), "Already voted");
voters.insert(voterHash);
```

**WARNING:** Same Merkle-proof cost as Map. Same no-iteration constraint. Prefer a Map if you need to associate data with each member.

---

### Vector<N, T>

Fixed-size array. The most circuit-efficient collection type.

```compact
const v: Vector<3, Uint<32>> = [1, 2, 3];
const first = v[0];
const second = v[1];
```

**WARNING:** Vectors are immutable. There is no update/set syntax.

**WARNING:** Dynamic indexing is NOT supported. `v[i]` where `i` is a variable will NOT compile. Only literal indices (`v[0]`, `v[1]`, etc.) are valid.

**WARNING:** Vector size `N` must be a compile-time constant. There is no way to create a variable-length array.

---

## 4. Type System

### Primitive Types

| Type | Default | Description |
|------|---------|-------------|
| `Field` | `0` | Finite field element. Native ZK type. |
| `Boolean` | `false` | True/false. |
| `Bytes<N>` | `0x00...` | Fixed-size byte array. N is a compile-time constant. |
| `Uint<N>` | `0` | Unsigned integer. N = 8, 16, 32, 64, 128. |
| `Uint<MIN..MAX>` | `MIN` | Bounded unsigned integer (range-checked in-circuit). |

**WARNING:** `Uint<256>` is NOT supported. Maximum is `Uint<128>`.

### Algebraic Types

#### `Maybe<T>`

Optional value. Equivalent to `Option` in Rust or `T | null` in TypeScript.

```compact
const present = some<Uint<64>>(42);
const absent = none<Uint<64>>();

if (present.is_some) {
  const val = present.value;
}
```

**WARNING:** Accessing `.value` on a `none` fails at runtime. Always check `.is_some` first.

#### `Either<L, R>`

Tagged union. Used extensively for `ZswapCoinPublicKey | ContractAddress` recipient types.

```compact
const wallet = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
const contract = right<ZswapCoinPublicKey, ContractAddress>(kernel.self());
```

### Midnight-Specific Types

| Type | Description |
|------|-------------|
| `ZswapCoinPublicKey` | Wallet public key for coin operations (unlinkable per-tx) |
| `ContractAddress` | On-chain contract address |
| `ShieldedCoinInfo` | Coin descriptor for shielded token operations (struct: `nonce: Bytes<32>`, `color: Bytes<32>`, `value: Uint<128>`). Replaces old `CoinInfo`/`QualifiedCoinInfo`. |
| `TokenType` | Token type identifier (derived from domain + contract address) |
| `SendResult` | Result of a `sendImmediateShielded` call |

### Custom Types

```compact
export enum GameState { waiting, playing, finished }
export struct PlayerConfig { name: Opaque<"string">, score: Uint<32> }
```

**WARNING:** Enum access uses dot notation: `GameState.waiting`. NOT `GameState::waiting` (Rust syntax does not apply).

### Opaque Types

Bridge TypeScript types into Compact as opaque blobs.

```compact
export ledger message: Opaque<"string">;
export ledger config: Opaque<"Config">;
```

**WARNING:** Cannot hash Opaque types directly. `persistentHash<Opaque<"string">>(msg)` is a compiler error in 0.30.0+ (crashed in earlier versions). Convert to `Bytes<N>` first via a witness.

### Type Casting

Use `as` for conversions between compatible types.

```compact
const bytes: Bytes<32> = myField as Bytes<32>;
const num: Uint<64> = myField as Uint<64>;
const field: Field = myUint as Field;
const chained: Bytes<32> = sequence as Field as Bytes<32>;
```

**WARNING:** Not all casts are valid. The compiler rejects incompatible casts at compile time. When in doubt, go through `Field` as an intermediate type.

---

## 5. Control Flow

### If/Else

```compact
if (condition) {
  // ...
} else if (otherCondition) {
  // ...
} else {
  // ...
}
```

There is no `switch`, `match`, or ternary operator.

**WARNING:** Conditions using witness-derived values MUST be wrapped in `disclose()`:

```compact
if (disclose(secretValue > threshold)) { /* ... */ }
```

### Assertions

```compact
assert(condition, "Error message");
assert(disclose(privateCondition), "Private check failed");
```

`assert` halts circuit execution and fails the proof if the condition is false. The error message is for developer debugging only -- it is not visible on-chain.

### Loops

There are NO loops in Compact (`for`, `while`, `do` do not exist). Use:

- Unrolled operations on Vector elements with literal indices
- Recursion (internal circuits calling themselves)
- Off-chain computation in witnesses, passing the result back in

---

## 6. Operators

### Arithmetic

| Operator | Description | Notes |
|----------|-------------|-------|
| `+` | Addition | Overflow wraps within the type's range |
| `-` | Subtraction | Underflow fails the circuit |
| `*` | Multiplication | Overflow wraps within the type's range |

**WARNING:** There is no `/` (division) or `%` (modulo). For division, compute the result in a witness and verify with multiplication in-circuit:

```compact
witness computeQuotient(a: Uint<64>, b: Uint<64>): Uint<64>;

export circuit divide(a: Uint<64>, b: Uint<64>): Uint<64> {
  const q = disclose(computeQuotient(a, b));
  assert(q * b == a, "Division inexact");
  return q;
}
```

### Comparison

| Operator | Description |
|----------|-------------|
| `==` | Equal |
| `!=` | Not equal |
| `<` | Less than |
| `>` | Greater than |
| `<=` | Less than or equal |
| `>=` | Greater than or equal |

### Logical

| Operator | Description |
|----------|-------------|
| `&&` | Logical AND |
| `\|\|` | Logical OR |
| `!` | Logical NOT |

**WARNING:** There are no bitwise operators (`&`, `|`, `^`, `~`, `<<`, `>>`). Bit manipulation must be done via witnesses with in-circuit verification.
