# Packet: return a stray non-USDC asset from the backend signer

**DIRECTIVE (implementer: Codex):** build this in `averray-agent/agent` as
**one PR** from a fresh worktree off `origin/main`. Do not review or
summarise the packet; implement it. Claude gates it before merge. Each guard
under "Acceptance" needs a test that goes RED when the guard is removed.

- **Approval:** Pascal approved this on 2026-11-09.
- **Not urgent:** nothing is at risk while the asset sits in the signer
  wallet.

## Why

- **What happened.** On 2026-11-09 Pascal sent **13 USDt** (Asset Hub asset
  1984, precompile `0x000007C000000000000000000000000001200000`, 6
  decimals) to the backend signer `0x5a6836c6D4d293F6E5377E6c28054F4171915813`
  (SS58 `133YGX…bcYcg`), meaning to top up the reward bank.
- **Why it's stuck.** The bank and every reward are USDC (asset 1337).
  - `fund-signer-usdc-deposit.mjs` only handles USDC.
  - The signer key lives in AWS KMS.
  - No existing tool can move any other asset out of that wallet.
- **Verified on chain** (`balanceOf`, 2026-11-09): USDt 13.000000, USDC
  0.170000.

## Behaviour

### 1. An allow-list, committed and reviewed

Add `deployments/signer-asset-returns.mainnet.json`:

```json
{
  "schemaVersion": "averray.signer-asset-returns.v1",
  "signer": "0x5a6836c6D4d293F6E5377E6c28054F4171915813",
  "returns": [
    {
      "key": "usdt-2026-11",
      "asset": "0x000007C000000000000000000000000001200000",
      "symbol": "USDt",
      "decimals": 6,
      "destination": "0xe30478EB20E5380849e96E0f1002821dacF339e5",
      "maxRaw": "13000000",
      "reason": "USDt sent to the signer by mistake on 2026-11-09",
      "approvedBy": "Pascal",
      "approvedAt": "2026-11-09"
    }
  ]
}
```

- **The destination is never a workflow input.** It comes only from this
  committed file, so changing it needs a reviewed PR.
- **Refuse at load:**
  - an entry whose `asset` is the bank's USDC token (from
    `deployments/mainnet.json` `token`) or native DOT. USDC only ever moves
    through the deposit path;
  - a destination equal to the signer, the zero address, or any address in
    `deployments/mainnet.json`;
  - a `signer` that doesn't match `deployments/mainnet.json` `verifier`.
- **Destination (supplied 2026-11-09):** Pascal gave the SS58 account
  `121pEreu4kTNBiyG7K32Red672dgMhkra7cLTNwK8ebEYhyv` (AccountId32
  `0x2cdb40f6…ab7e`, not eth-derived). Its revive H160 is
  `keccak256(AccountId32)[12..]` = `0xe30478EB20E5380849e96E0f1002821dacF339e5`.
  On chain (eth-rpc, 2026-11-09) that H160 reports nonce 200, 6.67 DOT and
  0.613916 USDC, so it resolves to Pascal's live, mapped account, not to an
  empty 0xEE fallback. The 0.01 USDt test transfer below is still required.
### 2. A script: `scripts/ops/return-signer-asset.mjs`

Mirror `fund-signer-usdc-deposit.mjs`: the same RPC selection, chain-id
check, `--profile mainnet` required, `--use-kms`, and `--expected-signer`.

- **Inputs:**
  - `--key <entry key>`;
  - `--amount <raw>`: must be ≤ `maxRaw` and ≤ the live balance;
  - `--commit`; without it, the run is a dry run.
- **The dry run prints:**
  - the asset, `symbol()` and `decimals()` read from chain. Refuse if they
    don't match the entry;
  - the live balance;
  - the destination and the amount;
  - the encoded `transfer(address,uint256)` calldata;
  - the signer's native DOT;
  - a **plan hash**: SHA-256 over chain id, signer, asset, destination,
    amount and calldata.
- **`--commit` requires:**
  - `--expected-plan-hash <hash>` equal to a fresh recomputation;
  - `--confirm "RETURN <first 12 hex of hash>"`.

  Re-read the balance immediately before sending. Send **one** transfer. Wait
  for the receipt. Assert that the signer's balance dropped by exactly
  `amount` and the destination's rose by exactly `amount`. Print both.
- **Gas.** Refuse if the signer's native balance minus the estimated cost is
  below **2 DOT** (the same floor as `RESERVE_SWEEP_MIN_SIGNER_NATIVE_DOT`).
- **Never touch** USDC, AgentAccountCore or EscrowCore.

### 3. A workflow: `.github/workflows/hosted-signer-asset-return.yml`

Copy the shape of `hosted-signer-liquidity-funding.yml`:
`workflow_dispatch`, `environment: production`, the same concurrency group
`production-signer-5a6836`, and the same SSH and `docker compose run` of
`mainnet-backend` with Roles Anywhere.

- **Inputs:** `key`, `amount_raw`, `commit` (default false),
  `expected_plan_hash` and `confirm`.
- **No destination input.**
- **Evidence.** Upload the log as evidence, like the funding workflow.

## Name the consumers

List in the PR body:
- every workflow sharing the `production-signer-5a6836` concurrency group;
- the env-template checks;
- `check-hosted-stack.sh`, if it inventories ops workflows;
- any test that pins the list of workflows or of files under
  `deployments/`.

## Acceptance (each RED when its guard is removed)

- **The allow-list refuses:**
  - an entry with the USDC token;
  - a destination equal to the signer, zero, or any deployment address;
  - a signer mismatch.
- **Amounts:** `--amount` above `maxRaw` or above the live balance is
  refused.
- **The asset must match:** a mismatched `symbol()` or `decimals()` on
  chain is refused.
- **Commit guards:** `--commit` without the plan hash, with a stale hash, or
  with a wrong `--confirm` is refused **before** any KMS signing call (use a
  counting signer mock).
- **Gas floor:** a signer below 2 DOT after the estimated cost means zero
  sends.
- **Dry run:** sends nothing.
- **Exactly one transfer:** commit sends exactly one transaction, with the
  calldata from the dry run.
- **Post-check:** a balance delta that differs from `amount` makes the run
  exit non-zero.
- **The workflow file:** it has no input or env that sets the destination
  (a static test over the YAML).

## After merge (operator)

1. **Prove the destination with a small test.** Run the workflow dry run
   with `amount_raw=10000` (0.01 USDt). Claude checks the plan hash. Then
   commit. Pascal confirms that **0.01 USDt shows up in the destination
   wallet's app**, which proves the H160 is really his (see
   `reference_hub_address_forms`: the 0xEE-padded mapping).
2. **Then the rest:** run it again with the remaining balance (dry run,
   Claude-gated hash, commit).
3. **Pascal swaps** USDt to USDC in his own wallet, if he wants to, and
   sends USDC to the signer for the normal deposit path.
