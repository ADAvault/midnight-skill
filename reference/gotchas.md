# Gotchas & Hard-Won Learnings

Compiler findings and pitfalls discovered through real Discord conversations
and community experience with Midnight development. Every item here has been
confirmed by compilation error, runtime failure, or developer frustration.

---

## Compiler Gotchas

### 1. `ledger { }` block syntax is dead

The block-style ledger declaration was removed. It causes a parse error.

```compact
// BAD — parse error
ledger {
  counter: Counter;
  owner: Bytes<32>;
}

// GOOD — individual declarations
export ledger counter: Counter;
export ledger owner: Bytes<32>;
```

Each ledger variable must be declared separately with its own `export ledger`
statement. This was a syntax change that is not reflected in older tutorials.

### 2. `Void` does not exist

Compact has no `Void` type. The unit return type is an empty tuple.

```compact
// BAD — unknown type
export circuit doSomething(): Void { }

// GOOD — empty tuple
export circuit doSomething(): [] { }
```

> **NOTE:** This catches many developers coming from Rust, TypeScript, or Java
> where `void`/`Void` is standard. In Compact, `[]` is the zero-element tuple
> and serves the same purpose.

### 3. `function` keyword does not exist

There is no `function` keyword in Compact. Helper functions that do not touch
the ledger are declared as `pure circuit`.

```compact
// BAD — parse error
function helper(x: Field): Field { return x + 1; }

// GOOD — pure circuit for off-ledger helpers
pure circuit helper(x: Field): Field { return x + 1; }
```

`circuit` accesses ledger state. `pure circuit` is a pure computation with no
ledger access and no side effects.

### 4. Enum dot notation, not double colon

Compact uses dot notation for enum variants, not Rust-style `::`.

```compact
// BAD — parse error (Rust-style)
Choice::rock

// GOOD — dot notation
Choice.rock
```

This is one of the most common errors for developers with Rust experience.

### 5. `counter.value()` does not exist

Ledger state is read with `.read()`, not `.value()`.

```compact
// BAD — no such method
const val = counter.value();

// GOOD
const val = counter.read();
```

### 6. Dynamic vector indexing not supported

Vector indexing must use compile-time literal indices. Variable indices are
a parse error.

```compact
// BAD — parse error
const item = my_vector[variable];

// GOOD — literal index only
const item = my_vector[2];
```

> **WARNING:** If you need dynamic access into a vector, you must use `fold`
> to iterate through elements and match on position. There is no workaround
> that allows runtime-computed indices.

### 7. Map cannot be a witness type

Maps are ledger-only types. They cannot cross the witness boundary.

```compact
// BAD — witness cannot return Map
witness getMap(): Map<K, V>;

// GOOD — pass individual key-value pairs through witnesses
witness getKey(): K;
witness getValue(): V;
```

Structure your circuit to accept individual values from witnesses and
reconstruct or update map state on the ledger side.

### 8. Hashing Opaque types crashes the compiler

Passing an `Opaque` type to `persistentHash` causes a Rust panic in the
Compact compiler. This is not a graceful error — the compiler crashes.

```compact
// BAD — Rust panic / compiler crash
const h = persistentHash<Opaque<"string">>(name);

// GOOD — convert to Bytes<N> before hashing
const h = persistentHash<Bytes<32>>(nameAsBytes);
```

> **WARNING:** This is a compiler bug, not a user error. If you need to hash
> string-like data, convert it to `Bytes<N>` first, or use a witness to
> perform the hashing off-chain and pass the hash in.

### 9. No mod operator

Compact has no modulo operator (`%`, `mod`). Attempting to use one fails.
Worse, using cast to truncate as a workaround can trigger another Rust panic.

```compact
// BAD — no mod operator
const r = x % 2;
const r = x mod 2;

// GOOD — compute modulo in witness, verify in circuit
witness getRemainder(dividend: Field, divisor: Field): Field;

// In circuit:
const remainder = getRemainder(x, 2);
const quotient = (x - remainder) / 2;
assert(quotient * 2 + remainder == x);
assert(remainder < 2);
```

> **TIP:** The pattern is: compute the answer off-chain in a witness, then
> verify the mathematical relationship in-circuit. This is a common ZK
> idiom — verification is cheaper than computation.

### 10. Bytes indexing not supported

You cannot index individual bytes of a `Bytes<N>` value, nor convert
`Bytes<N>` to `Vector<N, Uint<8>>`.

```compact
// BAD — not supported
const firstByte = myBytes[0];
const vec: Vector<32, Uint<8>> = bytesToVector(myBytes);
```

> **NOTE:** This is a planned feature. Until it lands, structure your data
> as `Vector<N, Uint<8>>` from the start if you need per-byte access.

### 11. Vectors are immutable

You cannot update individual elements of a Vector. There is no subscript
assignment.

```compact
// BAD — cannot assign to vector element
my_vector[2] = newValue;

// GOOD — reconstruct the entire vector
// Struct spread syntax exists but NOT vector spread
```

If you need mutable collection semantics, consider using ledger `Map` or
restructuring so each element is a separate ledger variable.

### 12. Field arithmetic overflow

`Field` addition and multiplication do NOT perform modular arithmetic.
Adding values near `MAX_FIELD` returns an out-of-bounds bigint rather than
wrapping.

```compact
// DANGER — does not wrap, produces invalid bigint
const result = maxFieldValue + 1;
```

> **WARNING:** This is a known bug. Sergey (Midnight team) confirmed in
> April 2025 that it is "going to be fixed soon." Until then, use `Field`
> arithmetic with extreme caution and validate ranges manually if operating
> near field boundaries.

### 13. No signature verification in-circuit

Compact circuits cannot verify cryptographic signatures. There are no
built-in functions for Ed25519, ECDSA, or any signature scheme.

> **NOTE:** This needs either native Compact support or bigger integer
> operations to implement. It is not currently on a published timeline.
> Design around this by verifying signatures off-chain and passing results
> through witnesses, or by using ledger-level authorization patterns.

### 14. Iterating over dynamic List in circuit is impossible

`List` is a dynamic-sized ledger ADT. Attempting to loop over it in a
circuit fails with "incomplete chain of ledger indirects."

```compact
// BAD — runtime error
for (const item of myList) { ... }

// GOOD — use fixed-size Vector<N, T>
export ledger items: Vector<10, Item>;

// OR — process items individually via separate circuit calls
// Iterate off-chain, call a circuit per item
```

> **TIP:** The general pattern for unbounded collections is: keep a `List`
> on the ledger, but iterate over it off-chain in TypeScript. For each item,
> call a circuit that processes a single element. This is more gas-expensive
> but avoids the compiler limitation.

---

## SDK / Tooling Gotchas

### 15. ESM/CJS module conflicts

Midnight packages are ESM-only. Using them in a CommonJS project causes
`ERR_REQUIRE_ESM`.

```json
// package.json — REQUIRED
{
  "type": "module"
}
```

> **TIP:** Use Node.js 22+ for best ESM support. Ensure all imports use
> ESM syntax (`import`, not `require`). If you must support CJS consumers,
> use dynamic `import()`.

### 16. Buffer polyfill required in browser

Browser environments lack Node.js `Buffer`. Midnight SDK functions that
call `toHex` will throw.

```typescript
// Add early in app initialization (e.g., main.ts or index.ts)
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
```

> **NOTE:** This must execute before any Midnight SDK import that touches
> `Buffer`. Put it at the very top of your entry point.

### 17. WebSocket polyfill required for Node.js tests

Node.js test environments may lack a global WebSocket.

```typescript
// Add to test setup file
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
```

This is typically needed when running integration tests against indexer
or proof server endpoints from Node.js.

### 18. Vite requires special plugins

Midnight's WASM modules will not load in a default Vite configuration.

```bash
npm install vite-plugin-wasm vite-plugin-top-level-await @originjs/vite-plugin-commonjs
```

```typescript
// vite.config.ts
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import commonjs from '@originjs/vite-plugin-commonjs';

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), commonjs()],
  build: {
    target: 'esnext',  // REQUIRED — must be esnext
  },
});
```

> **WARNING:** The build target MUST be `esnext`. Lower targets (e.g.,
> `es2020`) will fail to handle top-level await in WASM modules.

### 19. First compile downloads ~500MB of ZK parameters

The first `compact compile` invocation downloads BLS ZK parameters from S3.
This can take a long time and may timeout on slow connections.

> **TIP:** Use the Brick Towers pre-baked proof server which includes
> parameters in the Docker image. This eliminates the download step entirely.
> Alternatively, retry with a stable network connection — the download
> resumes where it left off.

### 20. Dev tools vs toolchain update order matters

Updating in the wrong order breaks the toolchain.

```bash
# WRONG ORDER — can break installation
compact update 0.28.0
compact self update

# CORRECT ORDER — always update dev tools first
compact self update          # 1. Update the CLI itself
compact update 0.28.0        # 2. THEN update the toolchain version
```

> **WARNING:** If you run `compact update` before `compact self update`,
> the older CLI may not understand the newer toolchain format. Always
> update the CLI first, then the toolchain.

---

## Proof Server Gotchas

### 21. Docker command quoting

The `--network` flag in docker-compose requires careful quoting.

```yaml
# BAD — flag not recognized
command: midnight-proof-server --network testnet

# GOOD — wrap entire command in single quotes
command: "'midnight-proof-server --network testnet'"
```

This is a Docker/shell escaping issue, not a proof server issue.

### 22. 400 Bad Request with no useful error

A proof server returning 400 on valid-looking requests almost always means
a version mismatch.

**Cause:** The compiled contract was built with a different Compact toolchain
version than the proof server expects.

**Fix:** Align all versions per the Midnight compatibility matrix:
- Compact compiler version
- Proof server version
- SDK version
- Indexer version

> **TIP:** The Midnight team publishes a compatibility matrix with each
> release. Check it before mixing versions. A single version mismatch
> between any two components can cause silent 400 errors.

### 23. Proof server timeout on complex circuits

Circuits with constraint count k=17 or higher can exceed proof generation
time. The proof server may silently hang without returning an error.

**Fixes:**
- Optimize circuit complexity — reduce the number of constraints
- Inline circuits where possible to reduce overhead
- Use Brick Towers pre-baked proof server (better optimized)
- Increase server timeout configuration if available

> **WARNING:** A silently hanging proof server looks identical to a network
> issue from the client's perspective. Add client-side timeouts and logging
> to detect this.

### 24. BLS parameter download failures

The proof server downloads BLS parameters from S3 on first start. This
can fail after 3 attempts with no recovery.

**Fixes:**
- Pre-bake parameters into the Docker image
- Retry with a more stable network connection
- Host parameters locally and point the proof server at your mirror

### 25. "Failed direct assertion" in proof server

Stack trace through `midnight_base_crypto::proofs::ir_vm` means a Compact
`assert()` statement evaluated to false during proof generation.

```
// The error looks like:
// Failed direct assertion
// at midnight_base_crypto::proofs::ir_vm::...
```

**This is NOT a proof server bug.** Your private inputs (witnesses) do not
satisfy one of the circuit's assertions. Debug the assertion condition by
checking what values the witnesses are returning.

> **TIP:** Add logging in your witness functions to see what values are
> being passed to the circuit. The assertion that fails is somewhere in
> your Compact code — the stack trace does not tell you which one.

---

## Wallet / Deployment Gotchas

### 26. Lace wallet broken for 13+ circuits

When a contract has 13 or more circuits, the Lace wallet's
dapp-connector-api version mismatches with ledger-v7, causing failures.

> **NOTE:** A fix is expected in a future Lace release. Until then, use
> the JavaScript wallet SDK directly as a workaround for contracts with
> many circuits.

### 27. Windows is NOT supported

The Midnight toolchain does not work on Windows. This is not a "might not
work" — it is explicitly unsupported.

**Supported platforms:**
- Linux (x86_64)
- macOS (x86_64 and ARM)

> **NOTE:** WSL2 may work but is not officially supported. If you must
> develop on Windows, use a Linux VM or WSL2 and accept the risk of
> edge-case failures.

### 28. Wallet sync is slow

Initial wallet sync scans the entire chain. At 35,000+ indices scanning
at approximately 10 per second, this takes a long time.

```typescript
// Use the waitForFunds() pattern to avoid polling
await wallet.waitForFunds(expectedAmount);
```

> **TIP:** This only needs to happen once per wallet. Subsequent syncs
> are incremental. Future SDK versions will optimize initial sync.

### 29. DUST locked on transaction failure

Failed transactions can leave DUST tokens locked in the wallet, rendering
them unusable until the wallet is restarted.

> **WARNING:** This is a known SDK issue. If you notice your available
> balance decreasing after failed transactions, restart the wallet to
> unlock the stuck DUST.

### 30. Native token type mismatch

`nativeToken()` and `unshieldedToken().raw` return different-length hex
strings. Balance lookups that mix the two fail silently.

```typescript
// nativeToken() returns 68-char hex
const a = nativeToken();           // 68 chars

// unshieldedToken().raw returns 64-char hex
const b = unshieldedToken().raw;   // 64 chars

// BAD — silent mismatch, balance lookups return 0
if (a === b) { /* never true */ }

// GOOD — pick one and use it consistently throughout
const tokenType = nativeToken();   // Use everywhere
```

> **WARNING:** This fails silently. Your balance query returns 0 instead
> of throwing an error. If balances seem wrong, check token type string
> lengths first.

### 31. LevelDB LEVEL_LOCKED error

Two processes cannot open the same LevelDB folder simultaneously.

```typescript
// BAD — two instances on same folder
const provider1 = levelDbPrivateStateProvider('./state');
const provider2 = levelDbPrivateStateProvider('./state');  // LEVEL_LOCKED

// GOOD — separate folders for multi-user testing
const provider1 = levelDbPrivateStateProvider('./state-user1');
const provider2 = levelDbPrivateStateProvider('./state-user2');

// OR — use in-memory provider for tests
const provider = inMemoryPrivateStateProvider();
```

### 32. Verifier keys must be copied to web dist

dApp builds will fail at runtime if the keys and zkir directories from the
contract compilation output are not present in the web distribution folder.

```bash
# Add to your build script
cp -r ../contract/dist/managed/mycontract/keys ./dist/keys
cp -r ../contract/dist/managed/mycontract/zkir ./dist/zkir
```

> **TIP:** Add this to your build pipeline (e.g., a `postbuild` script in
> package.json) so it cannot be forgotten. Missing keys cause cryptic
> runtime errors that are hard to trace back to this step.

### 33. No block number or timestamp in Compact

Compact circuits have no built-in access to block height or wall clock time.

```compact
// BAD — no such built-in
const blockHeight = getCurrentBlock();
const now = getCurrentTime();

// GOOD — use a witness to pass time from TypeScript
witness getCurrentTime(): Uint<64>;
```

```typescript
// In your witness implementation
witnesses: {
  getCurrentTime: () => BigInt(Date.now()),
}
```

> **NOTE:** Newer versions of the SDK provide a `blockTimeGreaterThan`
> ledger ADT for time-based conditions. Check if your version supports it
> before rolling your own witness-based time solution.

### 34. No cross-contract calls

A deployed Compact contract cannot call another deployed contract. Each
contract is isolated.

> **NOTE:** This feature is in development and may arrive before or after
> mainnet. Until then, orchestrate multi-contract interactions off-chain
> by composing transactions in TypeScript that interact with multiple
> contracts sequentially.

### 35. DApp Connector API does not expose transfer

You cannot perform simple token transfers through the dapp-connector-api.
Even basic "send DUST from A to B" requires a circuit.

```compact
// You must build a circuit that performs the transfer
export circuit transfer(to: Bytes<32>, amount: Uint<64>): [] {
  // ... transfer logic ...
}
```

> **TIP:** This means every token operation, no matter how simple, requires
> a compiled circuit and proof generation. Plan your contract's circuit
> surface area accordingly — include basic transfer circuits even if they
> seem trivial.

---

## SDK / Runtime Gotchas (Compiler-Validated)

The following gotchas were discovered by compiling and testing skill examples against
Compact compiler 0.29.0 and `@midnight-ntwrk/compact-runtime`.

### 36. `createCircuitContext` takes 4 parameters, not 2

The signature is `createCircuitContext(contractAddress, zswapLocalState, contractState, privateState)`.
Passing only `(contractState, privateState)` throws `'contractState' parameter undefined has unexpected type`.

```typescript
// BAD — only 2 params
const ctx = createCircuitContext(contractState, privateState);

// GOOD — all 4 params
const addr = sampleContractAddress();
const ctx = createCircuitContext(
  addr,
  initial.currentZswapLocalState,
  initial.currentContractState,
  initial.currentPrivateState
);
```

### 37. `sampleContractAddress` is a function

It must be called with `()`. Passing it as a value gives a function object, not an address.

```typescript
// BAD — passes a function object
createConstructorContext({}, sampleContractAddress);

// GOOD — calls the function
createConstructorContext({}, sampleContractAddress());
```

### 38. Circuit results use context continuation, not state destructuring

After executing a circuit, `result.context` is the full continuation to pass to the
next call. Do NOT try to destructure and rebuild — pass it directly.

```typescript
// BAD — contractState from result.context.currentQueryContext is QueryContext, not ContractState
const ctx2 = createCircuitContext(addr, result.context.currentZswapLocalState,
  result.context.currentQueryContext, result.context.currentPrivateState);

// GOOD — pass result.context directly as the next circuit's context
const r2 = contract.impureCircuits.read(result.context);
```

### 39. `ledger()` helper expects ContractState, not QueryContext

The generated `ledger()` function needs the original `ContractState` (from `initialState()`),
not the `QueryContext` (from `result.context.currentQueryContext`). Use `read` circuits
for checking ledger values in simulator tests.

### 40. BLS parameter download may fail behind corporate proxies

The Compact compiler downloads ZK parameters from AWS S3 on first compile. Corporate
proxies or firewalls may block these downloads. If `compact compile` fails with
"Failed to fetch data from ...s3.eu-west-1.amazonaws.com... after 3 attempts":

- Ensure the proxy allows `*.amazonaws.com` on port 443
- Or bypass the proxy for the compile step: `unset http_proxy https_proxy && compact compile ...`
- Or use the [Brick Towers pre-baked proof server](https://github.com/bricktowers/midnight-proof-server) which includes parameters

---

## Version Compatibility

> **WARNING:** Midnight is pre-mainnet software. APIs, syntax, and tooling
> change between versions. The gotchas above were confirmed as of early 2025
> (Compact toolchain 0.25.x-0.28.x range). Always check the latest release
> notes, as some of these issues may be fixed in newer versions.

**The golden rule:** When something isn't working, check this list first,
then check the version compatibility matrix, then ask in Discord.
