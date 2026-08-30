import { describe, it, expect, beforeEach } from "vitest";
import { Contract } from "../../../artifacts/MockOwnablePausableFT/contract/index.js";
import {
  CompactTypeBytes,
  CompactTypeVector,
  createConstructorContext,
  createCircuitContext,
  persistentHash,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import * as utils from "#test-utils/fixtures/address.js";
import { OwnableWitnesses } from "../../access/test/witnesses/OwnableWitnesses.js";
import { FungibleTokenWitnesses } from "./witnesses/FungibleTokenWitnesses.js";

// Both Ownable and FungibleToken identify parties by ACCOUNT ID:
// Either<Bytes<32>, ContractAddress> where the Bytes<32> is persistentHash(secretKey).
// Ownable authenticates the caller by having them prove knowledge of that key through
// the wit_OwnableSK witness, which reads it from private state.
const createTestSK = (label: string): Uint8Array => {
  const sk = new Uint8Array(32);
  sk.set(new TextEncoder().encode(label).slice(0, 32));
  return sk;
};

const buildAccountIdHash = (sk: Uint8Array): Uint8Array => {
  const rt_type = new CompactTypeVector(1, new CompactTypeBytes(32));
  return persistentHash(rt_type, [sk]);
};

const zeroBytes = utils.zeroUint8Array();
const eitherAccount = (accountId: Uint8Array) => ({
  is_left: true,
  left: accountId,
  right: { bytes: zeroBytes },
});

const OWNER_SK = createTestSK("OWNER");
const ownerEither = eitherAccount(buildAccountIdHash(OWNER_SK));
const recipientEither = eitherAccount(buildAccountIdHash(createTestSK("RECIPIENT")));

// zswap-level caller identity for the transaction context — distinct from contract ownership
const [, coinKeyEither] = utils.generateEitherPubKeyPair("OWNER");

// BOTH modules declare a witness (wit_OwnableSK, wit_FungibleTokenSK) and both read
// privateState.secretKey, so one secret key serves both identities.
const witnesses = { ...OwnableWitnesses(), ...FungibleTokenWitnesses() };

const INITIAL_SUPPLY = 1_000_000n;
const DECIMALS = 18n;

describe("OwnablePausableFungibleToken", () => {
  let contract: Contract;
  let ctx: any;

  beforeEach(() => {
    contract = new Contract(witnesses);
    const addr = sampleContractAddress();

    const initial = contract.initialState(
      // private state carries the secret key wit_OwnableSK returns
      createConstructorContext({ secretKey: OWNER_SK }, coinKeyEither.left),
      ownerEither,
      "TestToken",
      "TT",
      DECIMALS,
      INITIAL_SUPPLY,
    );

    ctx = createCircuitContext(
      addr,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  });

  it("should deploy with initial supply", () => {
    const result = contract.impureCircuits.totalSupply(ctx);
    expect(result.result).toBe(INITIAL_SUPPLY);
  });

  it("should show owner balance equals initial supply", () => {
    const result = contract.impureCircuits.balanceOf(ctx, ownerEither);
    expect(result.result).toBe(INITIAL_SUPPLY);
  });

  it("should transfer tokens", () => {
    const r1 = contract.impureCircuits.transfer(ctx, recipientEither, 1000n);
    expect(r1.result).toBe(true);
    const r2 = contract.impureCircuits.balanceOf(r1.context, recipientEither);
    expect(r2.result).toBe(1000n);
  });

  it("should allow owner to mint", () => {
    const r1 = contract.impureCircuits.mint(ctx, recipientEither, 500n);
    const r2 = contract.impureCircuits.totalSupply(r1.context);
    expect(r2.result).toBe(INITIAL_SUPPLY + 500n);
  });

  it("should allow owner to pause and block transfers", () => {
    const r1 = contract.impureCircuits.pause(ctx);
    expect(() => {
      contract.impureCircuits.transfer(r1.context, recipientEither, 100n);
    }).toThrow("Pausable: paused");
  });

  it("should allow owner to unpause and resume transfers", () => {
    const r1 = contract.impureCircuits.pause(ctx);
    const r2 = contract.impureCircuits.unpause(r1.context);
    const r3 = contract.impureCircuits.transfer(r2.context, recipientEither, 100n);
    expect(r3.result).toBe(true);
  });
});
