# Reviewed signer asset return

`return-signer-asset.mjs` is dry-run by default and uses KMS only. Its only
write is one ERC20 `transfer` to the destination in the committed
`deployments/signer-asset-returns.mainnet.json`. It cannot deposit, approve,
move native DOT, or target USDC or any deployment contract.

The checked-in destination is deliberately a placeholder. Both modes refuse
it before RPC/AWS access. Pascal must supply his EVM H160, commit it through
review, and obtain Claude's gate before this PR merges. Do not substitute an
SS58 address or guess its H160 mapping. When replacing the placeholder,
update the placeholder-specific CLI test to validate the reviewed manifest;
keep a separate invalid-placeholder fixture and all protected-address tests.

After the reviewed revision is deployed, use **Hosted Signer Asset Return**
on main. Inputs are only `key`, `amount_raw`, `commit`, `expected_plan_hash`,
and `confirm`. The workflow uses the deployed checkout, production backend
image, Roles Anywhere profile, and shared `production-signer-5a6836` queue.
It does not deploy code. No new runtime environment variables or secrets
are required; the existing production KMS and SSH configuration is reused.

1. Dry run `usdt-2026-11`, amount `10000`, commit false (0.01 USDt).
2. Review the asset, live symbol/decimals, destination, calldata, balances,
   estimated gas cost and SHA-256 plan hash in the evidence log with Claude.
3. Commit the same key/amount with the exact hash and `RETURN ` followed by
   the first 12 hex characters of that hash. The script recomputes the plan.
4. Pascal confirms 0.01 USDt appears in his wallet app before returning the
   rest with a new dry run, reviewed hash and confirmation.

The hash is SHA-256 of the UTF-8 JSON array
`[chainIdString, signerLowercase, assetLowercase, destinationLowercase, amountDecimalString, calldata]`.
The gas floor is fixed at 2 DOT, using the EVM RPC's 18-decimal units. Gas is
estimated and sent with the same legacy gas price and gas limit. Fresh token
and native balances are checked immediately before signing. Receipt-block
balances must show exactly the requested sender decrease and recipient
increase. Both before/after balances and the transaction hash are logged.

A timeout, failed receipt, or balance delta mismatch exits nonzero. There is
no automatic transaction retry. Inspect the printed transaction hash and
chain balances before any new run; a post-check failure can follow a mined
transfer. The workflow captures stderr and stdout, preserves the failure
exit code, and uploads its evidence log even on failure.

The allowance is a per-invocation maximum, not a persistent lifetime limit.
Workflow serialization covers other workflows in the signer queue; the
running backend can still spend gas or receive assets concurrently. The
fresh floor check and strict post-check detect insufficient gas headroom or
unexpected balance changes; neither is an exclusive lock on the wallet.
