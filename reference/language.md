# Compact Language Reference

Compact is Midnight's domain-specific smart contract language. It compiles to
zero-knowledge circuits, enabling privacy-preserving computation. This reference
covers every language feature with code examples, known bugs, and production
guidance.

---

## 1. Pragma and Imports

Every Compact source file must begin with a pragma declaring the minimum
language version. Imports follow immediately after.

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;                   // ALWAYS required — provides built-in types and functions
import "./path/to/Module" prefix Module_;         // local module with prefix
import "./oz/Ownable" prefix Ownable_;            // OpenZeppelin composition pattern
```

The `CompactStandardLibrary` import is mandatory in every file. Omitting it
causes missing-type errors for core types like `Counter`, `Map`, `Maybe`, etc.

> **NOTE:** The pragma version should match or exceed the compiler version you
> target. As of early 2026, `0.20` is the minimum practical floor; current
> toolchains are in the `0.25`--`0.28` range.

---

## 2. Primitive Types

### Field

The fundamental numeric type in ZK circuits. A finite field element over the
BN254 curve's scalar field.

```compact
ledger value: Field;

export circuit setField(v: Field): [] {
  value = v;
}
```

> **WARNING — Arithmetic overflow bug:** `Field` arithmetic does not wrap on
> overflow. Adding two values near `MAX_FIELD` returns an out-of-bounds `bigint`
> in the TypeScript runtime rather than wrapping modulo the field order. This can
> cause proof generation failures or incorrect results. **Avoid `Field`
> arithmetic for user-facing math until this is fixed.** Use `Uint<N>` instead.

### Boolean

Standard true/false type. Used in conditionals and assertions.

```compact
ledger isActive: Boolean;

export circuit activate(): [] {
  isActive = true;
}

export circuit deactivate(): [] {
  isActive = false;
}
```

### Bytes\<N\>

Fixed-size byte array. `N` is the number of bytes. `Bytes<32>` is the most
common size, used for hashes, public keys, and identifiers.

```compact
export ledger owner: Bytes<32>;
export ledger dataHash: Bytes<32>;

export circuit setOwner(addr: Bytes<32>): [] {
  owner = addr;
}
```

> **WARNING — No byte indexing:** You cannot access individual bytes within a
> `Bytes<N>` value. There is no subscript operator. Individual byte access is a
> planned feature that does not exist yet.

> **WARNING — Equality comparison bug:** In some compiler versions, comparing
> `Bytes<32>` values with `==` causes a compiler crash. If you hit this, use
> hashing to compare:
>
> ```compact
> // Workaround for Bytes<32> equality crash
> const hashA = persistentHash<Vector<1, Bytes<32>>>([a]);
> const hashB = persistentHash<Vector<1, Bytes<32>>>([b]);
> assert(hashA == hashB, "mismatch");
> ```

### Uint\<N\>

Unsigned integer types. Supported widths: 8, 16, 32, 64, 128.

```compact
export ledger balance: Uint<64>;
export ledger count: Uint<32>;

export circuit deposit(amount: Uint<64>): [] {
  balance = balance + amount;
}
```

> **WARNING — Uint\<256\> is NOT supported.** The maximum width is `Uint<128>`.
> Attempting `Uint<256>` produces a compilation error.

#### Bounded Uint

You can restrict the range with `Uint<MIN..MAX>` syntax:

```compact
// Value must be between 1 and 100 inclusive
export circuit setBoundedValue(v: Uint<1..100>): [] {
  ledger stored: Uint<1..100>;
  stored = v;
}
```

The compiler enforces the bounds at the circuit level, so out-of-range values
cause proof generation failure.

### Opaque\<"string"\>

Bridges TypeScript types into Compact. The string argument names the TypeScript
type. Opaque values cannot participate in circuit computation directly — they are
passed through witnesses and stored in ledger state.

```compact
export sealed ledger name: Opaque<"string">;
export ledger metadata: Opaque<"string">;

witness getUserName(): Opaque<"string">;

constructor() {
  name = disclose(getUserName());
}
```

Common uses: strings, JSON blobs, complex objects that don't need ZK
verification.

> **WARNING — Cannot hash Opaque values:** Passing an `Opaque<"...">` value to
> `persistentHash` or `transientHash` causes a compiler crash. If you need to
> hash user-provided data, accept it as `Bytes<N>` and have the TypeScript
> witness encode it before passing.

---

## 3. Collection Types

### Counter

A ledger-backed integer counter. The most gas-efficient way to track numeric
state. Counters support concurrent increments from multiple transactions without
conflicts.

```compact
export ledger totalVotes: Counter;

export circuit vote(): [] {
  totalVotes.increment(1);
}

export circuit unvote(): [] {
  totalVotes.decrement(1);
}

export pure circuit isUnderLimit(c: Counter): Boolean {
  return c.lessThan(100);
}
```

**Available methods:**

| Method | Description |
|--------|-------------|
| `.increment(n)` | Add `n` to the counter |
| `.decrement(n)` | Subtract `n` from the counter |
| `.read()` | Get the current value |
| `.lessThan(n)` | Returns `Boolean` — whether value < n |
| `.resetToDefault()` | Reset counter to zero |

> **WARNING — No `.value()` method.** Use `.read()` to get the current value.
> Calling `.value()` is a compilation error.

### Map\<K, V\>

Ledger-backed key-value store. Expensive in terms of circuit size (each
operation increases the `k` value). Use sparingly.

```compact
export ledger balances: Map<Bytes<32>, Uint<64>>;

export circuit setBalance(addr: Bytes<32>, amount: Uint<64>): [] {
  balances.insert(addr, amount);
}

export circuit getBalance(addr: Bytes<32>): Uint<64> {
  return balances.lookup(addr);
}

export circuit removeAccount(addr: Bytes<32>): [] {
  balances.remove(addr);
}

export circuit hasAccount(addr: Bytes<32>): Boolean {
  return balances.member(addr);
}
```

**Available methods:**

| Method | Description |
|--------|-------------|
| `.insert(key, value)` | Insert or update a key-value pair |
| `.remove(key)` | Remove a key |
| `.lookup(key)` | Get value for key (undefined behavior if missing — check `.member()` first) |
| `.member(key)` | Returns `Boolean` — whether key exists |
| `.isEmpty()` | Returns `Boolean` |
| `.size()` | Returns the number of entries |
| `.resetToDefault()` | Clear the entire map |

> **WARNING — Cannot iterate.** There is no `forEach`, `keys()`, or `entries()`
> method. Maps cannot be iterated within a circuit. If you need iteration,
> maintain a parallel `Vector` of keys or perform iteration off-chain in a
> witness.

> **WARNING — Cannot return Map from witnesses.** Witnesses cannot return `Map`
> types. Return the individual key-value pairs and insert them in the circuit.

### Set\<T\>

Ledger-backed collection of unique values. Semantically similar to `Map` but
stores only keys.

```compact
export ledger voters: Set<Bytes<32>>;

export circuit registerVoter(voter: Bytes<32>): [] {
  voters.insert(voter);
}

export circuit hasVoted(voter: Bytes<32>): Boolean {
  return voters.member(voter);
}
```

**Available methods:** Same interface as `Map` minus `.lookup()` — uses
`.insert()`, `.remove()`, `.member()`, `.isEmpty()`, `.size()`,
`.resetToDefault()`.

### Vector\<N, T\>

Fixed-size array. `N` is the element count (known at compile time), `T` is the
element type. Vectors are circuit-friendly and support functional operations.

```compact
// Declare a vector of 5 Fields
const scores: Vector<5, Field> = [10, 20, 30, 40, 50];

// Access by LITERAL index only
const first = scores[0];
const third = scores[2];

// Fold (reduce) — the only way to aggregate
export pure circuit sum(v: Vector<5, Field>): Field {
  return fold(v, 0, (acc: Field, elem: Field) => acc + elem);
}
```

> **WARNING — No dynamic indexing.** You cannot use a variable as an index:
>
> ```compact
> // DOES NOT COMPILE
> const i: Uint<32> = 2;
> const val = scores[i];  // ERROR: index must be a literal
> ```
>
> Workaround: use a chain of `if` statements or a fold.

> **WARNING — Immutable.** There is no syntax to update a single element in a
> vector. You must construct an entirely new vector. This is a planned feature.

**Functional methods:**

```compact
// map — transform each element
const doubled = map(scores, (x: Field) => x * 2);

// fold — reduce to a single value
const total = fold(scores, 0, (acc: Field, x: Field) => acc + x);
```

### Maybe\<T\>

Optional value type. Either holds a value (`some`) or is empty (`none`).

```compact
const found: Maybe<Uint<64>> = some<Uint<64>>(42);
const missing: Maybe<Uint<64>> = none<Uint<64>>();

export circuit processOptional(opt: Maybe<Uint<64>>): Uint<64> {
  if (opt.is_some) {
    return opt.value;
  }
  return 0;
}
```

**Access patterns:**

| Field | Description |
|-------|-------------|
| `.is_some` | `Boolean` — whether value is present |
| `.value` | The contained value (undefined behavior if `is_some` is false) |

**Constructors:**

```compact
some<T>(val)   // wrap a value
none<T>()      // empty
```

> **NOTE:** Always check `.is_some` before accessing `.value`. Accessing
> `.value` on a `none` produces undefined circuit behavior (not a runtime
> error).

### Either\<L, R\>

A union type holding one of two possible values. Used extensively in OpenZeppelin
contracts for wallet-or-contract address patterns.

```compact
// Represent an address as either a wallet key or contract address
const walletAddr = left<ZswapCoinPublicKey, ContractAddress>(myPubKey);
const contractAddr = right<ZswapCoinPublicKey, ContractAddress>(kernel.self());

export circuit processAddress(
  addr: Either<ZswapCoinPublicKey, ContractAddress>
): [] {
  if (addr.is_left) {
    // handle wallet: addr.left is the ZswapCoinPublicKey
    sendToWallet(addr.left);
  } else {
    // handle contract: addr.right is the ContractAddress
    sendToContract(addr.right);
  }
}
```

**Access patterns:**

| Field | Description |
|-------|-------------|
| `.is_left` | `Boolean` — whether this is a left value |
| `.left` | The left value (undefined if `is_left` is false) |
| `.right` | The right value (undefined if `is_left` is true) |

**Constructors:**

```compact
left<L, R>(val)    // left variant
right<L, R>(val)   // right variant
```

---

## 4. Midnight-Specific Types

### ZswapCoinPublicKey

The public key associated with a wallet. Used for coin operations (send,
receive, mint). Obtained from witnesses.

```compact
witness ownPublicKey(): ZswapCoinPublicKey;

export circuit deposit(): [] {
  const pk = ownPublicKey();
  receive(coin);
}
```

### ContractAddress

The on-chain address of a deployed contract. Obtained from `kernel.self()` for
the current contract.

```compact
export circuit getContractAddress(): ContractAddress {
  return kernel.self();
}
```

### CoinInfo

Descriptor for a coin type in the Zswap protocol. Returned by `tokenType()`.

```compact
const myTokenType: CoinInfo = tokenType(pad(32, "LOKx"), kernel.self());
```

### SendResult

The return value from `send()` operations.

```compact
export circuit withdraw(recipient: ZswapCoinPublicKey, amount: Uint<64>): [] {
  const result: SendResult = send(myTokenType, recipient, amount);
  // result indicates success/failure
}
```

---

## 5. Custom Types

### Enum

Enums define a fixed set of named values. They compile to field elements.

```compact
export enum Status {
  pending,
  active,
  completed,
  cancelled
}

export ledger currentStatus: Status;

export circuit setStatus(s: Status): [] {
  currentStatus = s;
}

export circuit markActive(): [] {
  currentStatus = Status.active;
}
```

> **NOTE:** Enum access uses **dot notation**: `Status.active`. Not
> `Status::active` (Rust style) and not `Status.Active` (first letter is
> lowercase).

### Struct

Structs group named fields into a compound type.

```compact
export struct Bid {
  bidder: Bytes<32>,
  amount: Uint<64>,
  timestamp: Uint<64>
}

export ledger highestBid: Bid;

export circuit placeBid(b: Bid): [] {
  assert(b.amount > highestBid.amount, "Bid too low");
  highestBid = b;
}
```

Struct literals use curly-brace syntax:

```compact
const newBid: Bid = Bid {
  bidder: callerKey,
  amount: 1000,
  timestamp: currentTime
};
```

---

## 6. Ledger Declarations

Ledger state is the on-chain storage of a contract. Each ledger variable is
declared as an individual statement. There are three visibility levels.

> **WARNING — Block syntax is DEPRECATED.** Do **not** use `ledger { ... }`
> block syntax. It causes parse errors in current compilers. Always use
> individual `ledger` statements.

### export ledger (Public)

Readable by anyone via the indexer. Written by circuits.

```compact
export ledger owner: Bytes<32>;
export ledger totalSupply: Counter;
export ledger balances: Map<Bytes<32>, Uint<64>>;
```

### sealed ledger (Write-Once)

Set once in the constructor, then immutable for the contract's lifetime. Often
combined with `export`.

```compact
export sealed ledger name: Opaque<"string">;
export sealed ledger symbol: Opaque<"string">;
export sealed ledger decimals: Uint<8>;

constructor() {
  name = disclose(getName());
  symbol = disclose(getSymbol());
  decimals = 18;
}
```

> **NOTE:** `sealed` means the value can only be assigned in the `constructor`.
> Any attempt to assign to a sealed ledger variable in a circuit produces a
> compilation error.

### ledger (Private to Contract)

Not exported. Only accessible within the contract's own circuits. Still stored
on-chain (in the contract's state tree), but not exposed via the public indexer
API.

```compact
ledger secretSeed: Bytes<32>;
ledger internalCounter: Counter;
```

> **NOTE:** "Private to contract" does not mean zero-knowledge private. The data
> is on-chain in the contract's Merkle tree. It is not queryable via the standard
> indexer, but a sufficiently motivated party running their own node could
> potentially access it. For true privacy, keep data in **private state**
> (off-chain, per-user, managed via witnesses).

---

## 7. Circuits

Circuits are the core computational units in Compact. They compile to ZK
circuits (arithmetic constraint systems) and every execution produces a
verifiable proof.

### export circuit (Public Entry Point)

Callable from TypeScript via the generated SDK. Each call generates a ZK proof
and submits a transaction.

```compact
export circuit increment(amount: Uint<32>): [] {
  counter.increment(amount);
}

export circuit getOwner(): Bytes<32> {
  return owner;
}
```

### circuit (Internal)

Not callable from TypeScript. Only callable from other circuits within the same
contract. Use for shared logic.

```compact
circuit validateCaller(caller: Bytes<32>): [] {
  assert(caller == owner, "Unauthorized");
}

export circuit transfer(to: Bytes<32>, amount: Uint<64>): [] {
  const caller = disclose(publicKey(localSecretKey()));
  validateCaller(caller);
  // ... transfer logic
}
```

### pure circuit (Stateless)

Cannot read or write ledger state. No side effects. Used for pure computation
(hashing, validation logic, math).

```compact
export pure circuit hashData(data: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<1, Bytes<32>>>([data]);
}

pure circuit addSafe(a: Uint<64>, b: Uint<64>): Uint<64> {
  return a + b;
}
```

### Return Types

- Use `[]` (empty tuple) for circuits that return nothing.
- Use a concrete type for circuits that return a value.
- There is **no `Void` keyword**. The empty tuple `[]` is the void equivalent.

```compact
// Void return — use empty tuple
export circuit doSomething(): [] {
  counter.increment(1);
}

// Typed return
export circuit getCount(): Uint<64> {
  return counter.read();
}
```

### Critical Performance Notes

> **WARNING — Cross-circuit calls explode `k` value.** Calling an `export
> circuit` from another `export circuit` dramatically increases the circuit's
> constraint count (`k` value). This makes proof generation exponentially slower.
> **Prefer `circuit` (internal) or `pure circuit` for shared logic.** Only use
> `export` on circuits that must be callable from TypeScript.

```compact
// BAD — calling exported from exported doubles k
export circuit a(): [] { /* ... */ }
export circuit b(): [] { a(); }    // k explodes

// GOOD — internal helper keeps k manageable
circuit aInternal(): [] { /* ... */ }
export circuit a(): [] { aInternal(); }
export circuit b(): [] { aInternal(); }
```

### Restrictions

- **No mutable variables.** All bindings in circuits are `const`. There is no
  `let` or `var`.
- **No loops.** Use recursion or `fold` on vectors. See
  [Control Flow](#11-control-flow) below.
- **No `function` keyword.** Always use `circuit` or `pure circuit`.

---

## 8. Witnesses

Witnesses bridge private off-chain data into Compact circuits. They are
**declared** in Compact (signature only, no body) and **implemented** in
TypeScript.

### Declaration Syntax (Compact)

```compact
// Simple: no parameters
witness localSecretKey(): Bytes<32>;

// With parameters
witness getAmount(max: Uint<64>): Uint<64>;

// Returning Midnight-specific types
witness ownPublicKey(): ZswapCoinPublicKey;

// Returning custom types
witness getUserConfig(): Opaque<"UserConfig">;
```

> **NOTE:** Witness declarations end with a semicolon and have **no body**. If
> you write `{ ... }` after a witness declaration, the compiler will error.

### TypeScript Implementation Pattern

Every witness function receives a `WitnessContext` and returns a tuple of
`[newPrivateState, returnValue]`.

```typescript
import {
  WitnessContext,
  Ledger,
} from "../managed/contract/contract/index.js";

// Define private state shape
interface PrivateState {
  readonly secretKey: Uint8Array;
  readonly amount: bigint;
}

// Implement witnesses
export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, PrivateState>
  ): [PrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getAmount: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    max: bigint
  ): [PrivateState, bigint] => {
    // Clamp to max
    const amount = privateState.amount > max ? max : privateState.amount;
    return [privateState, amount];
  },

  ownPublicKey: (
    { privateState }: WitnessContext<Ledger, PrivateState>
  ): [PrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];  // simplified
  },
};
```

### Key Properties

1. **Witness code is UNVERIFIED.** It runs on the user's machine, outside the ZK
   proof. The prover can return any value. Never trust a witness value without
   `disclose()` and/or an assertion.

2. **State threading.** The first element of the return tuple is the
   (potentially updated) private state. This is how witnesses can maintain
   mutable off-chain state across calls.

3. **WitnessContext provides ledger access.** The context includes a read-only
   view of the current public ledger state, enabling witnesses to make decisions
   based on on-chain data.

> **WARNING — Cannot return Map from witnesses.** The `Map` type cannot be
> serialized across the witness boundary. If you need to pass map-like data from
> TypeScript, flatten it into arrays or pass individual key-value pairs and
> insert them in the circuit.

---

## 9. Constructor

The constructor runs exactly once when the contract is deployed. It initializes
ledger state, including sealed variables.

```compact
export ledger owner: Bytes<32>;
export sealed ledger name: Opaque<"string">;
export ledger totalSupply: Counter;

witness localSecretKey(): Bytes<32>;
witness getContractName(): Opaque<"string">;

constructor() {
  // Set the owner from a witness (requires disclose)
  owner = disclose(publicKey(localSecretKey()));

  // Set sealed values (can ONLY be set here)
  name = disclose(getContractName());

  // Initialize counters
  totalSupply.increment(0);
}
```

### Rules

- Only `sealed ledger` variables **must** be set here; other ledger variables
  start at their type's default value (zero, empty, false).
- The constructor can call witnesses and internal circuits.
- `disclose()` is required for any witness-derived value written to ledger state,
  even in the constructor.
- There is exactly one constructor per contract. It takes no parameters.

---

## 10. Operators and Expressions

### Arithmetic Operators

```compact
const sum = a + b;         // addition
const diff = a - b;        // subtraction
const product = a * b;     // multiplication
```

> **WARNING — No modulo operator.** Using `%` (mod) causes a **Rust panic in the
> compiler**. If you need modular arithmetic, compute it in a witness and pass
> the result back via `disclose()`.

> **WARNING — No division operator in-circuit.** Use fixed-point arithmetic with
> witness-computed division:
>
> ```compact
> witness computeDivision(a: Uint<64>, b: Uint<64>): Uint<64>;
>
> export circuit divide(a: Uint<64>, b: Uint<64>): Uint<64> {
>   const result = disclose(computeDivision(a, b));
>   // Verify: result * b should approximately equal a
>   assert(result * b <= a, "Division overflow");
>   return result;
> }
> ```

> **WARNING — No floating point.** Compact has no float types. Use fixed-point
> representation (e.g., store cents instead of dollars, or use a scaling factor).

### Comparison Operators

```compact
const eq = a == b;         // equality
const neq = a != b;        // inequality
const lt = a < b;          // less than
const gt = a > b;          // greater than
const lte = a <= b;        // less than or equal
const gte = a >= b;        // greater than or equal
```

### Logical Operators

```compact
const both = a && b;       // logical AND
const either = a || b;     // logical OR
const neg = !a;            // logical NOT
```

### Assignment

```compact
ledgerVar = value;                  // ledger state assignment
const localConst = expression;      // local constant binding
```

> **NOTE:** All local bindings are `const`. There is no `let` or `var` for
> mutable locals in circuits.

---

## 11. Control Flow

### if / else

The only branching construct. Compact has **no loops** and **no switch/match**
statements.

```compact
export circuit process(amount: Uint<64>): [] {
  if (amount > 100) {
    counter.increment(amount);
  } else {
    counter.increment(1);
  }
}

// Nested if/else
export circuit categorize(score: Uint<32>): Uint<8> {
  if (score >= 90) {
    return 3;
  } else if (score >= 70) {
    return 2;
  } else if (score >= 50) {
    return 1;
  } else {
    return 0;
  }
}
```

### No Loops

There are no `for`, `while`, or `do` loops. This is a fundamental constraint of
ZK circuits — the circuit size must be known at compile time.

**Alternatives to loops:**

1. **`fold` on a Vector** — the primary loop replacement.

   ```compact
   export pure circuit sumVector(v: Vector<10, Uint<64>>): Uint<64> {
     return fold(v, 0, (acc: Uint<64>, elem: Uint<64>) => acc + elem);
   }
   ```

2. **`map` on a Vector** — transform each element.

   ```compact
   export pure circuit doubleAll(v: Vector<5, Uint<32>>): Vector<5, Uint<32>> {
     return map(v, (x: Uint<32>) => x * 2);
   }
   ```

3. **Recursion** — call internal circuits recursively (limited by circuit depth).

4. **Off-chain computation** — perform iteration in a witness and pass the
   result back.

### No Switch / Match

There is no `switch`, `match`, or `when` construct. Use chained `if/else`
statements.

```compact
// Simulating a match on an enum
export circuit handleStatus(s: Status): [] {
  if (s == Status.pending) {
    // ...
  } else if (s == Status.active) {
    // ...
  } else if (s == Status.completed) {
    // ...
  } else {
    // Status.cancelled
    // ...
  }
}
```

---

## 12. Type Casting

Use the `as` keyword to cast between compatible types.

```compact
// Field to Bytes
const b: Bytes<32> = myField as Bytes<32>;

// Field to Uint
const n: Uint<64> = myField as Uint<64>;

// Uint width conversion
const wide: Uint<64> = narrowValue as Uint<64>;
const narrow: Uint<32> = wideValue as Uint<32>;
```

> **NOTE:** Casting does not perform range checking at the circuit level. Casting
> a large `Uint<64>` to `Uint<32>` may silently truncate. Validate ranges
> explicitly if correctness depends on the value fitting.

---

## 13. Hashing

Compact provides two hash functions, each with different cost profiles.

### persistentHash (SHA-256)

Standard SHA-256 hash. Produces deterministic, cross-platform results. Expensive
in-circuit (many constraints).

```compact
// Hash a single Bytes<32> value
const h: Bytes<32> = persistentHash<Vector<1, Bytes<32>>>([data]);

// Hash multiple values
const h2: Bytes<32> = persistentHash<Vector<2, Bytes<32>>>([data1, data2]);

// Hash a struct (serialize fields into a vector)
const commitHash: Bytes<32> = persistentHash<Vector<3, Bytes<32>>>([
  bid.bidder,
  bid.amount as Bytes<32>,
  bid.nonce
]);
```

**When to use:** Commit-reveal schemes, persistent identifiers, anything that
must be verifiable off-chain or across systems.

### transientHash (Poseidon)

ZK-native Poseidon hash. Approximately **10x cheaper** in-circuit than SHA-256.
Not directly compatible with off-chain SHA-256 implementations.

```compact
const h: Bytes<32> = transientHash<Vector<1, Bytes<32>>>([data]);
```

**When to use:** Internal circuit comparisons, nullifiers, any hash that only
needs to be verified within ZK proofs (not by external systems).

### Hashing Syntax Pattern

Both functions use the same generic syntax:

```
persistentHash<Vector<N, T>>([elem1, elem2, ..., elemN])
transientHash<Vector<N, T>>([elem1, elem2, ..., elemN])
```

Where `N` is the number of elements and `T` is the element type. All elements
must be the same type.

> **WARNING — Cannot hash Opaque types.** Passing `Opaque<"...">` to either hash
> function causes a compiler crash. Convert to `Bytes<N>` first via a witness.

---

## 14. Disclosure

`disclose()` is the core privacy primitive. It explicitly marks a value as
"revealed to the network" — written to the public ledger or used in a publicly
verifiable way.

### When disclose() Is Required

Since Compact 0.16+, `disclose()` is **mandatory** for:

1. Any witness-derived value written to `export ledger` state.
2. Any witness-derived value used in a boolean condition that affects control
   flow.
3. Any witness-derived value used in an assertion.

Omitting `disclose()` where required produces a **compilation error**.

### Writing to Ledger

```compact
witness localSecretKey(): Bytes<32>;

export circuit register(): [] {
  // CORRECT — disclose wraps the witness-derived value
  owner = disclose(publicKey(localSecretKey()));
}

export circuit registerBroken(): [] {
  // WRONG — compilation error: witness-derived value not disclosed
  // owner = publicKey(localSecretKey());
}
```

### In Conditionals

```compact
witness getGuess(): Field;

export circuit checkGuess(secret: Field): Boolean {
  const guess = getGuess();

  // CORRECT — disclose the comparison result
  if (disclose(guess == secret)) {
    return true;
  }
  return false;
}
```

### In Assertions

```compact
witness localSecretKey(): Bytes<32>;

export circuit ownerOnly(): [] {
  const caller = publicKey(localSecretKey());

  // CORRECT — disclose in assertion
  assert(disclose(caller == owner), "Not the owner");
}
```

### What disclose() Does NOT Mean

- It does not mean the disclosed value is publicly visible to everyone. It means
  the value is part of the **public transcript** of the proof — verifiers can
  see it.
- It does not reveal the witness inputs. Only the disclosed expression's result
  is revealed. If you write `disclose(guess == secret)`, only the boolean result
  (`true`/`false`) is revealed, not `guess` or `secret`.

> **NOTE:** Be deliberate about what you disclose. Each `disclose()` call is a
> privacy decision. Disclosing a comparison result (`disclose(a == b)`) reveals
> less than disclosing the value itself (`disclose(a)`).

---

## 15. Assertions

`assert` checks a condition and aborts the transaction with an error message if
it fails. The proof will not be valid if the assertion fails.

```compact
// Basic assertion
assert(amount > 0, "Amount must be positive");

// Assertion on ledger state
assert(counter.lessThan(1000), "Counter overflow");

// Assertion with disclose (for witness-derived values)
assert(disclose(caller == owner), "Unauthorized");

// Multiple assertions
export circuit transfer(to: Bytes<32>, amount: Uint<64>): [] {
  assert(amount > 0, "Zero transfer");
  assert(balances.member(to), "Recipient not registered");
  assert(disclose(publicKey(localSecretKey()) == owner), "Not owner");
  // ... transfer logic
}
```

The error message string is included in the compiled output and visible to the
caller on failure. Do not put sensitive information in assertion messages.

---

## 16. Module System

Compact supports importing other Compact files using a prefix-based module
system. This is the primary composition mechanism, used extensively by
OpenZeppelin's Compact contracts.

### Import Syntax

```compact
import "./path/to/Module" prefix Module_;
```

All exported symbols from the imported module are prefixed with the specified
prefix.

### Accessing Imported Symbols

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;
import "./Ownable" prefix Ownable_;

// Imported ledger variables become: Ownable_owner
// Imported circuits become: Ownable_transferOwnership
// Imported types become: Ownable_OwnershipTransferred

export circuit changeOwner(newOwner: Bytes<32>): [] {
  Ownable_transferOwnership(newOwner);
}
```

### OpenZeppelin Composition Pattern

The standard pattern for building contracts from reusable modules:

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;
import "./oz/Ownable" prefix Ownable_;
import "./oz/Pausable" prefix Pausable_;
import "./oz/FungibleToken" prefix FT_;

witness localSecretKey(): Bytes<32>;

constructor() {
  Ownable_constructor(disclose(publicKey(localSecretKey())));
}

export circuit mint(to: Bytes<32>, amount: Uint<64>): [] {
  Ownable_onlyOwner(disclose(publicKey(localSecretKey())));
  Pausable_requireNotPaused();
  FT_mint(to, amount);
}
```

### Module Rules

1. All `import` statements must appear after the `pragma` and before any other
   declarations.
2. The prefix must end with an underscore by convention (e.g., `Module_`).
3. Imported ledger variables become part of the importing contract's ledger
   state, prefixed accordingly.
4. Circular imports are not supported.

---

## 17. Coin Operations

Compact provides built-in functions for working with Midnight's shielded token
system (Zswap).

### tokenType — Define a Token

Creates a `CoinInfo` descriptor for a specific token type.

```compact
const myToken: CoinInfo = tokenType(pad(32, "LOKx"), kernel.self());
```

- First argument: a `Bytes<32>` domain separator. Use `pad(32, "name")` to
  create a zero-padded byte array from a string.
- Second argument: the contract address (usually `kernel.self()`).

### receive — Accept Incoming Coins

Accepts a coin sent to the contract. Used in deposit circuits.

```compact
export circuit deposit(): [] {
  receive(coin);
}
```

The `coin` value is implicitly available — it represents the coin attached to
the transaction.

### send / sendImmediate — Send Coins

Send coins from the contract to a recipient.

```compact
export circuit withdraw(
  recipient: ZswapCoinPublicKey,
  amount: Uint<64>
): [] {
  const token = tokenType(pad(32, "LOKx"), kernel.self());
  sendImmediate(token, recipient, amount);
}
```

> **NOTE:** `sendImmediate` sends coins in the same transaction. There is also a
> deferred `send` variant for cross-contract operations.

### mint — Create New Tokens

Mints new shielded tokens.

```compact
export circuit mintTokens(
  recipient: ZswapCoinPublicKey,
  amount: Uint<64>,
  nonce: Bytes<32>
): [] {
  const token = tokenType(pad(32, "LOKx"), kernel.self());
  mintToken(pad(32, "LOKx"), amount, nonce, recipient);
}
```

- The `nonce` prevents double-minting. Each mint call must use a unique nonce.
- Only the contract that defines the token type can mint it.

### Full Token Example

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger owner: Bytes<32>;
export ledger totalMinted: Counter;
export sealed ledger tokenName: Opaque<"string">;

witness localSecretKey(): Bytes<32>;
witness ownPublicKey(): ZswapCoinPublicKey;
witness getMintNonce(): Bytes<32>;
witness getTokenName(): Opaque<"string">;

constructor() {
  owner = disclose(publicKey(localSecretKey()));
  tokenName = disclose(getTokenName());
}

export circuit mint(recipient: ZswapCoinPublicKey, amount: Uint<64>): [] {
  assert(disclose(publicKey(localSecretKey()) == owner), "Only owner can mint");
  const nonce = disclose(getMintNonce());
  mintToken(pad(32, "LOKx"), amount, nonce, recipient);
  totalMinted.increment(amount);
}

export circuit deposit(): [] {
  receive(coin);
}

export circuit withdraw(recipient: ZswapCoinPublicKey, amount: Uint<64>): [] {
  assert(disclose(publicKey(localSecretKey()) == owner), "Only owner can withdraw");
  const token = tokenType(pad(32, "LOKx"), kernel.self());
  sendImmediate(token, recipient, amount);
}
```

---

## Appendix A: Known Bugs and Gotchas

A consolidated list of compiler and runtime issues to be aware of.

| Issue | Severity | Description |
|-------|----------|-------------|
| Field overflow | High | Arithmetic on `Field` near max value returns out-of-bounds bigint instead of wrapping. Use `Uint<N>` for math. |
| Bytes\<32\> equality | Medium | `==` comparison on `Bytes<32>` causes compiler crash in some versions. Use hash comparison as workaround. |
| Uint\<256\> | Low | Not supported. Max is `Uint<128>`. |
| Opaque hashing | High | `persistentHash`/`transientHash` on `Opaque<"...">` is a compiler error in 0.30.0+ (crashed in earlier versions). Convert to `Bytes<N>` first. |
| Mod operator | High | Using `%` causes a Rust panic in the compiler. Compute modulo in a witness. |
| Dynamic vector index | Low | `v[i]` where `i` is a variable does not compile. Only literal indices work. |
| Vector mutation | Low | No syntax to update a single element. Must rebuild the entire vector. |
| Map from witness | Medium | Cannot return `Map` type from a witness function. Flatten to arrays. |
| Counter `.value()` | Low | Does not exist. Use `.read()` instead. |
| `ledger { }` block | Medium | Deprecated block syntax causes parse errors. Use individual statements. |
| Export-calls-export | High | Calling an `export circuit` from another `export circuit` dramatically increases `k` value and proof time. Use internal circuits. |
| No float/division | Medium | No `/` or `%` operators. Use witness-computed fixed-point arithmetic. |

## Appendix B: Type Quick Reference

```
Primitives:     Field, Boolean, Bytes<N>, Uint<N>, Uint<MIN..MAX>, Opaque<"T">
Collections:    Counter, Map<K,V>, Set<T>, Vector<N,T>, Maybe<T>, Either<L,R>
Midnight:       ZswapCoinPublicKey, ContractAddress, CoinInfo, SendResult
Custom:         enum Name { a, b, c }
                struct Name { field: Type, ... }
Void return:    []
```

## Appendix C: Reserved Keywords

```
pragma, import, prefix, export, sealed, ledger, circuit, pure, witness,
constructor, assert, disclose, const, if, else, return, true, false, enum,
struct, as
```

## Appendix D: Circuit Modifier Matrix

| Declaration | Callable from TS | Callable from Circuits | Reads/Writes Ledger | Generates Proof |
|-------------|-----------------|----------------------|--------------------|-----------------|
| `export circuit` | Yes | Yes (costly) | Yes | Yes |
| `circuit` | No | Yes | Yes | Yes (as part of caller) |
| `export pure circuit` | Yes | Yes | No | Yes |
| `pure circuit` | No | Yes | No | Yes (as part of caller) |

## Appendix E: Ledger Visibility Matrix

| Declaration | Public via Indexer | Writable in Constructor | Writable in Circuits |
|-------------|-------------------|------------------------|---------------------|
| `export ledger` | Yes | Yes | Yes |
| `export sealed ledger` | Yes | Yes | No |
| `sealed ledger` | No | Yes | No |
| `ledger` | No | Yes | Yes |
