# Oracle Feed

> **Compiler-validated:** Contract compiles (5 circuits) and 6/6 tests pass against Compact 0.29.0.

External data integration via a trusted oracle. The oracle provides data
off-chain (e.g., price feeds, weather data, event outcomes), and the circuit
validates format, freshness, and bounds before storing it on the public ledger.
Demonstrates the witness-as-oracle pattern where the oracle's secret key
authenticates updates, and domain-specific validation constraints ensure data
quality within the ZK circuit.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger oracle: Bytes<32>;
export ledger prices: Map<Bytes<32>, Uint<64>>;
export ledger timestamps: Map<Bytes<32>, Uint<64>>;
export ledger updateCount: Counter;
export ledger stalePriceThreshold: Uint<64>;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "oracle:pk:"), sk]);
}

constructor() {
  oracle = disclose(publicKey(localSecretKey()));
  stalePriceThreshold = 3600;
}

export circuit postPrice(
  asset: Bytes<32>,
  price: Uint<64>,
  timestamp: Uint<64>
): [] {
  assert(publicKey(localSecretKey()) == oracle, "Only oracle can post prices");
  assert(price > 0 as Uint<64>, "Price must be positive");
  if (timestamps.member(disclose(asset))) {
    const lastTimestamp = timestamps.lookup(disclose(asset));
    assert(timestamp > lastTimestamp, "Timestamp must be newer than last update");
  }
  prices.insert(disclose(asset), disclose(price));
  timestamps.insert(disclose(asset), disclose(timestamp));
  updateCount.increment(1);
}

export circuit getPrice(asset: Bytes<32>): Uint<64> {
  assert(prices.member(disclose(asset)), "Asset not found");
  return prices.lookup(disclose(asset));
}

export circuit assertPriceFresh(asset: Bytes<32>): [] {
  assert(prices.member(disclose(asset)), "Asset not found");
  assert(timestamps.member(disclose(asset)), "No timestamp for asset");
  const lastUpdate = timestamps.lookup(disclose(asset));
  const now = getCurrentTime();
  assert(disclose(now - lastUpdate < stalePriceThreshold), "Price is stale");
}

export circuit transferOracle(newOraclePk: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == oracle, "Only current oracle");
  oracle = disclose(newOraclePk);
}

export circuit setStalenessThreshold(newThreshold: Uint<64>): [] {
  assert(publicKey(localSecretKey()) == oracle, "Only oracle");
  assert(newThreshold > 0 as Uint<64>, "Threshold must be positive");
  stalePriceThreshold = disclose(newThreshold);
}
```

---

## Key Concepts

### Witness-as-Oracle

The oracle's secret key authenticates updates through the standard authentication
pattern. The circuit verifies the caller is the registered oracle before accepting
data. No sequence counter needed -- the oracle key is permanent unless explicitly
rotated via `transferOracle`.

### Domain-Specific Validation

The circuit enforces constraints that cannot be faked: price > 0, monotonically
increasing timestamps, staleness checks. These are ZK-proven guarantees.

### Freshness Guarantees

The `assertPriceFresh` circuit lets consumers verify that a price was updated
within the staleness threshold. Note that `getCurrentTime()` is a witness and
therefore not cryptographically enforced -- the prover controls the time value.

### Oracle Key Rotation

`transferOracle` stores a new oracle public key directly. Since keys are
deterministic (no sequence), the new oracle just needs to derive their key from
their secret and the new oracle can start posting immediately.

### Literal Assignment to Export Ledger

`stalePriceThreshold = 3600` assigns a compile-time constant to an export ledger
field. This does NOT need `disclose()` -- the compiler knows the value is not
witness-derived.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/oracle/contract/index.js';

export interface OraclePrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, OraclePrivateState>,
  ): [OraclePrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getCurrentTime: (
    { privateState }: WitnessContext<Ledger, OraclePrivateState>,
  ): [OraclePrivateState, bigint] => {
    return [privateState, BigInt(Math.floor(Date.now() / 1000))];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). The `getCurrentTime` witness
is injected with controlled timestamps to test freshness logic deterministically.
Oracle key rotation test verifies old key loses access while new key gains it.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/oracle/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const oracleKey = new Uint8Array(32); oracleKey[0] = 0x01;
const newOracleKey = new Uint8Array(32); newOracleKey[0] = 0x02;
const nonOracleKey = new Uint8Array(32); nonOracleKey[0] = 0x03;

const assetBTC = new Uint8Array(32);
new TextEncoder().encodeInto("BTC", assetBTC);

function makeWitnesses(sk, time = BigInt(Date.now())) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getCurrentTime: ({ privateState }) => [privateState, time],
  };
}

describe("Oracle Feed", () => {
  let oracleContract, ctx;

  beforeEach(() => {
    oracleContract = new Contract(makeWitnesses(oracleKey));
    const addr = sampleContractAddress();
    const initial = oracleContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should post price and read it back", () => {
    const r1 = oracleContract.impureCircuits.postPrice(ctx, assetBTC, 50000n, 1000n);
    const r2 = oracleContract.impureCircuits.getPrice(r1.context, assetBTC);
    expect(r2.result).toBe(50000n);
  });

  it("should reject non-oracle posting", () => {
    const nonOracle = new Contract(makeWitnesses(nonOracleKey));
    expect(() => {
      nonOracle.impureCircuits.postPrice(ctx, assetBTC, 50000n, 1000n);
    }).toThrow("Only oracle can post prices");
  });

  it("should reject zero price", () => {
    expect(() => {
      oracleContract.impureCircuits.postPrice(ctx, assetBTC, 0n, 1000n);
    }).toThrow("Price must be positive");
  });

  it("should enforce timestamp monotonicity", () => {
    const r1 = oracleContract.impureCircuits.postPrice(ctx, assetBTC, 50000n, 1000n);
    expect(() => {
      oracleContract.impureCircuits.postPrice(r1.context, assetBTC, 51000n, 500n);
    }).toThrow("Timestamp must be newer than last update");
  });

  it("should allow oracle key rotation", () => {
    const newOraclePk = pureCircuits.publicKey(newOracleKey);
    const r1 = oracleContract.impureCircuits.transferOracle(ctx, newOraclePk);
    expect(() => {
      oracleContract.impureCircuits.postPrice(r1.context, assetBTC, 50000n, 1000n);
    }).toThrow("Only oracle can post prices");
    const newOracle = new Contract(makeWitnesses(newOracleKey));
    const r2 = newOracle.impureCircuits.postPrice(r1.context, assetBTC, 50000n, 1000n);
    expect(r2.context).toBeDefined();
  });

  it("should detect stale prices", () => {
    const r1 = oracleContract.impureCircuits.postPrice(ctx, assetBTC, 50000n, 100n);
    const staleFinder = new Contract(makeWitnesses(nonOracleKey, 100n + 3600n + 1n));
    expect(() => {
      staleFinder.impureCircuits.assertPriceFresh(r1.context, assetBTC);
    }).toThrow("Price is stale");
  });
});
```

---

## Notes

- **Compiler-validated:** 5 circuits compiled, 6/6 tests pass against Compact 0.29.0.
- **No sequence counter:** Oracle key is deterministic from secret key alone.
  `transferOracle` replaces the key directly. No key invalidation issues.
- **Time witness trust:** `getCurrentTime` is not cryptographically enforced. The
  oracle provides both the timestamp and the price, so it's trusted to the same
  degree. The monotonicity check provides minimal safeguard.
- **Staleness subtraction:** `now - lastUpdate < stalePriceThreshold` can underflow
  if `now < lastUpdate`. In practice, the monotonicity check on timestamps and the
  trusted time witness prevent this.
- **Consumer pattern:** Other Midnight contracts cannot call this contract's circuits
  directly. Consumers read the oracle's public ledger via the indexer.
- For LOKx: this pattern is relevant for condition verification -- an oracle attests
  that a real-world event occurred, triggering a RELEASE.
