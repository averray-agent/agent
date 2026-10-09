# E1 — ERC-8004 read-only spike

Observed 2026-10-09, starting 21:24:03Z; repository base `1a925e41`.
No key was loaded, no transaction signed or broadcast, and no registry deployed.
This is the growth packet E1 memo, not permission to publish E3.

## Result and recommendation

Base has working identity, reputation and validation proxies at the checked
mainnet addresses. Hub returns empty code at all three. This establishes absence
at these addresses and blocks a canonical-address Hub writer; it is not a claim
that no unrelated registry exists anywhere on Hub.

Proceed with E2's **pure payload builder** and a Base-targeted integration design.
Keep E3 closed until the paying-consumer trigger, owner/operator consent, validator
identity and gas funding are approved. Do not turn Averray's reputation into
imported trust automatically. A Hub deployment is separate contract/governance
work, not part of a backend deploy. Never publish evidence based on
`chain_unavailable_fail_open` or the five pre-merged-only-rule payouts.

## Sources and address provenance

- [ERC-8004 draft specification](https://eips.ethereum.org/EIPS/eip-8004), validation request/response sections.
- Upstream revision `b9e466c250744a7e06b13dff9d3c2844ed64f825`:
  [address constants](https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c250744a7e06b13dff9d3c2844ed64f825/scripts/addresses.ts),
  [validation implementation](https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c250744a7e06b13dff9d3c2844ed64f825/contracts/ValidationRegistryUpgradeable.sol),
  [deployment README](https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c250744a7e06b13dff9d3c2844ed64f825/README.md).
- The README names Base identity/reputation but cautions that validation is under
  discussion. The mainnet validation address below comes from `MAINNET_ADDRESSES`,
  not from substituting the old testnet `0x8004Cb1B…` address.

| Registry | Mainnet address checked |
|---|---|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Validation | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` |

## Pinned chain observations

| Chain / eth_chainId | RPC | Block (hex) | Block hash |
|---|---|---|---|
| Hub 420420419 / `0x190f1b43` | `https://eth-rpc.polkadot.io/` | 21634282 (`0x14a1cea`) | `0x1aee266282e972b3eab760d46ca3cccf15950a77fc404e4c34f5a8d201fa3398` |
| Base 8453 / `0x2105` | `https://mainnet.base.org` | 52395838 (`0x31f7f3e`) | `0x6296d1f4193d77b0ab73b24118ea857c639f58c9acb5a7f73254fd9c592464bc` |

`eth_getCode(address, block)` returned `0x` for all three Hub addresses (0 bytes).
For all three Base addresses it returned the same 130-byte proxy runtime:

```text
0x60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545f9081906001600160a01b0316368280378136915af43d5f803e156048573d5ff35b3d5ffdfea2646970667358221220d25633e50c873a78e74176feb55eabe7e699db80eeb0380952dba33544b2c7f664736f6c63430008180033
```

Proxy code alone does not establish functionality. Reading EIP-1967 implementation
slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
and calling `getIdentityRegistry()` (`0xbc4d861b`) at the same Base block gave:

| Proxy | Implementation | getIdentityRegistry |
|---|---|---|
| Identity | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | reverts (not an Identity method) |
| Reputation | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` | mainnet Identity above |
| Validation | `0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99` | mainnet Identity above |

The historical/testnet candidate `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`
was also checked: Hub `0x`; Base 130-byte proxy but the binding call reverted.
Do not use that candidate simply because it has code. These reads do not attest
that deployed implementation bytecode exactly matches the upstream source revision.

## Interface, authority and evidence

```solidity
validationRequest(address validatorAddress, uint256 agentId,
                  string requestURI, bytes32 requestHash)
validationResponse(bytes32 requestHash, uint8 response,
                   string responseURI, bytes32 responseHash, string tag)
```

The request requires the agent NFT owner, token-approved address or operator.
Only its designated validator can respond; a generic Averray wallet cannot answer
someone else's request. Response is 0–100 and can be updated. Incentives and
slashing are not supplied by this registry. Identity is chain + registry + agentId,
not a wallet string alone. [Specification](https://eips.ethereum.org/EIPS/eip-8004).

For E2, keep the request payload commitment distinct from the receipt evidence
hash. Use the receipt content-addressing/canonical-bytes rule for evidence at
`https://api.averray.com/receipts/<id>`, not the unsigned presentation envelope or
the bytes of an HTML page. Explicitly specify the verdict→score mapping; an
inconclusive read is not a decisive success. No payload has been published here.

## Gas per write — estimates, not paid transactions

| Chain | validationRequest | validationResponse |
|---|---|---|
| Hub | unavailable: no code at canonical candidate | unavailable: no code |
| Base, pinned block | **217204 gas**, real state, agentId 1 | **133056 gas** (`0x207c0`), synthetic pending-request state override |

The Base request estimate used the observed `ownerOf(1)`
`0x89e9e1ab11dd1b138b1dce6d6a4a0926aafd5029`, designated validator
`0x1111111111111111111111111111111111111111`, and the 99-byte receipt URI in
the reproduction below. Merely naming that owner as `from` in eth_estimateGas
does not use its key or act on its behalf on chain.

`getAgentValidations(1)` was empty. A bounded 10,000-block event read returned
RPC `-32011: request limit reached`; no receipt gasUsed is claimed. The response
estimate therefore used a **temporary RPC-only storage override**, not a real
validation request: validator, agentId and lastUpdate populated in the mapping,
all other fields zero. It models a first response with a short tag, not an update
or large string. Storage warmth, URI/tag size and state change gas; Base L1 data
fees and ETH funding must be budgeted separately. An estimate to Hub's empty
address would measure an EOA call, not validation, so none is presented as such.

## Reproduce (read-only; Foundry cast + Node 22)

```sh
task_rpc=https://eth-rpc.polkadot.io/
task_block=21634282
cast chain-id --rpc-url "$task_rpc"
cast block --rpc-url "$task_rpc" "$task_block" --field hash
for task_address in 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58; do
  cast code --rpc-url "$task_rpc" --block "$task_block" "$task_address"
done
# Repeat the four reads with task_rpc=https://mainnet.base.org and task_block=52395838.
cast call --rpc-url https://mainnet.base.org --block 52395838 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58 'getIdentityRegistry()(address)'
cast estimate --rpc-url https://mainnet.base.org --block 52395838 --from 0x89e9e1ab11dd1b138b1dce6d6a4a0926aafd5029 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58 'validationRequest(address,uint256,string,bytes32)' 0x1111111111111111111111111111111111111111 1 https://api.averray.com/receipts/0xad7df64941a9e53e4813bef3f1d084b148f72b1801880ea72cb426e61a1d8e89 0xad7df64941a9e53e4813bef3f1d084b148f72b1801880ea72cb426e61a1d8e89
```

Save the following as a temporary `.mjs` and run with Node 22 to reproduce the
response simulation. Only `eth_estimateGas` is sent; no state change persists.

```js
import { execFileSync } from 'node:child_process';
const cast = (...args) => execFileSync('cast', args, {encoding:'utf8'}).trim();
const target = '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58';
const validator = '0x1111111111111111111111111111111111111111';
const hash = '0xad7df64941a9e53e4813bef3f1d084b148f72b1801880ea72cb426e61a1d8e89';
const slot = cast('index','bytes32',hash,'0x21543a2dd0df813994fbf82c69c61d1aafcdce183d68d2ef40068bdce1481100');
const word = (value) => '0x'+BigInt(value).toString(16).padStart(64,'0');
const stateDiff = {[slot]:word(validator),[word(BigInt(slot)+1n)]:word(1),[word(BigInt(slot)+5n)]:word('0x6ac95b5f')};
const data = cast('calldata','validationResponse(bytes32,uint8,string,bytes32,string)',hash,'100','https://api.averray.com/receipts/'+hash,hash,'averray');
const request = {jsonrpc:'2.0',id:1,method:'eth_estimateGas',params:[{from:validator,to:target,data},'0x31f7f3e',{[target]:{stateDiff}}]};
const response = await fetch('https://mainnet.base.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
console.log(await response.text());
```

Historical reads require an RPC retaining the pinned state. Treat an RPC error as
unavailable, not absence, zero gas, or an invitation to send a real transaction.
