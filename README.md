# corpus

Tokenized data assets with machine-verified appraisals, on X Layer.

Each vault is an ERC-721 representing one dataset epoch. An appraiser runs automated QA over the actual bytes (schema, row count, null rate, duplicate keys, type conformance, timestamp ordering, outlier scan), produces a signed report, and posts the verdict onchain. Purchases are hard-gated: no appraisal, or an appraisal in refusal state, means the license cannot be bought. Buyers pay in the native token for a time-boxed access license; revenue splits between the creator and the protocol treasury using pull payments.

The difference from stake-weighted curation (Ocean-style): the quality signal here is a machine audit of the data itself, not token-holder opinion. A corrupted epoch does not get a low score and stay purchasable — it gets refused, and the contract blocks the sale.

## Layout

```
contracts/CorpusVault.sol      ERC-721 vaults, appraisal registry, licensing, pull payments
contracts/ReentrantSink.sol    test-only attacker (reentrancy proof)
appraiser/appraise.js          QA engine: checks, score, refusal, EIP-191 signed report
appraiser/fixtures/            seeded synthetic epochs (one clean, one corrupted)
scripts/compile.js             solc-js (wasm), evmVersion paris, optimizer 200
deploy/deploy.js               deploy + grant APPRAISER_ROLE
deploy/mint.js                 hash the artifact, create the vault
deploy/post-appraisal.js       run QA, sign, post score/refusal onchain
deploy/finish-setup.js         idempotent post-deploy: waits out RPC lag, grants appraiser role
deploy/e2e-local.js            full-flow smoke against a throwaway anvil
test/corpus.test.js            21 tests: engine + contract, selector-exact reverts
```

## Chain config (verified from OKX docs, Aug 2026)

X Layer testnet "terigon": chainId 1952, RPC https://testrpc.xlayer.tech/terigon (also https://xlayertestrpc.okx.com/terigon). Faucet: https://web3.okx.com/xlayer/faucet
X Layer mainnet: chainId 196, RPC https://rpc.xlayer.tech (also https://xlayerrpc.okx.com)
Gas token is OKB on both. Public RPCs are rate-limited at 100 req/s per IP.

Do not use chain 195 configs still shown on ChainList and older guides — that testnet is deprecated.

Bytecode is compiled with evmVersion paris (no PUSH0, no Cancun opcodes) and OpenZeppelin pinned to 5.0.2, so it runs on zkEVMs regardless of their Shanghai/Cancun support. OZ 5.6.x emits mcopy and will not compile for this target.

## Quickstart

```
npm install
npm test          # compile + 21 tests on a local anvil
npm run e2e       # deploy -> mint -> appraise -> buy -> refusal gate, via the real CLIs
```

Tests require anvil on PATH (macOS/Linux: `curl -L https://foundry.paradigm.xyz | bash && foundryup`).

Deploy to testnet:

```
cp .env.example .env       # fill RPC_URL and PRIVATE_KEY (never commit .env)
set -a; . ./.env; set +a
npm run deploy             # prints CONTRACT=0x...  -> put it in .env
npm run finish             # grants APPRAISER_ROLE; safe to re-run
npm run mint -- appraiser/fixtures/manifest_good.json 0.05 7 https://your.host/manifest_good.json
npm run post -- 1 appraiser/fixtures/manifest_good.json
```

Prices are quoted in native-token units (18 decimals). The same commands with RPC_URL=https://rpc.xlayer.tech deploy to mainnet.

## Contract invariants (all tested)

Purchases revert NotAppraised before any appraisal exists, and AppraisalRefused while a refusal stands. Exact payment is enforced. Revenue is credited to pull balances (95/5 default, fee capped at 20%), never pushed — a malicious creator contract cannot grief buyers or re-enter withdraw. Licenses are time-boxed and stack: re-purchase extends from the later of now and the current expiry. NFT transfer moves listing control and future revenue to the new owner. Appraisals can only be posted by APPRAISER_ROLE and are timestamped onchain.

## Appraiser

Verdicts are computed by code, never by a model. Hard failures (unparseable, schema mismatch, row count below minimum) set refusal and score 0. Soft findings (nulls, duplicates, type violations, ordering breaks) lower the score. The full report is hashed (sha256) and signed (EIP-191); the hash and score go onchain, so anyone holding the report can verify it matches what the appraiser committed to.

An LLM can be plugged in to write the narrative section of the report; it never decides the verdict.

## Known limitations (v1)

The appraiser is a centralized service holding APPRAISER_ROLE. The path out is a challenge mechanism: stake-backed re-appraisals with slashing on divergence. Delivery is raw licensed download verified by content hash — no compute-to-data, so privacy-sensitive datasets are out of scope for v1. No sub-license token economics.

## RPC lag

Public X Layer RPCs are load-balanced. A read issued immediately after a deploy can hit a replica that has not indexed the block yet and comes back as empty data ("could not decode result data") even though the deploy receipt succeeded. `npm run deploy` polls until the endpoint serves the contract code; if it never does, it prints the address and tells you to run `npm run finish` later. `finish-setup.js` is idempotent, retries reads, falls back to `RPC_URL_ALT`, and falls back to the computed keccak256("APPRAISER_ROLE") constant if the getter itself will not read. Nothing is lost by a lagged deploy.

## Engineering notes

ethers v6 caches identical JSON-RPC payloads for 250 ms by default (cacheTimeout). Against an instant-mining node this serves stale nonces, balances, and revert answers. Every provider in this repo sets cacheTimeout: -1. Test revert assertions additionally go through raw eth_call at an explicit latest tag and match the 4-byte custom-error selector.

MIT
