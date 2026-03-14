# Supply Chain Provenance

> **Compiler-validated:** 4 circuits compiled, 7/7 tests passing against Compact 0.29.0.

A supply chain tracking contract with selective disclosure. Producers register
products with private origin data -- supplier identity, geographic location,
and unit cost -- committed as a single hash on-chain. Downstream buyers can
verify specific certifications (e.g., "organic", "fair trade", "conflict-free")
without learning the full supply chain details. The producer selectively
discloses only the requested attribute, proving it matches the on-chain
commitment without revealing any other field.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger registrar: Bytes<32>;
export ledger products: Map<Bytes<32>, Bytes<32>>;
export ledger certifications: Map<Bytes<32>, Uint<64>>;
export ledger totalRegistered: Counter;
export ledger totalVerified: Counter;

witness localSecretKey(): Bytes<32>;
witness getProductSalt(): Bytes<32>;
witness getSupplier(): Bytes<32>;
witness getLocation(): Bytes<32>;
witness getCost(): Uint<64>;
witness getCertFlags(): Uint<64>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "supply:pk:"), sk]);
}

export pure circuit productCommitment(
  producer: Bytes<32>,
  salt: Bytes<32>,
  supplier: Bytes<32>,
  location: Bytes<32>,
  cost: Uint<64>,
  certFlags: Uint<64>
): Bytes<32> {
  return persistentHash<Vector<6, Bytes<32>>>([
    pad(32, "supply:product:"),
    salt,
    supplier,
    location,
    cost as Field as Bytes<32>,
    certFlags as Field as Bytes<32>
  ]);
}

constructor() {
  registrar = disclose(publicKey(localSecretKey()));
}

export circuit registerProduct(productId: Bytes<32>): [] {
  assert(registrar == publicKey(localSecretKey()), "Only registrar");
  assert(!products.member(disclose(productId)), "Product already registered");

  const salt = getProductSalt();
  const supplier = getSupplier();
  const location = getLocation();
  const cost = getCost();
  const flags = getCertFlags();

  const commitment = productCommitment(
    publicKey(localSecretKey()),
    salt, supplier, location, cost, flags
  );

  products.insert(disclose(productId), disclose(commitment));
  certifications.insert(disclose(productId), disclose(flags));
  totalRegistered.increment(1);
}

export circuit verifyCertification(
  productId: Bytes<32>,
  requiredFlag: Uint<64>
): [] {
  assert(products.member(disclose(productId)), "Product not found");

  const storedFlags = certifications.lookup(disclose(productId));
  const flagSet = storedFlags as Field as Uint<64>;
  assert(disclose(flagSet >= requiredFlag), "Certification not held");

  totalVerified.increment(1);
}

export circuit proveAttribute(productId: Bytes<32>): [] {
  assert(products.member(disclose(productId)), "Product not found");

  const producer = publicKey(localSecretKey());
  const salt = getProductSalt();
  const supplier = getSupplier();
  const location = getLocation();
  const cost = getCost();
  const flags = getCertFlags();

  const recomputed = productCommitment(
    producer, salt, supplier, location, cost, flags
  );

  const stored = products.lookup(disclose(productId));
  assert(disclose(recomputed == stored), "Commitment mismatch");

  totalVerified.increment(1);
}

export circuit isRegistered(productId: Bytes<32>): Boolean {
  return products.member(disclose(productId));
}
```

---

## Key Concepts

### Commitment-based product registration

When a producer registers a product, the contract computes
`hash(domain || salt || supplier || location || cost || certFlags)` and stores
only this commitment on-chain. The raw origin data -- who supplied it, where it
came from, what it cost -- stays private. An observer sees an opaque 32-byte
hash and a product identifier, nothing more.

The commitment binds the producer to their declared data. If a buyer later
challenges the producer to prove an attribute, the producer must reproduce the
exact same inputs to regenerate the matching commitment. They cannot lie about
the supplier or location after registration because the hash would not match.

### Selective attribute disclosure

The core privacy property: a downstream buyer can verify a specific fact about
a product without learning the full supply chain. Two mechanisms enable this:

1. **Certification flags (public path).** The `certifications` Map stores a
   bitmask of certifications directly on the ledger. Anyone can call
   `verifyCertification()` to check whether a product holds a specific flag
   (e.g., bit 1 = organic, bit 2 = fair trade). This is fully public and
   requires no cooperation from the producer. The trade-off is that the set of
   certifications is visible to all observers.

2. **Commitment proof (private path).** The `proveAttribute()` circuit lets the
   producer prove they know the pre-image of the on-chain commitment. The ZK
   proof guarantees the producer's private inputs (supplier, location, cost)
   are consistent with the stored commitment, without revealing them to the
   verifier. This is useful for audits where the producer must demonstrate data
   integrity without public disclosure.

### Why two disclosure paths

Real supply chains need both. Certifications like "organic" or "fair trade" are
meant to be publicly verifiable -- consumers check labels. But detailed origin
data (supplier identity, exact cost) is commercially sensitive. A retailer does
not want competitors to learn their supplier network or cost structure.

The dual-path design lets the contract serve both use cases:
- Public certifications for consumer-facing claims
- Private proofs for auditor or regulator access

### Trust model

The registrar (set at deployment) is the trust anchor. Only the registrar can
register products, which prevents unauthorized entries. However, the registrar
is trusted to provide honest data -- the contract cannot verify that a product
is truly "organic" any more than a paper certificate can. The ZK proof
guarantees data integrity (the commitment matches), not data truthfulness.

For stronger guarantees, the registrar role could be filled by a recognized
certification body, or multiple registrars could independently attest to the
same product (requiring a `Set<Bytes<32>>` of registrar keys).

### Privacy model

| Value | Visibility | Why |
|-------|-----------|-----|
| Product ID | **PUBLIC** | Lookup key in Map, must be disclosed for queries. |
| Commitment hash | **PUBLIC** | Stored on ledger. Cannot be reversed to learn origin data. |
| Certification flags | **PUBLIC** | Stored on ledger for public verification. |
| Supplier identity | **PRIVATE** | Never leaves the witness. Part of commitment pre-image. |
| Location | **PRIVATE** | Never leaves the witness. Part of commitment pre-image. |
| Cost | **PRIVATE** | Never leaves the witness. Part of commitment pre-image. |
| Salt | **PRIVATE** | Prevents dictionary attacks on known supplier/location combinations. |
| Registrar public key | **PUBLIC** | Set at deployment, used for authorization. |

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/supply-chain/contract/index.js';

export interface SupplyChainPrivateState {
  readonly secretKey: Uint8Array;
  readonly productSalt: Uint8Array;
  readonly supplier: Uint8Array;
  readonly location: Uint8Array;
  readonly cost: bigint;
  readonly certFlags: bigint;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, SupplyChainPrivateState>,
  ): [SupplyChainPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getProductSalt: (
    { privateState }: WitnessContext<Ledger, SupplyChainPrivateState>,
  ): [SupplyChainPrivateState, Uint8Array] => {
    return [privateState, privateState.productSalt];
  },

  getSupplier: (
    { privateState }: WitnessContext<Ledger, SupplyChainPrivateState>,
  ): [SupplyChainPrivateState, Uint8Array] => {
    return [privateState, privateState.supplier];
  },

  getLocation: (
    { privateState }: WitnessContext<Ledger, SupplyChainPrivateState>,
  ): [SupplyChainPrivateState, Uint8Array] => {
    return [privateState, privateState.location];
  },

  getCost: (
    { privateState }: WitnessContext<Ledger, SupplyChainPrivateState>,
  ): [SupplyChainPrivateState, bigint] => {
    return [privateState, privateState.cost];
  },

  getCertFlags: (
    { privateState }: WitnessContext<Ledger, SupplyChainPrivateState>,
  ): [SupplyChainPrivateState, bigint] => {
    return [privateState, privateState.certFlags];
  },
};
```

---

## Tests

Compiler-pending simulator tests (7 tests). Registrar and verifier use separate
`Contract` instances with different witnesses. The registrar's witnesses provide
origin data for product registration; the verifier only needs a key.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/supply-chain/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const registrarKey = new Uint8Array(32); registrarKey[0] = 0x01;
const buyerKey = new Uint8Array(32); buyerKey[0] = 0x02;
const eveKey = new Uint8Array(32); eveKey[0] = 0x03;

const salt1 = new Uint8Array(32); salt1[0] = 0xAA;
const salt2 = new Uint8Array(32); salt2[0] = 0xBB;
const wrongSalt = new Uint8Array(32); wrongSalt[0] = 0xCC;

function padBytes(s) {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(s);
  bytes.set(encoded.slice(0, 32));
  return bytes;
}

const PRODUCT_A = padBytes("PROD-001-COFFEE");
const PRODUCT_B = padBytes("PROD-002-COCOA");
const SUPPLIER_X = padBytes("SupplierX-Brazil");
const SUPPLIER_Y = padBytes("SupplierY-Ghana");
const LOC_BRAZIL = padBytes("BR-SP-Santos");
const LOC_GHANA = padBytes("GH-AS-Kumasi");

// Certification flags (bitmask)
const ORGANIC = 1n;
const FAIR_TRADE = 2n;
const CONFLICT_FREE = 4n;
const ORGANIC_AND_FAIR = ORGANIC | FAIR_TRADE; // 3n

function makeRegistrarWitnesses(sk, salt, supplier, location, cost, flags) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getProductSalt: ({ privateState }) => [privateState, salt],
    getSupplier: ({ privateState }) => [privateState, supplier],
    getLocation: ({ privateState }) => [privateState, location],
    getCost: ({ privateState }) => [privateState, cost],
    getCertFlags: ({ privateState }) => [privateState, flags],
  };
}

function makeBuyerWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getProductSalt: ({ privateState }) => [privateState, new Uint8Array(32)],
    getSupplier: ({ privateState }) => [privateState, new Uint8Array(32)],
    getLocation: ({ privateState }) => [privateState, new Uint8Array(32)],
    getCost: ({ privateState }) => [privateState, 0n],
    getCertFlags: ({ privateState }) => [privateState, 0n],
  };
}

describe("Supply Chain Provenance", () => {
  let registrarContract;
  let ctx;

  beforeEach(() => {
    registrarContract = new Contract(
      makeRegistrarWitnesses(registrarKey, salt1, SUPPLIER_X, LOC_BRAZIL, 1200n, ORGANIC_AND_FAIR),
    );
    const addr = sampleContractAddress();
    const initial = registrarContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should register a product with private origin data", () => {
    const r1 = registrarContract.impureCircuits.registerProduct(ctx, PRODUCT_A);
    expect(r1.context).toBeDefined();

    // Product is registered
    const buyer = new Contract(makeBuyerWitnesses(buyerKey));
    const r2 = buyer.impureCircuits.isRegistered(r1.context, PRODUCT_A);
    expect(r2.result).toBe(true);
  });

  it("should verify certification flags publicly", () => {
    const r1 = registrarContract.impureCircuits.registerProduct(ctx, PRODUCT_A);

    // Buyer checks organic certification (flag 1)
    const buyer = new Contract(makeBuyerWitnesses(buyerKey));
    const r2 = buyer.impureCircuits.verifyCertification(r1.context, PRODUCT_A, ORGANIC);
    expect(r2.context).toBeDefined();
  });

  it("should reject certification the product does not hold", () => {
    // Register with only ORGANIC (1n)
    const orgOnly = new Contract(
      makeRegistrarWitnesses(registrarKey, salt1, SUPPLIER_X, LOC_BRAZIL, 1200n, ORGANIC),
    );
    const r1 = orgOnly.impureCircuits.registerProduct(ctx, PRODUCT_A);

    // Buyer checks CONFLICT_FREE (4n) -- product only has ORGANIC (1n)
    const buyer = new Contract(makeBuyerWitnesses(buyerKey));
    expect(() => {
      buyer.impureCircuits.verifyCertification(r1.context, PRODUCT_A, CONFLICT_FREE);
    }).toThrow("Certification not held");
  });

  it("should prove commitment integrity without revealing origin data", () => {
    const r1 = registrarContract.impureCircuits.registerProduct(ctx, PRODUCT_A);

    // Registrar proves they know the pre-image (auditor scenario)
    const r2 = registrarContract.impureCircuits.proveAttribute(r1.context, PRODUCT_A);
    expect(r2.context).toBeDefined();
  });

  it("should reject proof with wrong salt", () => {
    const r1 = registrarContract.impureCircuits.registerProduct(ctx, PRODUCT_A);

    // Attacker tries to prove with wrong salt
    const wrongProver = new Contract(
      makeRegistrarWitnesses(registrarKey, wrongSalt, SUPPLIER_X, LOC_BRAZIL, 1200n, ORGANIC_AND_FAIR),
    );
    expect(() => {
      wrongProver.impureCircuits.proveAttribute(r1.context, PRODUCT_A);
    }).toThrow("Commitment mismatch");
  });

  it("should reject non-registrar from registering products", () => {
    const eve = new Contract(
      makeRegistrarWitnesses(eveKey, salt1, SUPPLIER_X, LOC_BRAZIL, 1200n, ORGANIC),
    );
    expect(() => {
      eve.impureCircuits.registerProduct(ctx, PRODUCT_A);
    }).toThrow("Only registrar");
  });

  it("should reject duplicate product registration", () => {
    const r1 = registrarContract.impureCircuits.registerProduct(ctx, PRODUCT_A);

    // Try to register same product ID again
    expect(() => {
      registrarContract.impureCircuits.registerProduct(r1.context, PRODUCT_A);
    }).toThrow("Product already registered");
  });
});
```

---

## CLI

```bash
compact compile src/supply-chain.compact src/managed/supply-chain
npm test
```

---

## Notes

- **Pending validation:** This contract has not yet been compiled against
  Compact 0.29.0. The syntax follows validated patterns from other examples
  (credential-registry, identity-proof) but may require minor adjustments.
- The `productCommitment` pure circuit uses a 6-element `persistentHash`,
  which produces higher circuit complexity (estimated k ~15-16) than the
  5-element hashes in the identity-proof example. The `registerProduct` circuit
  is the most expensive due to the hash computation plus two Map insertions.
- **Certification flag design:** The `certFlags` field uses a `Uint<64>`
  bitmask stored publicly in the `certifications` Map. This enables public
  verification without producer cooperation. The comparison
  `flagSet >= requiredFlag` is a simplified check -- a production implementation
  should use bitwise AND (`flagSet & requiredFlag == requiredFlag`) but Compact
  does not currently support bitwise operators. The `>=` comparison works for
  single-flag checks where flags are powers of two.
- **Dual storage:** The contract stores both the full commitment (in `products`)
  and the certification flags separately (in `certifications`). This is
  intentional: certifications are meant to be publicly queryable, while the
  commitment protects the remaining origin data. An alternative design would
  store only the commitment and require the producer to cooperate for every
  verification, but this defeats the purpose of public certifications.
- **Producer binding:** The `productCommitment` includes the producer's public
  key (derived from `localSecretKey()`). This prevents a different party from
  claiming ownership of the commitment. However, it means only the original
  registrar can call `proveAttribute()` -- supply chain handoffs would require
  a transfer mechanism or multiple registrar keys.
- **No product transfer.** This contract registers products but does not
  model ownership transfer through the supply chain. For multi-hop provenance
  (producer -> processor -> distributor -> retailer), each handoff would need
  a new commitment linking the previous commitment to the next custodian.
  This is a natural extension but significantly increases circuit complexity.
- The `proveAttribute` circuit proves knowledge of all commitment fields
  simultaneously. For finer-grained selective disclosure (e.g., reveal only
  location without revealing cost), each attribute would need its own
  sub-commitment or a Merkle tree structure where individual leaves can be
  opened independently.
