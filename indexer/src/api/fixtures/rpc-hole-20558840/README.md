# Block 20558840 RPC hole

Raw public JSON-RPC responses captured on 2026-09-12; capture completed at 16:30:55 UTC.

- DWELLER: https://services.polkadothub-rpc.com/mainnet/
- eth-rpc: https://eth-rpc.polkadot.io/
- Block: 20558840 (`0x139b3f8`)
- Hash: `0xbe401358142dd085fd67be24e1fb33494875f2a042239c72f8ce48e94ddff259`

Requests (POST, application/json):

- `eth_getBlockByNumber(["0x139b3f8", true])`: files ending in `block-full.json`.
- `eth_getBlockByHash([hash above, true])`: files ending in `block-by-hash.json`.
- `eth_getLogs([{ "fromBlock": "0x139b3f8", "toBlock": "0x139b3f8" }])`: files ending in `logs.json`; no address/topic filter.

Both numbered responses have zero gasUsed and the same non-zero logsBloom.
DWELLER returns no transactions and no logs; its hash-addressed block is null.
eth-rpc returns one transaction at index 3 and one log at index 11. That transaction's
original index must not be changed to its position (0) in the returned array.

These fixtures are captured provider responses, not reconstructed block headers.
Tests explicitly label synthetic variants used to exercise additional subset/conflict cases.
