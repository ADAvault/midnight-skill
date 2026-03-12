# Time Lock

A time-locked vault that holds assets until a specified deadline, with
privacy-preserving ownership and optional early release by the owner.
Demonstrates the core LOK/RELEASE pattern.

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum LockState { empty, locked, released }

export ledger state: LockState;
export ledger owner: Bytes<32>;
export ledger beneficiary: Bytes<32>;
export ledger unlockTime: Uint<64>;
export ledger description: Opaque<"string">;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getCurrentTime(): Uint<64>;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "timelock:pk:"), seq, sk]);
}

constructor() {
  state = LockState.empty;
  sequence.increment(1);
}

// Owner creates a time lock
export circuit lock(
  beneficiaryPk: Bytes<32>,
  deadline: Uint<64>,
  desc: Opaque<"string">
): [] {
  assert(state == LockState.empty, "Already locked");

  owner = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  beneficiary = beneficiaryPk;
  unlockTime = deadline;
  description = desc;
  state = LockState.locked;
}

// Beneficiary claims after deadline
export circuit release(): [] {
  assert(state == LockState.locked, "Not locked");
  assert(beneficiary == publicKey(localSecretKey(), sequence as Field as Bytes<32>),
         "Not the beneficiary");

  const now = getCurrentTime();
  assert(disclose(now >= unlockTime), "Too early");

  state = LockState.released;
  sequence.increment(1);
}

// Owner can early-release
export circuit earlyRelease(): [] {
  assert(state == LockState.locked, "Not locked");
  assert(owner == publicKey(localSecretKey(), sequence as Field as Bytes<32>),
         "Not the owner");

  state = LockState.released;
  sequence.increment(1);
}
```

---

## Key Concepts

**LOK primitive:** `lock()` stores the beneficiary, deadline, and description. The
asset is logically locked until the deadline or owner intervention.

**RELEASE primitive:** `release()` verifies the caller is the beneficiary and the
deadline has passed. `earlyRelease()` allows the owner to override.

**Time handling limitations:**

- `getCurrentTime()` is a witness -- runs off-chain, not cryptographically enforced
- The network cannot enforce time constraints natively in current Compact
- Newer versions may support `blockTimeGreaterThan` ledger ADT for protocol-enforced time
- For production LOKx: time enforcement will need the protocol-level support

**Privacy design:**

- Owner identity: public (disclosed hash on ledger)
- Beneficiary identity: public (hash on ledger -- needed for verification)
- Unlock time: public (visible on ledger for transparency)
- Description: public (optional metadata)
- Secret keys: private (never leave witnesses)

---

## TypeScript Witnesses

```typescript
export interface TimeLockPrivateState {
  readonly secretKey: Uint8Array;
}

export const witnesses = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, TimeLockPrivateState>):
    [TimeLockPrivateState, Uint8Array] => [privateState, privateState.secretKey],

  getCurrentTime: ({ privateState }: WitnessContext<Ledger, TimeLockPrivateState>):
    [TimeLockPrivateState, bigint] => [privateState, BigInt(Date.now())],
};
```

---

## Tests

1. Lock (happy path)
2. Release after deadline (happy path)
3. Release before deadline (should fail)
4. Release by non-beneficiary (should fail)
5. Early release by owner (happy path)
6. Early release by non-owner (should fail)
7. Double-lock prevention
8. Release when empty (should fail)

---

## Extending for LOKx

Production LOKx time-lock would add:

- Multiple condition types (time + event + on-demand)
- Actual coin operations for asset transfer
- Condition composition (AND/OR of multiple conditions)
- Event hooks for indexer notification

---

## Notes

- This pattern is the building block for vesting schedules, payment channels, and timed releases
- For production: combine with coin operations (receive/send) for actual asset locking
- Circuit complexity is low (k ~12-13) -- fast proof generation
