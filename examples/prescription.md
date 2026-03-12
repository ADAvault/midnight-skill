# Prescription

> **Compiler-validated:** Contract compiles (5 circuits) and 6/6 tests pass against Compact 0.29.0.

A healthcare prescription contract with batch registration and nullifier-based
double-fill prevention. A prescribing authority (hospital, doctor) issues
prescriptions as hash commitments. A patient or pharmacy fills a prescription
by proving knowledge of the commitment pre-image without revealing patient
identity. A nullifier ensures each prescription can only be filled once.
Demonstrates batch operations in Compact (inline parameter processing, since
dynamic loops are not available), the nullifier pattern applied to healthcare,
and authority-based issuance with patient privacy.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger authority: Bytes<32>;
export ledger prescriptions: Map<Bytes<32>, Boolean>;
export ledger filled: Set<Bytes<32>>;
export ledger totalIssued: Counter;
export ledger totalFilled: Counter;

witness localSecretKey(): Bytes<32>;
witness getPatientId(): Bytes<32>;
witness getMedicationId(): Bytes<32>;
witness getPrescriptionSalt(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "rx:pk:"), sk]);
}

export pure circuit prescriptionCommitment(
  auth: Bytes<32>,
  patient: Bytes<32>,
  medication: Bytes<32>,
  salt: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<5, Bytes<32>>>([
    pad(32, "rx:commit:"),
    auth,
    patient,
    medication,
    salt
  ]);
}

export pure circuit prescriptionNullifier(
  patient: Bytes<32>,
  medication: Bytes<32>,
  salt: Bytes<32>
): Bytes<32> {
  return persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "rx:null:"),
    patient,
    medication,
    salt
  ]);
}

constructor() {
  authority = disclose(publicKey(localSecretKey()));
}

export circuit prescribe(commitment: Bytes<32>): [] {
  assert(publicKey(localSecretKey()) == authority, "Only authority can prescribe");
  prescriptions.insert(disclose(commitment), true);
  totalIssued.increment(1);
}

export circuit prescribeBatch(
  c1: Bytes<32>,
  c2: Bytes<32>,
  c3: Bytes<32>
): [] {
  assert(publicKey(localSecretKey()) == authority, "Only authority can prescribe");
  prescriptions.insert(disclose(c1), true);
  totalIssued.increment(1);
  prescriptions.insert(disclose(c2), true);
  totalIssued.increment(1);
  prescriptions.insert(disclose(c3), true);
  totalIssued.increment(1);
}

export circuit fill(): [] {
  const patient = getPatientId();
  const medication = getMedicationId();
  const salt = getPrescriptionSalt();

  const commitment = prescriptionCommitment(
    authority,
    patient,
    medication,
    salt
  );

  assert(prescriptions.member(disclose(commitment)), "Prescription not found");

  const nullifier = prescriptionNullifier(patient, medication, salt);
  assert(!filled.member(disclose(nullifier)), "Prescription already filled");

  filled.insert(disclose(nullifier));
  totalFilled.increment(1);
}

export circuit verify(commitment: Bytes<32>): Boolean {
  return prescriptions.member(disclose(commitment));
}

export circuit isFilled(nullifier: Bytes<32>): Boolean {
  return filled.member(disclose(nullifier));
}
```

---

## Key Concepts

### Batch Operations in Compact

Compact has no dynamic loops -- you cannot iterate over a `Vector` parameter
with a `for` loop. The `prescribeBatch` circuit accepts three separate
parameters and processes them inline. This is the standard Compact pattern for
batch operations: accept N explicit parameters and repeat the logic for each.
The trade-off is a larger circuit (higher k-value) in exchange for fewer
transactions. For larger batches, use multiple `prescribeBatch` calls.

### Nullifier Pattern for Healthcare

The nullifier is a deterministic hash of `(patient, medication, salt)`. It
uniquely identifies a prescription fill without revealing who the patient is or
what medication was filled. The chain observer sees only the nullifier hash
being inserted into the `filled` Set. If the same prescription is filled again,
the same nullifier is computed and the `assert(!filled.member(...))` check
prevents the double-fill.

This is the same nullifier pattern used in Zcash and Tornado Cash for
preventing double-spends, applied here to single-use credentials
(prescriptions).

### Authority-Based Issuance

Only the entity whose secret key matches the stored `authority` public key can
issue prescriptions. The authority registers commitments; anyone with knowledge
of the pre-image (patient ID, medication, salt) can fill. In practice, the
prescribing doctor shares the salt with the patient or pharmacy off-chain.

### Patient Privacy

The `fill()` circuit proves: "I know a (patient, medication, salt) tuple whose
commitment matches one on-chain, and whose nullifier has not been used." The
patient ID, medication ID, and salt never appear on-chain -- only their hashes
(commitment and nullifier) are disclosed. Chain observers cannot link a fill
to a specific patient or medication.

### Commitment vs. Nullifier Separation

| Hash | Inputs | Purpose |
|------|--------|---------|
| **Commitment** | `authority + patient + medication + salt` | Proves the prescription exists and was issued by the authority |
| **Nullifier** | `patient + medication + salt` | Prevents the same prescription from being filled twice |

The commitment includes the authority to bind the prescription to a specific
issuer. The nullifier omits the authority because double-fill prevention is
independent of who issued it.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../src/managed/prescription/contract/index.js';

export interface PrescriptionPrivateState {
  readonly secretKey: Uint8Array;
  readonly patientId: Uint8Array;
  readonly medicationId: Uint8Array;
  readonly prescriptionSalt: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, PrescriptionPrivateState>,
  ): [PrescriptionPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getPatientId: (
    { privateState }: WitnessContext<Ledger, PrescriptionPrivateState>,
  ): [PrescriptionPrivateState, Uint8Array] => {
    return [privateState, privateState.patientId];
  },

  getMedicationId: (
    { privateState }: WitnessContext<Ledger, PrescriptionPrivateState>,
  ): [PrescriptionPrivateState, Uint8Array] => {
    return [privateState, privateState.medicationId];
  },

  getPrescriptionSalt: (
    { privateState }: WitnessContext<Ledger, PrescriptionPrivateState>,
  ): [PrescriptionPrivateState, Uint8Array] => {
    return [privateState, privateState.prescriptionSalt];
  },
};
```

---

## Tests

Compiler-validated simulator tests (6/6 passing). Authority and patient use
separate `Contract` instances with different witnesses. The patient's witnesses
provide the pre-image values needed for filling.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits } from "../src/managed/prescription/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const authorityKey = new Uint8Array(32); authorityKey[0] = 0x01;
const patientKey = new Uint8Array(32); patientKey[0] = 0x02;
const nonAuthorityKey = new Uint8Array(32); nonAuthorityKey[0] = 0x03;

const patientId = new Uint8Array(32); patientId[0] = 0x10;
const medicationA = new Uint8Array(32); medicationA[0] = 0x20;
const medicationB = new Uint8Array(32); medicationB[0] = 0x21;
const medicationC = new Uint8Array(32); medicationC[0] = 0x22;
const salt = new Uint8Array(32); salt[0] = 0xAA;
const wrongSalt = new Uint8Array(32); wrongSalt[0] = 0xBB;

function makeAuthorityWitnesses(sk) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getPatientId: ({ privateState }) => [privateState, new Uint8Array(32)],
    getMedicationId: ({ privateState }) => [privateState, new Uint8Array(32)],
    getPrescriptionSalt: ({ privateState }) => [privateState, new Uint8Array(32)],
  };
}

function makePatientWitnesses(sk, patient, medication, rxSalt) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getPatientId: ({ privateState }) => [privateState, patient],
    getMedicationId: ({ privateState }) => [privateState, medication],
    getPrescriptionSalt: ({ privateState }) => [privateState, rxSalt],
  };
}

describe("Prescription", () => {
  let authorityContract;
  let ctx;
  let authorityPk;

  beforeEach(() => {
    authorityContract = new Contract(makeAuthorityWitnesses(authorityKey));
    const addr = sampleContractAddress();
    const initial = authorityContract.initialState(createConstructorContext({}, addr));
    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
    authorityPk = pureCircuits.publicKey(authorityKey);
  });

  it("should prescribe and fill a single prescription", () => {
    const commitment = pureCircuits.prescriptionCommitment(
      authorityPk, patientId, medicationA, salt
    );
    const r1 = authorityContract.impureCircuits.prescribe(ctx, commitment);

    const patient = new Contract(makePatientWitnesses(patientKey, patientId, medicationA, salt));
    const r2 = patient.impureCircuits.fill(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject double-fill via nullifier", () => {
    const commitment = pureCircuits.prescriptionCommitment(
      authorityPk, patientId, medicationA, salt
    );
    const r1 = authorityContract.impureCircuits.prescribe(ctx, commitment);

    const patient = new Contract(makePatientWitnesses(patientKey, patientId, medicationA, salt));
    const r2 = patient.impureCircuits.fill(r1.context);

    const patient2 = new Contract(makePatientWitnesses(patientKey, patientId, medicationA, salt));
    expect(() => {
      patient2.impureCircuits.fill(r2.context);
    }).toThrow("Prescription already filled");
  });

  it("should fill from a batch prescription", () => {
    const c1 = pureCircuits.prescriptionCommitment(authorityPk, patientId, medicationA, salt);
    const c2 = pureCircuits.prescriptionCommitment(authorityPk, patientId, medicationB, salt);
    const c3 = pureCircuits.prescriptionCommitment(authorityPk, patientId, medicationC, salt);

    const r1 = authorityContract.impureCircuits.prescribeBatch(ctx, c1, c2, c3);

    const patient = new Contract(makePatientWitnesses(patientKey, patientId, medicationB, salt));
    const r2 = patient.impureCircuits.fill(r1.context);
    expect(r2.context).toBeDefined();
  });

  it("should reject fill with wrong salt", () => {
    const commitment = pureCircuits.prescriptionCommitment(
      authorityPk, patientId, medicationA, salt
    );
    const r1 = authorityContract.impureCircuits.prescribe(ctx, commitment);

    const patient = new Contract(makePatientWitnesses(patientKey, patientId, medicationA, wrongSalt));
    expect(() => {
      patient.impureCircuits.fill(r1.context);
    }).toThrow("Prescription not found");
  });

  it("should reject non-authority prescribing", () => {
    const nonAuth = new Contract(makeAuthorityWitnesses(nonAuthorityKey));
    const commitment = pureCircuits.prescriptionCommitment(
      authorityPk, patientId, medicationA, salt
    );
    expect(() => {
      nonAuth.impureCircuits.prescribe(ctx, commitment);
    }).toThrow("Only authority can prescribe");
  });

  it("should verify and check filled status", () => {
    const commitment = pureCircuits.prescriptionCommitment(
      authorityPk, patientId, medicationA, salt
    );
    const nullifier = pureCircuits.prescriptionNullifier(patientId, medicationA, salt);

    const r1 = authorityContract.impureCircuits.prescribe(ctx, commitment);
    const r2 = authorityContract.impureCircuits.verify(r1.context, commitment);
    expect(r2.result).toBe(true);

    const r3 = authorityContract.impureCircuits.isFilled(r2.context, nullifier);
    expect(r3.result).toBe(false);

    const patient = new Contract(makePatientWitnesses(patientKey, patientId, medicationA, salt));
    const r4 = patient.impureCircuits.fill(r3.context);

    const r5 = authorityContract.impureCircuits.isFilled(r4.context, nullifier);
    expect(r5.result).toBe(true);
  });
});
```

---

## CLI

```bash
compact compile src/prescription.compact src/managed/prescription
npm test
```

---

## Notes

- Circuit complexity is moderate for `prescribe` and `fill` (k ~13-14), but
  `prescribeBatch` is heavier (k ~16) due to three inline Map insertions and
  Counter increments. If k-value limits are hit, split into single `prescribe`
  calls.
- The batch pattern (explicit parameters, inline processing) is the only way
  to handle multiple items in a single Compact circuit. There are no `for`
  loops, no dynamic iteration over Vectors, and no recursion. Each item must
  be processed with duplicated inline logic.
- **No sequence counter** is needed here. The authority key is deterministic
  from the secret key alone. Prescriptions are additive (no state transitions
  that would require replay protection on the authority identity).
- The `filled` Set uses `.insert(value)` and `.member(value)` -- single
  argument, not key-value. This is distinct from Map's `.insert(key, value)`.
- **Revocation** is not implemented. A production system would add a
  `revoked: Set<Bytes<32>>` and check `!revoked.member(commitment)` in `fill`.
- The `prescriptionCommitment` and `prescriptionNullifier` pure circuits are
  exported so they can be called off-chain via `pureCircuits.*` for commitment
  and nullifier pre-computation in TypeScript.
- Patient privacy is strong: the `fill()` circuit reveals only the commitment
  hash and nullifier hash. A chain observer cannot determine the patient,
  medication, or prescribing relationship.
