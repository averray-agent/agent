# RUNSHEET — collect idle funds into the reward bank

Status: written 2026-09-21 from the 2026-09-20 sweep.
"The bank" = the operator reward bank = the KMS signer's AgentAccountCore USDC
position (`0x5a6836c6D4d293F6E5377E6c28054F4171915813`, liquid 16.075 at the sweep).
Executor: Pascal (keys). Claude verifies every landing from chain. **Do not run
any KMS-signed step while the cycle-2 recall or a deploy is in flight.**

| # | source | amount | mechanism | key | when |
|---|---|---|---|---|---|
| 1 | self wallet `0x42a4b8663b8Cf5111898C8BE4bA75a010B0F0ABd` (AAC liquid) | 25.00 USDC | one `sendToAgent` inside the account core (no withdraw, no ERC-20 transfer) | that wallet's key | any time |
| 2 | Base Verify payTo `0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f` | 11.05 USDC | Base → Coinbase → Asset Hub USDC to the signer's SS58, then `fund-signer-usdc-deposit.mjs` inside the container | payTo key + Coinbase | any time; last leg after the recall settles |
| 3 | legacy escrow v2 stale jobs (6 × 0.4 Claimed-never-submitted + 1 × 1.05 Open by our cold wallet `0xA287a52b…`) | 3.45 USDC | `handleClaimTimeout` on the six, then operator rescue with tombstone (`scripts/ops/rescue-open-job.mjs`); the 1.05 refunds to the cold wallet's AAC, then the step-1 mechanism from the cold wallet | admin EOA (op) / cold wallet | after the recall; separate mini-runsheet with the seven job ids |
| 4 | tester `0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c` (legacy pool v2, 5.026011 shares) | 4.96 USDC | `requestRedeem` (7-day notice) → `fulfilRedeem` → USDC in the wallet → ERC-20 transfer to the signer → fund-signer | tester key — **only if it is ours** | decision first |
| — | CreditBook `0x70441c91…` seed | 10.00 USDC | **not movable**: the contract has `seed()` and no withdrawal; the 10 USDC sits in the book's own AAC position and only a contract upgrade could release it | — | correction to the sweep |
| — | signer reserved gap | 5.6 USDC | reservations matching no live job on v3/v2 — reconcile before touching | — | ops packet |

## Step 1 — self wallet → bank (one transaction)

Script `docs/evidence/scripts/aac-send-to-bank.mjs` (dry run by default; `op read`
in your shell on `--commit`; refuses if the key does not resolve to
`--expected-wallet`, if the account has debt, or if the amount exceeds liquid).
Dry run 2026-09-21: simulated OK, gas 2973, the wallet holds 0.97 DOT.

If the key is in 1Password:

```bash
cd /Users/pascalkuriger/repo/Polkadot/.claude/worktrees/nervous-curie-8045a3 && node .scratch/aac-send-to-bank.mjs --expected-wallet 0x42a4b8663b8Cf5111898C8BE4bA75a010B0F0ABd --signer-secret-ref 'op://<vault>/<item>/<field>' --commit
```

If the key lives in MetaMask/Talisman: send a contract interaction to
`0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57`, value 0, with the calldata the
dry run prints (`sendToAgent(0x5a6836…5813, USDC, 25000000)`).
Expected: bank liquid 16.075 → 41.075.

## Step 2 — Base revenue home

1. From the payTo wallet on Base, send 11.05 USDC to your Coinbase Base-USDC deposit address.
2. Coinbase → withdraw USDC on network "Polkadot" (= Asset Hub) to the signer's SS58
   `133YGXLeo4Rf2aWc7JXUbq7rmDnTrFp7tLj7Q9xdCt4bcYcg` (proven route). It lands as USDC in the signer's EOA.
3. Inside the container, after the recall has settled — dry run, then `--commit`:

```bash
docker exec agent-mainnet-backend node scripts/ops/fund-signer-usdc-deposit.mjs --profile mainnet --amount 11050000 --use-kms
```

Expected: bank liquid +11.05. If you want to keep a Base float for refunds, name the amount.

## Step 3 — legacy v2 stale jobs (after the recall)

Seven chain job ids on `0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC`: Open 1.05
`0x158d074f71…` (poster = cold wallet); Claimed 0.4 × 6 `0xef36549595…`,
`0x5b7931881d…`, `0xa42ebcba24…`, `0x1cd5e39d94…`, `0xb569ef0d07…`,
`0x19d2ce7878…` (claimed before the 2026-08-13 cutover; TTLs long expired).
Per job: `handleClaimTimeout` → Open → `rescue-open-job.mjs` (min open age 1 h,
tombstone metadata, reason `OPERATOR_RESCUE`) → funds return to the poster's
AAC position (the signer for six, the cold wallet for one). Claude writes the
exact command list with dry runs once step 1 has landed; it needs the admin EOA
via `op` on your Mac.

## Not in this runsheet

The treasury multisig (3.475 AAC + 2.43 USDC + 5.94 DOT) is the treasury, not the
bank. The 18.30 USDC in 183 pre-08-16 canary wallets is unrecoverable. DOT postage
on adapters stays.

## Handback per step

Tx hash + block; Claude reads `positions(bank)` after each and records the running total here.
