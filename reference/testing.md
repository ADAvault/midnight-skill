# Testing Guide for Midnight Compact Contracts

## 1. Testing Levels

Midnight contract testing follows a progressive approach: start fast and cheap, then
move toward real network conditions.

### Level 1: Simulator (Phase 1)

- **Speed:** Milliseconds per test
- **Requirements:** Node.js, Vitest, compiled contract artifacts
- **Proof generation:** None (circuits execute directly, no ZK proofs)
- **Network:** None (pure in-process simulation)
- **When to use:** Always. This is the primary development workflow. "Everything works
  as expected in the 'phase 1' tests" (Discord). Write simulator tests first for every
  circuit, and run them continuously during development.

### Level 2: Standalone Network

- **Speed:** Seconds to minutes (proof generation dominates)
- **Requirements:** Docker (node + indexer + proof server)
- **Proof generation:** Real ZK proofs via the proof server
- **Network:** Local Docker containers, no external dependencies
- **When to use:** After simulator tests pass. Validates proof generation,
  transaction submission, indexer integration, and wallet flows.

### Level 3: Testnet (Preview / Preprod)

- **Speed:** Minutes (block times + proof generation + network latency)
- **Requirements:** Testnet tDUST, wallet, running proof server
- **Proof generation:** Real ZK proofs
- **Network:** Public Midnight testnet
- **When to use:** Final validation before mainnet. Tests real network conditions,
  consensus, public indexer, and cross-user interaction.

---

## 2. Simulator Testing

The simulator executes circuits directly in-process without generating ZK proofs.
This is fast and deterministic, making it ideal for TDD.

### Project Setup

Install dependencies:

```bash
npm install --save-dev vitest @midnight-ntwrk/compact-runtime
```

Compile your contract:

```bash
compact compile src/contract.compact src/managed/contract
```

This generates `src/managed/contract/contract/index.js` containing the `Contract`
class with typed circuit methods.

### Basic Test Structure

```typescript
import { describe, it, expect } from "vitest";
import { Contract } from "../managed/counter/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

// Required: set network ID before any contract operations.
// "undeployed" for simulator, "testnet" or "mainnet" for real networks.
setNetworkId("undeployed");

// Define the private state shape (matches your witness expectations)
type PrivateState = {
  secretKey: Uint8Array;
  amount: bigint;
};

// Implement witnesses (must match Compact witness declarations)
const witnesses = {
  localSecretKey: ({
    privateState,
  }: {
    privateState: PrivateState;
  }): [PrivateState, Uint8Array] => [privateState, privateState.secretKey],

  getAmount: (
    { privateState }: { privateState: PrivateState },
    max: bigint,
  ): [PrivateState, bigint] => [privateState, privateState.amount],
};

describe("Counter Contract", () => {
  it("should initialize with constructor", () => {
    const contract = new Contract<PrivateState>(witnesses);

    const initialPrivateState: PrivateState = {
      secretKey: new Uint8Array(32),
      amount: 0n,
    };

    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      contract.initialState(
        createConstructorContext(initialPrivateState, "0".repeat(64)),
      );

    // Constructor has executed; check the resulting state
    expect(currentContractState).toBeDefined();
    expect(currentPrivateState).toBeDefined();
  });
});
```

### Creating Constructor Context

The constructor context requires two arguments:

1. **Initial private state** -- the off-chain state for the deploying user
2. **Contract address** -- a 64-character hex string (use `"0".repeat(64)` for tests,
   or `sampleContractAddress()` if available)

```typescript
const initialPrivateState = { secretKey: new Uint8Array(32) };

const { currentPrivateState, currentContractState, currentZswapLocalState } =
  contract.initialState(
    createConstructorContext(initialPrivateState, "0".repeat(64)),
  );
```

The returned object gives you the full state after constructor execution:

- `currentPrivateState` -- updated private state (witnesses may have modified it)
- `currentContractState` -- ledger state (public on-chain data)
- `currentZswapLocalState` -- local Zswap coin state (relevant for token operations)

### Executing Circuits

IMPORTANT: `createCircuitContext` requires **4 parameters**:
`(contractAddress, zswapLocalState, contractState, privateState)`.

`sampleContractAddress` is a **function** — call it with `()`.

```typescript
import { sampleContractAddress } from "@midnight-ntwrk/compact-runtime";

it("should increment the counter", () => {
  const contract = new Contract(witnesses);

  // 1. Initialize
  const addr = sampleContractAddress();  // NOTE: function call!
  const init = contract.initialState(
    createConstructorContext(initialPrivateState, addr),
  );

  // 2. Create circuit context — requires all 4 params
  const ctx = createCircuitContext(
    addr,
    init.currentZswapLocalState,
    init.currentContractState,
    init.currentPrivateState,
  );

  // 3. Execute the circuit
  const result = contract.impureCircuits.increment(ctx);

  // 4. Result contains: result, context, proofData, gasCost
  expect(result.context).toBeDefined();
});
```

### Chaining Multiple Circuit Calls

CRITICAL PATTERN: Each circuit execution returns a `result.context` that passes
directly to the next call. Do NOT rebuild the context — pass it as-is:

```typescript
it("should increment three times", () => {
  const contract = new Contract(witnesses);
  const addr = sampleContractAddress();
  const init = contract.initialState(createConstructorContext({}, addr));

  let ctx = createCircuitContext(
    addr, init.currentZswapLocalState,
    init.currentContractState, init.currentPrivateState,
  );

  // Chain calls: pass result.context directly as the continuation
  const r1 = contract.impureCircuits.increment(ctx);
  const r2 = contract.impureCircuits.increment(r1.context);
  const r3 = contract.impureCircuits.increment(r2.context);

  // Read the result
  const r4 = contract.impureCircuits.read(r3.context);
  expect(r4.result).toBe(3n);
});
```

### Checking Ledger State

Use the generated `ledger()` helper function or a `read` circuit to inspect
ledger values after circuit execution:

```typescript
import { Contract, ledger } from "../src/managed/counter/contract/index.js";

it("should reflect counter value in ledger", () => {
  const contract = new Contract(witnesses);
  const addr = sampleContractAddress();
  const init = contract.initialState(createConstructorContext({}, addr));
  const ctx = createCircuitContext(
    addr, init.currentZswapLocalState,
    init.currentContractState, init.currentPrivateState,
  );

  const r1 = contract.impureCircuits.increment(ctx);

  // Option 1: Use a read circuit (recommended for simulator)
  const r2 = contract.impureCircuits.read(r1.context);
  expect(r2.result).toBe(1n);

  // Option 2: Use the ledger() helper (needs ContractState, not QueryContext)
  // NOTE: ledger() expects the original ContractState type, not the
  // QueryContext from result.context — use read circuits in simulator tests
});
```

### Testing Assertions (Expecting Circuit Failure)

Compact `assert()` statements throw when the condition is false. Test this
with Vitest's `expect().toThrow()`:

```typescript
it("should reject unauthorized caller", () => {
  const contract = new Contract(witnesses);
  const addr = sampleContractAddress();

  // Initialize as owner
  const init = contract.initialState(
    createConstructorContext(ownerPrivateState, addr),
  );

  const ctx = createCircuitContext(
    addr, init.currentZswapLocalState,
    init.currentContractState, init.currentPrivateState,
  );

  // Post as owner (succeeds)
  const r1 = contract.impureCircuits.post(ctx, "hello");

  // Now try restricted action with different private state (attacker)
  const attackerInit = contract.initialState(
    createConstructorContext({ secretKey: new Uint8Array(32).fill(0xff) }, addr),
  );
  const attackerCtx = createCircuitContext(
    addr, attackerInit.currentZswapLocalState,
    // Use the contract state from r1 (has owner set) but attacker's private state
    r1.context.currentQueryContext,
    attackerInit.currentPrivateState,
  );

  // The circuit should throw because the assert fails
  expect(() => {
    contract.impureCircuits.restrictedAction(attackerCtx);
  }).toThrow();
});
```

### Testing Pure Circuits

Pure circuits have no state and are simpler to test:

```typescript
it("should hash correctly", () => {
  const contract = new Contract<PrivateState>(witnesses);
  const data = new Uint8Array(32).fill(0x42);

  const result = contract.pureCircuits.hash(data);

  expect(result).toBeInstanceOf(Uint8Array);
  expect(result.length).toBe(32);
});
```

### Property-Based Testing

For circuits with numeric constraints, combine Vitest with a property-based
testing library like `fast-check`:

```typescript
import fc from "fast-check";

it("counter should never go negative", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
      (operations) => {
        const contract = new Contract<PrivateState>(witnesses);
        let { currentContractState, currentPrivateState } = contract.initialState(
          createConstructorContext(initialPrivateState, "0".repeat(64)),
        );

        let expectedCount = 0;

        for (const shouldIncrement of operations) {
          const ctx = createCircuitContext(
            currentContractState,
            currentPrivateState,
          );

          if (shouldIncrement) {
            const result = contract.impureCircuits.increment(ctx);
            currentContractState = result.currentContractState;
            currentPrivateState = result.currentPrivateState;
            expectedCount++;
          } else {
            // Decrement should throw if counter is at 0
            if (expectedCount === 0) {
              expect(() => contract.impureCircuits.decrement(ctx)).toThrow();
            } else {
              const result = contract.impureCircuits.decrement(ctx);
              currentContractState = result.currentContractState;
              currentPrivateState = result.currentPrivateState;
              expectedCount--;
            }
          }
        }
      },
    ),
  );
});
```

---

## 3. Multi-User Simulation

Many contracts involve multiple users (e.g., a bulletin board where user A posts
and user B reads, or an escrow between buyer and seller). The simulator supports
this by maintaining separate private states per user.

### The Key Rule

Each user has their own private state. The contract (ledger) state is shared.
After one user executes a circuit, the updated contract state is visible to
the next user, but each user keeps their own private state.

### Two-User Interaction Pattern

```typescript
describe("Bulletin Board - Multi-User", () => {
  it("user A posts, user B cannot take it down", () => {
    const contract = new Contract<PrivateState>(witnesses);

    // -- User A: the poster --
    const userAKey = new Uint8Array(32).fill(0x01);
    const userAState: PrivateState = { secretKey: userAKey };

    // User A deploys the contract (runs constructor)
    let { currentContractState, currentPrivateState: userAPrivate } =
      contract.initialState(
        createConstructorContext(userAState, "0".repeat(64)),
      );

    // User A posts a message
    const ctxA = createCircuitContext(currentContractState, userAPrivate);
    const postResult = contract.impureCircuits.post(ctxA);
    currentContractState = postResult.currentContractState;
    userAPrivate = postResult.currentPrivateState;

    // -- User B: a different user --
    const userBKey = new Uint8Array(32).fill(0x02);
    const userBState: PrivateState = { secretKey: userBKey };

    // User B sees the same contract state but has different private state
    const ctxB = createCircuitContext(currentContractState, userBState);

    // User B tries to take down User A's post -- should fail
    expect(() => {
      contract.impureCircuits.takeDown(ctxB);
    }).toThrow(); // assert fails: B is not the poster

    // -- User A can take down their own post --
    const ctxA2 = createCircuitContext(currentContractState, userAPrivate);
    const takeDownResult = contract.impureCircuits.takeDown(ctxA2);
    currentContractState = takeDownResult.currentContractState;
    // Success: A is the owner
  });
});
```

### Switch-User Pattern (from bboard example)

For tests with many user switches, extract a helper:

```typescript
function switchUser(
  contract: Contract<PrivateState>,
  contractState: any,
  userPrivateState: PrivateState,
) {
  return {
    execute(circuitName: string, ...args: any[]) {
      const ctx = createCircuitContext(contractState, userPrivateState);
      const result = (contract.impureCircuits as any)[circuitName](ctx, ...args);
      return {
        contractState: result.currentContractState,
        privateState: result.currentPrivateState,
      };
    },
  };
}
```

### Separate Private State Providers

When testing with the full DApp provider stack (Level 2), each user needs a
separate private state provider. Two critical rules:

1. **Use separate `inMemoryPrivateStateProvider()` instances** per user
2. **If using LevelDB, use separate folders** -- two users pointing to the same
   LevelDB directory causes a `LEVEL_LOCKED` error because LevelDB acquires
   exclusive file locks

```typescript
// WRONG: shared LevelDB folder
const providerA = levelPrivateStateProvider("./db");
const providerB = levelPrivateStateProvider("./db"); // LEVEL_LOCKED error!

// RIGHT: separate folders
const providerA = levelPrivateStateProvider("./db-user-a");
const providerB = levelPrivateStateProvider("./db-user-b");

// BEST for tests: in-memory (no filesystem at all)
const providerA = inMemoryPrivateStateProvider();
const providerB = inMemoryPrivateStateProvider();
```

---

## 4. In-Memory Private State Provider

The default private state provider uses LevelDB, which requires filesystem access,
acquires locks, and is slow for tests. Replace it with an in-memory implementation.

### Reference Implementations

Two proven implementations exist in the ecosystem:

- `midnight-examples/welcome/midnight-js/src/test/in-memory-private-state-provider.ts`
- `bricktowers/midnight-seabattle/battleship-api/src/test/in-memory-private-state-provider.ts`

### Implementation

```typescript
// in-memory-private-state-provider.ts
import type {
  PrivateStateProvider,
  ContractAddress,
} from "@midnight-ntwrk/midnight-js-types";

export function inMemoryPrivateStateProvider<PS>(): PrivateStateProvider<PS> {
  const states = new Map<ContractAddress, PS>();

  return {
    get: async (contractAddress: ContractAddress): Promise<PS | null> => {
      return states.get(contractAddress) ?? null;
    },
    set: async (
      contractAddress: ContractAddress,
      state: PS,
    ): Promise<void> => {
      states.set(contractAddress, state);
    },
    remove: async (contractAddress: ContractAddress): Promise<void> => {
      states.delete(contractAddress);
    },
    clear: async (): Promise<void> => {
      states.clear();
    },
  };
}
```

### Usage in Tests

```typescript
import { inMemoryPrivateStateProvider } from "./in-memory-private-state-provider";

// Each user gets their own provider
const alicePrivateState = inMemoryPrivateStateProvider<PrivateState>();
const bobPrivateState = inMemoryPrivateStateProvider<PrivateState>();

// Use when constructing the DApp provider
const aliceProvider = {
  privateStateProvider: alicePrivateState,
  // ... other providers
};
```

---

## 5. Standalone Network Testing

Standalone network testing uses Docker to run a local Midnight node, indexer, and
proof server. This is the closest you can get to real network conditions without
using a public testnet.

### Docker Compose Setup

Reference: [bricktowers/midnight-local-network](https://github.com/bricktowers/midnight-local-network)

The local network exposes these services:

| Service | Endpoint | Purpose |
|---------|----------|---------|
| midnight-node | `ws://127.0.0.1:9944` | Blockchain node (WebSocket RPC) |
| indexer | `http://127.0.0.1:8088` | Block indexer (REST API) |
| indexer GraphQL | `http://127.0.0.1:8088/api/v3/graphql` | GraphQL query endpoint |
| proof-server | `http://127.0.0.1:6300` | ZK proof generation |

### Starting the Local Network

```bash
git clone https://github.com/bricktowers/midnight-local-network.git
cd midnight-local-network
docker compose up -d
```

Wait for services to be healthy before running tests. The proof server may take
a minute to download circuit parameters on first run. Consider using the
[bricktowers/midnight-proof-server](https://github.com/bricktowers/midnight-proof-server)
image which has parameters pre-baked.

### Genesis Wallet

The standalone network includes a pre-funded genesis wallet for testing:

```typescript
// Genesis wallet seed for the undeployed / standalone network
const GENESIS_WALLET_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";
```

Use this seed to create a wallet with tDUST for deploying contracts and
submitting transactions on the local network.

### Standalone Network Test Example

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { Wallet } from "@midnight-ntwrk/wallet-api";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

// Configuration for local standalone network
const config = {
  node: "ws://127.0.0.1:9944",
  indexer: "http://127.0.0.1:8088/api/v3/graphql",
  proofServer: "http://127.0.0.1:6300",
};

describe("Standalone Network Tests", () => {
  beforeAll(async () => {
    setNetworkId("undeployed");
    // Wait for node to be ready, wallet to sync, etc.
  }, 60_000); // generous timeout for startup

  it("should deploy contract and call circuit", async () => {
    // 1. Create providers pointing to local network
    const proofProvider = httpClientProofProvider(config.proofServer);
    const publicDataProvider = indexerPublicDataProvider(config.indexer);

    // 2. Deploy contract (generates real proof -- this is slow)
    // ... deployment code using midnight-js providers

    // 3. Call circuit (generates real proof)
    // ... circuit call code

    // 4. Verify on-chain state via indexer
    // ... query indexer GraphQL
  }, 120_000); // proof generation timeout
});
```

---

## 6. Required Polyfills

Midnight SDK packages rely on browser APIs that are not available in Node.js.
You must polyfill them before any Midnight imports.

### Setup File

Create a setup file and reference it in your Vitest config:

```typescript
// test/setup.ts
import { Buffer } from "buffer";
import { WebSocket } from "ws";

// Midnight SDK expects these globals
globalThis.Buffer = Buffer;
globalThis.WebSocket = WebSocket as any;
```

Install the `ws` package:

```bash
npm install --save-dev ws @types/ws
```

### Apply in Vitest Config

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 120_000, // proof generation is slow
  },
});
```

### Alternative: Inline Polyfills

If you prefer not to use a setup file, add polyfills at the top of each test
file (before any Midnight imports):

```typescript
import { Buffer } from "buffer";
import { WebSocket } from "ws";
globalThis.Buffer = Buffer;
globalThis.WebSocket = WebSocket as any;

// Now safe to import Midnight packages
import { Contract } from "../managed/counter/contract/index.js";
// ...
```

---

## 7. Common Test Patterns

### Waiting for Wallet Sync

When testing against a real network (Level 2 or 3), the wallet must sync with
the indexer before it can submit transactions:

```typescript
import { firstValueFrom, filter } from "rxjs";

// Wait for wallet to be fully synced
async function waitForSync(wallet: WalletApi): Promise<void> {
  await firstValueFrom(
    wallet.state().pipe(filter((state) => state.syncProgress.synced === true)),
  );
}

// Usage in test
beforeAll(async () => {
  const wallet = await createWallet(config);
  await waitForSync(wallet);
}, 60_000);
```

### Checking Ledger State After Circuit Execution

For simulator tests (Level 1):

```typescript
const ctx = createCircuitContext(contractState, privateState);
const result = contract.impureCircuits.increment(ctx);

// Access ledger values from the updated contract state
const updatedLedger = result.currentContractState;
// The shape depends on your compiled contract's type exports
```

For network tests (Level 2/3), query the indexer:

```typescript
// After submitting a transaction and waiting for confirmation
const contractState = await publicDataProvider.queryContractState(
  contractAddress,
);
// Parse ledger state from the on-chain data
```

### Testing Error Conditions

Test that circuits reject invalid inputs:

```typescript
it("should reject amount exceeding balance", () => {
  const ctx = createCircuitContext(contractState, {
    ...privateState,
    amount: 999_999n, // way more than the balance
  });

  expect(() => {
    contract.impureCircuits.withdraw(ctx);
  }).toThrow();
});

it("should reject non-owner", () => {
  const ctx = createCircuitContext(contractState, nonOwnerPrivateState);

  expect(() => {
    contract.impureCircuits.adminAction(ctx);
  }).toThrow();
});

it("should reject after deadline", () => {
  // If your contract uses block height or timestamps,
  // manipulate the context accordingly
  const ctx = createCircuitContext(expiredContractState, privateState);

  expect(() => {
    contract.impureCircuits.claim(ctx);
  }).toThrow();
});
```

### Testing Privacy (Verifying Values Are NOT Leaked)

A critical test pattern for Midnight: verify that private values do not
appear in the public ledger state.

```typescript
it("should not leak the secret in ledger state", () => {
  const secret = new Uint8Array(32).fill(0xab);
  const privateState = { secret };

  const contract = new Contract<PrivateState>(witnesses);
  const { currentContractState } = contract.initialState(
    createConstructorContext(privateState, "0".repeat(64)),
  );

  // Serialize the entire contract state and search for the secret
  const serialized = JSON.stringify(currentContractState);
  const secretHex = Buffer.from(secret).toString("hex");

  // The raw secret should NOT appear in the public ledger
  expect(serialized).not.toContain(secretHex);
});

it("should store only the hash, not the preimage", () => {
  // After a commit, verify the ledger contains a hash
  // but not the original value
  const ctx = createCircuitContext(contractState, privateState);
  const result = contract.impureCircuits.commit(ctx);

  const ledger = result.currentContractState;
  // The commitment hash should be present
  expect(ledger).toBeDefined();
  // But the original plaintext should not be
});
```

### Testing Return Values from Circuits

Circuits that return values provide them in the result:

```typescript
it("should return the current balance", () => {
  const ctx = createCircuitContext(contractState, privateState);
  const result = contract.impureCircuits.getBalance(ctx);

  // The return value is available on the result
  // Exact access pattern depends on compiled contract output
  expect(result).toBeDefined();
});
```

---

## 8. Test Configuration

### Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 120_000, // 2 minutes -- proof generation is slow
    hookTimeout: 120_000, // beforeAll/afterAll also need generous timeouts

    // Optional: separate test suites by level
    // Run simulator tests by default, network tests on demand
    include: ["src/**/*.test.ts"],
  },
});
```

### Separating Test Levels

Use file naming or directories to separate test levels:

```
src/
  test/
    setup.ts                          # polyfills
    in-memory-private-state-provider.ts
    simulator/
      counter.test.ts                 # Level 1: fast, no network
      bboard.test.ts
    network/
      counter.network.test.ts         # Level 2: requires Docker
      bboard.network.test.ts
```

Configure Vitest to run only simulator tests by default:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    include: ["src/test/simulator/**/*.test.ts"],
  },
});
```

Run network tests explicitly:

```bash
npx vitest run src/test/network/
```

### Package.json Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:simulator": "vitest run src/test/simulator/",
    "test:network": "vitest run src/test/network/",
    "compile": "compact compile src/contract.compact src/managed/contract"
  }
}
```

### Timeout Guidance

| Test Level | Recommended Timeout | Reason |
|-----------|-------------------|--------|
| Simulator | 10,000 ms | No proofs, pure computation |
| Standalone (deploy) | 120,000 ms | Proof generation + block confirmation |
| Standalone (circuit call) | 60,000 ms | Proof generation |
| Testnet | 300,000 ms | Network latency + block times |

Adjust timeouts per-test when needed:

```typescript
it("should deploy contract", async () => {
  // ... deployment code
}, 180_000); // override default timeout for this slow test
```

---

## Quick Reference: Minimal Working Test

For a counter contract, here is the shortest path to a passing test:

```typescript
// counter.test.ts
import { describe, it, expect } from "vitest";
import { Contract } from "../managed/counter/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

type PrivateState = Record<string, never>; // empty for a simple counter

const witnesses = {};

describe("Counter", () => {
  const contract = new Contract<PrivateState>(witnesses);

  it("initializes and increments", () => {
    const { currentContractState, currentPrivateState } =
      contract.initialState(
        createConstructorContext({} as PrivateState, "0".repeat(64)),
      );

    const ctx = createCircuitContext(currentContractState, currentPrivateState);
    const result = contract.impureCircuits.increment(ctx);

    expect(result.currentContractState).toBeDefined();
  });
});
```
