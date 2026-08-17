# Native Shielded Token — and the coin info you must not lose

> **Compiler-validated:** compiles (2 circuits) against Compact **0.31.1**, `compact` CLI 0.5.1,
> using OpenZeppelin `NativeShieldedTokenCore` (v0.3.0-alpha.2).

Native shielded tokens are Midnight's contract-issued private tokens. This example issues
loyalty points — but the token is not the lesson. The lesson is a failure mode that destroys
value silently and permanently, and that nothing in the type system warns you about.

## ⚠ The hazard: contract-minted coins are invisible to wallets

From OpenZeppelin's own source:

> *"Contract-initiated sends do not create coin ciphertexts, so recipient wallets cannot detect
> coins minted or refunded to them by scanning the chain. The returned `ShieldedCoinInfo` values
> are the only copies of those coins' info: DApps SHOULD capture and deliver them out of band;
> dropping them strands value irrecoverably."*

Read that again, because it inverts an assumption most blockchain developers hold:

- A normal wallet finds your coins by **scanning the chain** for ciphertexts addressed to you.
- A **contract**-minted coin creates **no ciphertext**. There is nothing on-chain for the wallet
  to find.
- The `ShieldedCoinInfo` returned by the mint circuit is the **only** record.

**If your DApp does not capture that return value and deliver it to the recipient, the coins are
gone.** Not stuck — gone. There is no rescan, no recovery from the seed phrase, no support
ticket. The recipient's wallet has no way of knowing the coins ever existed.

This is not a bug. It is the cost of the privacy model: no ciphertext means no on-chain trace,
which is the point. But it moves a hard durability requirement into **your application code**.

## Contract

```compact
pragma language_version >= 0.23.0;

import CompactStandardLibrary;
import "./token/NativeShieldedTokenCore" prefix Token_;

export ledger issuer: Either<ZswapCoinPublicKey, ContractAddress>;
export ledger totalIssued: Counter;
export ledger domainId: Bytes<32>;

constructor(
  _issuer: Either<ZswapCoinPublicKey, ContractAddress>,
  _domain: Bytes<32>,
  _name: Opaque<"string">,
  _symbol: Opaque<"string">
) {
  issuer = disclose(_issuer);
  domainId = disclose(_domain);
  Token_initialize(_name, _symbol, 2 as Uint<8>);
}

// Returns the coin info. The caller MUST persist and deliver this to the
// recipient out of band. A DApp that drops this value has destroyed the
// points it just issued.
export circuit issuePoints(
  recipient: Either<ZswapCoinPublicKey, ContractAddress>,
  amount: Uint<64>,
  nonce: Bytes<32>
): ShieldedCoinInfo {
  const caller = ownPublicKey();
  assert(issuer.is_left && caller == issuer.left, "loyalty: only the issuer may mint");
  totalIssued.increment(1);
  return Token__mint(domainId, recipient, amount, nonce);
}

export circuit pointsName(): Opaque<"string"> {
  return Token_name();
}
```

## Handling the returned coin info

The circuit's return value is the whole ballgame. Treat it like key material with a delivery
receipt, not like a transaction result you log and forget.

```typescript
const coinInfo = await contract.callTx.issuePoints(recipient, 500n, nonce);

// 1. PERSIST FIRST, before anything can fail. If the process dies between the
//    mint and the write, the coins are unrecoverable.
await db.coinInfo.insert({ recipient, coinInfo, delivered: false });

// 2. Deliver out of band -- encrypted message, authenticated download, QR.
await deliverToRecipient(recipient, coinInfo);
await db.coinInfo.update({ recipient, delivered: true });
```

**Design rules that follow from the hazard:**

- **Persist before you deliver.** A crash after minting and before writing is total loss.
- **Make delivery idempotent and retryable.** The recipient may be offline for days; the coin
  info stays valid, so keep re-trying rather than dropping it.
- **Do not put it only in a log line.** Logs rotate. This is durable state.
- **Never mint in a fire-and-forget handler.** No `await`, no capture, no coins.
- **Back it up like a secret**, because functionally it is one: whoever holds it can spend the
  coin, and nobody else can ever reconstruct it.

## Nonce discipline

`_mint` takes a caller-supplied nonce and OpenZeppelin is explicit that uniqueness is entirely
your problem:

> *"The caller is fully responsible for nonce uniqueness. Reusing a nonce for the same
> (domain, value, recipient) produces a duplicate commitment, which the protocol rejects."*

So a naive retry — same recipient, same amount, same nonce — is rejected by the protocol. That
is the protocol protecting you from a double-mint, but it means **retry logic must generate a
fresh nonce**, and must not treat rejection as "the mint failed, try again identically".

## Compile gotchas hit while writing this

Four errors, all from writing plausible-looking Compact. Each cost a compile cycle:

| what I wrote | error | correct form |
|---|---|---|
| `Token_._mint(...)` | `unbound identifier Token_` | `Token__mint(...)` — the prefix is **concatenated**, not dotted |
| `caller()` | `unbound identifier caller` | `ownPublicKey()` |
| `"Loyalty Points"` as an `Opaque<"string">` arg | `supplied (Bytes<14>) / declared (Opaque<"string">)` | take it as a **constructor parameter** from TypeScript |
| `"Loyalty Points" as Opaque<"string">` | `cannot cast from Bytes<14> to Opaque<"string">` | there is **no cast** — `Opaque` values only come in from outside |

⚠ The last two are worth internalising: **`Opaque<"string">` cannot be constructed inside
Compact at all.** A string literal is `Bytes<N>` and no cast bridges them. Every name, symbol or
description must arrive as a parameter. OpenZeppelin's own mocks do exactly this.

## Related

- [Token Minting](token-minting.md) — Zswap coin creation basics
- [Fungible Token](fungible-token.md) — the non-native OZ fungible pattern
- [Token Swap](token-swap.md) — `receiveShielded` / `sendImmediateShielded`

⚠ **Before deploying anything derived from this**, read the Compact 0.31.0 soundness advisory in
`SKILL.md`. Token contracts are precisely the case it targets — a dropped range constraint on a
balance is the worst version of that bug.
