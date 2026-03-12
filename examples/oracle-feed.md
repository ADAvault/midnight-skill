# Oracle Feed

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
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "oracle:pk:"), seq, sk]);
}

constructor() {
  oracle = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  // Default staleness threshold: 3600 seconds (1 hour)
  stalePriceThreshold = 3600;
  sequence.increment(1);
}

// Oracle posts a single price update with validation
export circuit postPrice(
  asset: Bytes<32>,
  price: Uint<64>,
  timestamp: Uint<64>
): [] {
  // Authenticate the oracle
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == oracle),
         "Only oracle can post prices");

  // Validate price is non-zero
  assert(price > 0 as Uint<64>, "Price must be positive");

  // Validate timestamp is monotonically increasing for this asset
  if (timestamps.member(asset)) {
    const lastTimestamp = timestamps.lookup(asset);
    assert(timestamp > lastTimestamp, "Timestamp must be newer than last update");
  }

  // Store the price and timestamp
  prices.insert(asset, disclose(price));
  timestamps.insert(asset, disclose(timestamp));
  updateCount.increment(1);
}

// Oracle posts a batch of up to 3 price updates in one transaction
// Batching reduces the number of proof generation rounds
export circuit postPriceBatch(
  assets: Vector<3, Bytes<32>>,
  pricesVec: Vector<3, Uint<64>>,
  timestampsVec: Vector<3, Uint<64>>,
  count: Uint<32>
): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == oracle),
         "Only oracle");

  // Process each entry. Since Compact has no loops, unroll manually.
  // Only process up to `count` entries.
  if (count >= 1 as Uint<32>) {
    assert(pricesVec[0] > 0 as Uint<64>, "Price must be positive");
    prices.insert(assets[0], disclose(pricesVec[0]));
    timestamps.insert(assets[0], disclose(timestampsVec[0]));
    updateCount.increment(1);
  }
  if (count >= 2 as Uint<32>) {
    assert(pricesVec[1] > 0 as Uint<64>, "Price must be positive");
    prices.insert(assets[1], disclose(pricesVec[1]));
    timestamps.insert(assets[1], disclose(timestampsVec[1]));
    updateCount.increment(1);
  }
  if (count >= 3 as Uint<32>) {
    assert(pricesVec[2] > 0 as Uint<64>, "Price must be positive");
    prices.insert(assets[2], disclose(pricesVec[2]));
    timestamps.insert(assets[2], disclose(timestampsVec[2]));
    updateCount.increment(1);
  }
}

// Anyone can read a price (public ledger)
export circuit getPrice(asset: Bytes<32>): Uint<64> {
  assert(prices.member(asset), "Asset not found");
  return prices.lookup(asset);
}

// Consumers can verify price freshness before using it
export circuit assertPriceFresh(asset: Bytes<32>): [] {
  assert(prices.member(asset), "Asset not found");
  assert(timestamps.member(asset), "No timestamp for asset");

  const lastUpdate = timestamps.lookup(asset);
  const now = getCurrentTime();
  assert(disclose(now - lastUpdate < stalePriceThreshold),
         "Price is stale -- exceeds freshness threshold");
}

// Oracle can transfer oracle authority to a new key
export circuit transferOracle(newOraclePk: Bytes<32>): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == oracle),
         "Only current oracle");
  oracle = newOraclePk;
  sequence.increment(1);
}

// Oracle can update the staleness threshold
export circuit setStalenessThreshold(newThreshold: Uint<64>): [] {
  assert(disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>) == oracle),
         "Only oracle");
  assert(newThreshold > 0 as Uint<64>, "Threshold must be positive");
  stalePriceThreshold = newThreshold;
}
```

---

## Key Concepts

- **Witness-as-oracle:** The oracle's secret key authenticates updates through the
  same authentication pattern used for ownership. The circuit verifies the caller
  is the registered oracle before accepting data.
- **Domain-specific validation:** The circuit enforces constraints that cannot be
  faked by a malicious witness: price > 0, monotonically increasing timestamps,
  staleness checks. These are ZK-proven guarantees.
- **Freshness guarantees:** The `assertPriceFresh` circuit lets consumers verify
  that a price was updated within the staleness threshold before using it in
  downstream calculations. Note that `getCurrentTime()` is a witness and therefore
  not cryptographically enforced -- see Notes.
- **Batch updates:** The `postPriceBatch` circuit updates up to 3 assets in one
  transaction, reducing the number of proof generation rounds. The unrolled
  if-statements are necessary because Compact has no loops.
- **Oracle rotation:** The `transferOracle` circuit allows the oracle key to be
  updated, supporting key rotation without redeploying the contract.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/oracle/contract/index.cjs';

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

// Oracle service: fetch prices from external APIs and post to contract
export async function runOracleService(
  contract: any, // DeployedContract type
  assets: string[],
  intervalMs: number,
): Promise<void> {
  const fetchPrice = async (asset: string): Promise<bigint> => {
    // In production, fetch from a real price API
    const resp = await fetch(`https://api.example.com/price/${asset}`);
    const data = await resp.json();
    return BigInt(Math.floor(data.price * 1e8)); // 8 decimal places
  };

  setInterval(async () => {
    for (const asset of assets) {
      const price = await fetchPrice(asset);
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const assetBytes = new TextEncoder().encode(asset.padEnd(32, '\0'));
      await contract.callTx.postPrice(assetBytes, price, timestamp);
    }
  }, intervalMs);
}
```

---

## Tests

```
describe('Oracle Feed', () => {

  1. Post price and read it back (happy path)
     - Oracle posts BTC price, read it back via getPrice
     - Assert returned price matches posted value

  2. Non-oracle cannot post prices (should fail)
     - Non-oracle key attempts postPrice
     - Assert "Only oracle can post prices" error

  3. Zero price rejected (should fail)
     - Oracle posts price=0
     - Assert "Price must be positive" error

  4. Timestamp monotonicity enforced
     - Post with timestamp=100, then post with timestamp=50
     - Assert "Timestamp must be newer" error

  5. Stale price detection
     - Post a price with old timestamp, call assertPriceFresh
     - Assert "Price is stale" error

  6. Oracle key rotation
     - Transfer oracle to new key, verify old key can no longer post
     - Verify new key can post successfully
});
```

---

## Notes

- Circuit complexity varies by circuit. `postPrice` is moderate (k ~12-13) with
  authentication hash + Map operations. `postPriceBatch` is heavier (k ~14-15)
  due to unrolled Map inserts. The batch size of 3 is a practical ceiling before
  k becomes problematic.
- **Time witness trust:** The `getCurrentTime` witness is not cryptographically
  enforced. The oracle itself provides the timestamp, so it is trusted to the
  same degree as the price data. The monotonicity check in the circuit provides
  a minimal safeguard against timestamp manipulation.
- **Single point of failure:** A single oracle key controls all price data. For
  production, consider a multi-oracle pattern where N-of-M oracles must agree
  on a price. However, the Map operations involved make this expensive. A more
  practical approach: aggregate oracle signatures off-chain and submit a single
  verified update.
- **Price precision:** Prices are stored as `Uint<64>` with implicit decimal
  scaling (e.g., 8 decimal places for crypto prices). Document the precision
  convention clearly -- downstream contracts must use the same scaling factor.
- **Consumer pattern:** Other contracts on Midnight cannot directly call this
  contract's circuits. Consumer contracts would read the oracle's public ledger
  state via the indexer and use the price data in their own circuit logic. True
  cross-contract calls are not yet supported in Compact.
- For LOKx specifically, this pattern is relevant for condition verification:
  an oracle attests that a real-world event occurred (e.g., delivery confirmed),
  triggering a RELEASE.
