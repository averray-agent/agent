# CreditBook AAC-liquidity regression

Pinned 2026-08-20 subjects:

- Hub EVM chain: `420420419`
- block: `19684700` (`0x12c5d5c`)
- abandoned CreditBook: `0xdB7bF8caB8160d33b3B0943F9d671C207DD46d60`
- operator: `0x5a6836c6D4d293F6E5377E6c28054F4171915813`
- AgentAccountCore: `0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57`
- Hub USDC: `0x0000053900000000000000000000000001200000`

A read-only `eth_call` of `seed(10_000_000)` from the operator at the pinned
block reverts with `0x90b8ec18`, `SafeTransfer.TransferFailed()`. The old
instance has zero accounted liquidity, zero outstanding principal, and zero
AAC liquidity; it is inert and is not a migration source.

The reported internal contract-call observation was `approve(AAC, 0) ->
false` when the book had no approval. A direct top-level `eth_call` with
`from=book` returned `true` during this implementation, so it is not treated as
equivalent evidence: it does not execute the precompile through deployed EVM
contract code. Hub USDC is a native runtime precompile and Anvil cannot execute
it statefully. `CreditBookForkTest` therefore makes the boundary explicit:

- the external Anvil fork supplies real deployed TreasuryPolicy and
  AgentAccountCore code/storage;
- a test double at the production USDC address pins the observed
  `approve(0) -> false` contract-call behavior;
- the green path never invokes that approval and uses only AAC `deposit`,
  `sendToAgent`, and the book's reconciliation;
- restoring the old raw-token seed makes the named full-loop test fail with
  `TransferFailed()`.

Run the fork drill against the same pinned state:

```sh
anvil --fork-url https://services.polkadothub-rpc.com/mainnet/ \
  --fork-block-number 19684700 --chain-id 31337 --port 8547

MAINNET_RPC_URL=http://127.0.0.1:8547 \
  forge test --match-contract CreditBookForkTest -vv
```

The fork test refuses any RPC whose reported chain id is not `31337`, so a
developer cannot accidentally point a mutation drill directly at mainnet.
