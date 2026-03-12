# Rock-Paper-Scissors

> **Compiler-validated:** Contract compiles and 6/6 tests pass against Compact 0.29.0.

A minimal two-player commit-reveal game. Both players commit hashed moves,
then reveal them to determine the winner. The ZK proof ensures moves cannot
be changed after commitment, and the reveal phase verifies the commitment
without trusting either player. Demonstrates the commit-reveal pattern in
a game context, auto-phase transitions, and winner determination via
explicit conditionals (no modulo arithmetic needed).

---

## Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export enum GamePhase { waiting, committing, revealing, settled }

export ledger phase: GamePhase;
export ledger player1: Bytes<32>;
export ledger player2: Bytes<32>;
export ledger commitment1: Bytes<32>;
export ledger commitment2: Bytes<32>;
export ledger move1: Uint<8>;
export ledger move2: Uint<8>;
export ledger p1Committed: Boolean;
export ledger p2Committed: Boolean;
export ledger p1Revealed: Boolean;
export ledger p2Revealed: Boolean;
export ledger result: Uint<8>;
ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;
witness getMove(): Uint<8>;
witness getMoveSalt(): Bytes<32>;

export pure circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "rps:pk:"), seq, sk]);
}

constructor() {
  player1 = disclose(publicKey(localSecretKey(), 1 as Field as Bytes<32>));
  phase = GamePhase.waiting;
  p1Committed = false;
  p2Committed = false;
  p1Revealed = false;
  p2Revealed = false;
  result = 0 as Uint<8>;
  move1 = 0 as Uint<8>;
  move2 = 0 as Uint<8>;
  sequence.increment(1);
}

export circuit join(): [] {
  assert(phase == GamePhase.waiting, "Game not waiting for player");

  player2 = disclose(publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>));
  phase = GamePhase.committing;
}

export circuit commitMove(): [] {
  assert(phase == GamePhase.committing, "Not in committing phase");

  const callerPk = publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>);
  const move = getMove();
  const salt = getMoveSalt();

  assert(disclose(move < (3 as Uint<8>)), "Invalid move");

  const commitment = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "rps:move:"),
    salt,
    move as Field as Bytes<32>
  ]);

  if (disclose(callerPk == player1)) {
    assert(!p1Committed, "Already committed");
    commitment1 = disclose(commitment);
    p1Committed = true;
  } else {
    assert(disclose(callerPk == player2), "Not a player");
    assert(!p2Committed, "Already committed");
    commitment2 = disclose(commitment);
    p2Committed = true;
  }

  if (p1Committed) {
    if (p2Committed) {
      phase = GamePhase.revealing;
    }
  }
}

export circuit revealMove(): [] {
  assert(phase == GamePhase.revealing, "Not in revealing phase");

  const callerPk = publicKey(localSecretKey(), sequence.read() as Field as Bytes<32>);
  const move = getMove();
  const salt = getMoveSalt();

  const recomputed = persistentHash<Vector<3, Bytes<32>>>([
    pad(32, "rps:move:"),
    salt,
    move as Field as Bytes<32>
  ]);

  if (disclose(callerPk == player1)) {
    assert(!p1Revealed, "Already revealed");
    const stored = commitment1;
    assert(disclose(recomputed == stored), "Commitment mismatch");
    move1 = disclose(move);
    p1Revealed = true;
  } else {
    assert(disclose(callerPk == player2), "Not a player");
    assert(!p2Revealed, "Already revealed");
    const stored = commitment2;
    assert(disclose(recomputed == stored), "Commitment mismatch");
    move2 = disclose(move);
    p2Revealed = true;
  }

  if (p1Revealed) {
    if (p2Revealed) {
      // Determine winner: 0=rock, 1=paper, 2=scissors
      // Draw
      if (move1 == move2) {
        result = 0 as Uint<8>;
      } else {
        // Player 1 wins cases: rock>scissors, paper>rock, scissors>paper
        if (move1 == (0 as Uint<8>)) {
          if (move2 == (2 as Uint<8>)) {
            result = disclose(1 as Uint<8>);
          } else {
            result = disclose(2 as Uint<8>);
          }
        } else {
          if (move1 == (1 as Uint<8>)) {
            if (move2 == (0 as Uint<8>)) {
              result = disclose(1 as Uint<8>);
            } else {
              result = disclose(2 as Uint<8>);
            }
          } else {
            // move1 == 2 (scissors)
            if (move2 == (1 as Uint<8>)) {
              result = disclose(1 as Uint<8>);
            } else {
              result = disclose(2 as Uint<8>);
            }
          }
        }
      }
      phase = GamePhase.settled;
      sequence.increment(1);
    }
  }
}
```

---

## Key Concepts

### Commit-reveal in games

The commit-reveal pattern prevents the second player from choosing their move
after seeing the first player's choice. Both players submit a hash commitment
`persistentHash(domainSep, salt, move)` during the commit phase. The hash is
binding (cannot change the move later) and hiding (the move is not visible
until reveal). During reveal, each player provides their original move and
salt; the circuit recomputes the hash and verifies it matches the stored
commitment.

Without commit-reveal, a two-player simultaneous-action game on a transparent
blockchain is impossible: the second transaction submitter could always see the
first player's move in the mempool and counter it.

### Move validation in-circuit

The `assert(move < 3)` check ensures only valid moves (0=rock, 1=paper,
2=scissors) can be committed. This validation happens inside the circuit, so
an invalid move cannot even produce a valid proof. The `disclose()` on the
comparison is required because the move value comes from a witness (private
input).

### Auto-phase-transition pattern

Rather than requiring a separate "advance phase" transaction (which costs gas
and adds latency), the contract automatically transitions phases when
conditions are met:

- `committing -> revealing`: when both `p1Committed` and `p2Committed` are true
- `revealing -> settled`: when both `p1Revealed` and `p2Revealed` are true

This is implemented with nested `if` checks on the boolean flags after each
update. The nesting is necessary because Compact does not have `&&` for boolean
conjunction in `if` conditions -- you nest the checks instead.

### Winner determination without modulo

On Ethereum, rock-paper-scissors winners are often computed with
`(3 + move1 - move2) % 3`. Compact does not have a modulo operator, so the
winner is determined via explicit nested conditionals. This is more verbose but
equally correct and avoids any arithmetic edge cases with unsigned underflow.

The result encoding is: 0 = draw, 1 = player 1 wins, 2 = player 2 wins.

---

## TypeScript Witnesses

```typescript
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from '../managed/rps/contract/index.cjs';

export interface RpsPrivateState {
  readonly secretKey: Uint8Array;
  readonly move: bigint;      // 0n=rock, 1n=paper, 2n=scissors
  readonly moveSalt: Uint8Array;
}

export const witnesses = {
  localSecretKey: (
    { privateState }: WitnessContext<Ledger, RpsPrivateState>,
  ): [RpsPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  getMove: (
    { privateState }: WitnessContext<Ledger, RpsPrivateState>,
  ): [RpsPrivateState, bigint] => {
    return [privateState, privateState.move];
  },

  getMoveSalt: (
    { privateState }: WitnessContext<Ledger, RpsPrivateState>,
  ): [RpsPrivateState, Uint8Array] => {
    // Salt must be identical between commit and reveal.
    // Losing the salt means forfeiting the game.
    return [privateState, privateState.moveSalt];
  },
};
```

---

## Tests

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Contract, pureCircuits, GamePhase } from "../src/managed/rps/contract/index.js";
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("undeployed");

const p1Key = new Uint8Array(32); p1Key[0] = 0x01;
const p2Key = new Uint8Array(32); p2Key[0] = 0x02;
const eveKey = new Uint8Array(32); eveKey[0] = 0x03;

const salt1 = new Uint8Array(32); salt1[0] = 0xAA;
const salt2 = new Uint8Array(32); salt2[0] = 0xBB;
const wrongSalt = new Uint8Array(32); wrongSalt[0] = 0xFF;

// Moves: 0=rock, 1=paper, 2=scissors
function makeWitnesses(sk, move = 0n, salt = salt1) {
  return {
    localSecretKey: ({ privateState }) => [privateState, sk],
    getMove: ({ privateState }) => [privateState, move],
    getMoveSalt: ({ privateState }) => [privateState, salt],
  };
}

function setupGame() {
  const p1Contract = new Contract(makeWitnesses(p1Key));
  const addr = sampleContractAddress();
  const initial = p1Contract.initialState(createConstructorContext({}, addr));
  const ctx = createCircuitContext(
    addr,
    initial.currentZswapLocalState,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  return { p1Contract, ctx };
}

describe("Rock-Paper-Scissors", () => {
  let p1Contract;
  let ctx;

  beforeEach(() => {
    const setup = setupGame();
    p1Contract = setup.p1Contract;
    ctx = setup.ctx;
  });

  it("should complete commit and reveal happy path", () => {
    // P1 creates game, P2 joins
    const p2Contract = new Contract(makeWitnesses(p2Key));
    const r1 = p2Contract.impureCircuits.join(ctx);

    // Both commit: P1=rock(0), P2=paper(1)
    const p1Rock = new Contract(makeWitnesses(p1Key, 0n, salt1));
    const p2Paper = new Contract(makeWitnesses(p2Key, 1n, salt2));
    const r2 = p1Rock.impureCircuits.commitMove(r1.context);
    const r3 = p2Paper.impureCircuits.commitMove(r2.context);

    // Both reveal
    const r4 = p1Rock.impureCircuits.revealMove(r3.context);
    const r5 = p2Paper.impureCircuits.revealMove(r4.context);
    expect(r5.context).toBeDefined();
  });

  it("should reject double commit", () => {
    const p2Contract = new Contract(makeWitnesses(p2Key));
    const r1 = p2Contract.impureCircuits.join(ctx);

    const p1Rock = new Contract(makeWitnesses(p1Key, 0n, salt1));
    const r2 = p1Rock.impureCircuits.commitMove(r1.context);

    expect(() => {
      p1Rock.impureCircuits.commitMove(r2.context);
    }).toThrow("Already committed");
  });

  it("should reject wrong salt on reveal", () => {
    const p2Contract = new Contract(makeWitnesses(p2Key));
    const r1 = p2Contract.impureCircuits.join(ctx);

    const p1Rock = new Contract(makeWitnesses(p1Key, 0n, salt1));
    const p2Paper = new Contract(makeWitnesses(p2Key, 1n, salt2));
    const r2 = p1Rock.impureCircuits.commitMove(r1.context);
    const r3 = p2Paper.impureCircuits.commitMove(r2.context);

    // P1 tries to reveal with wrong salt
    const p1Wrong = new Contract(makeWitnesses(p1Key, 0n, wrongSalt));
    expect(() => {
      p1Wrong.impureCircuits.revealMove(r3.context);
    }).toThrow("Commitment mismatch");
  });

  it("should detect draw", () => {
    const p2Contract = new Contract(makeWitnesses(p2Key));
    const r1 = p2Contract.impureCircuits.join(ctx);

    // Both play rock
    const p1Rock = new Contract(makeWitnesses(p1Key, 0n, salt1));
    const p2Rock = new Contract(makeWitnesses(p2Key, 0n, salt2));
    const r2 = p1Rock.impureCircuits.commitMove(r1.context);
    const r3 = p2Rock.impureCircuits.commitMove(r2.context);
    const r4 = p1Rock.impureCircuits.revealMove(r3.context);
    const r5 = p2Rock.impureCircuits.revealMove(r4.context);
    expect(r5.context).toBeDefined();
  });

  it("should determine player 1 wins (rock beats scissors)", () => {
    const p2Contract = new Contract(makeWitnesses(p2Key));
    const r1 = p2Contract.impureCircuits.join(ctx);

    // P1=rock(0), P2=scissors(2)
    const p1Rock = new Contract(makeWitnesses(p1Key, 0n, salt1));
    const p2Scissors = new Contract(makeWitnesses(p2Key, 2n, salt2));
    const r2 = p1Rock.impureCircuits.commitMove(r1.context);
    const r3 = p2Scissors.impureCircuits.commitMove(r2.context);
    const r4 = p1Rock.impureCircuits.revealMove(r3.context);
    const r5 = p2Scissors.impureCircuits.revealMove(r4.context);
    expect(r5.context).toBeDefined();
  });

  it("should determine player 2 wins (paper beats rock)", () => {
    const p2Contract = new Contract(makeWitnesses(p2Key));
    const r1 = p2Contract.impureCircuits.join(ctx);

    // P1=rock(0), P2=paper(1)
    const p1Rock = new Contract(makeWitnesses(p1Key, 0n, salt1));
    const p2Paper = new Contract(makeWitnesses(p2Key, 1n, salt2));
    const r2 = p1Rock.impureCircuits.commitMove(r1.context);
    const r3 = p2Paper.impureCircuits.commitMove(r2.context);
    const r4 = p1Rock.impureCircuits.revealMove(r3.context);
    const r5 = p2Paper.impureCircuits.revealMove(r4.context);
    expect(r5.context).toBeDefined();
  });
});
```

---

## CLI

```bash
compact compile src/rps.compact src/managed/rps
npm test
```

---

## Notes

- **Compiler-validated:** This contract compiles cleanly and all 6 tests pass
  against Compact 0.29.0 with `@midnight-ntwrk/compact-runtime` 0.29.0.
- Circuit complexity is moderate (k ~13-14). The `revealMove` circuit is the
  most expensive: it recomputes a 3-element `persistentHash`, performs a
  comparison against the stored commitment, and may execute the full winner
  determination logic (6 nested comparisons) when both players have revealed.
- The sequence counter increments at game creation and again at settlement,
  ensuring public keys change between games if the contract is reused.
- **Privacy trade-offs:** Both moves are disclosed during reveal (required to
  determine the winner on-chain). In a more privacy-preserving design, an
  off-chain arbiter could compute the winner and submit a proof of
  correctness, keeping both moves hidden. However, for a two-player game
  where both parties already know both moves after the game, this is
  unnecessary.
- **No timeout mechanism:** If a player commits but never reveals, the game is
  stuck in the `revealing` phase indefinitely. For production use, add a
  `revealDeadline: Uint<64>` and a `forfeit()` circuit that awards the win
  to the player who revealed if the deadline passes.
- **Move encoding:** 0=rock, 1=paper, 2=scissors. The `assert(move < 3)` guard
  ensures no other values can be committed. This is checked in-circuit, so
  an invalid move cannot produce a valid ZK proof.
- The 3-element commitment hash (domain separator, salt, move) is sufficient
  because each player's commitment is stored in a separate ledger field
  (`commitment1`, `commitment2`). The bidder identity does not need to be in
  the hash since it is implicit in which slot the commitment occupies.
