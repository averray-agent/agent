# Block 20570285 hash lookup hole

Raw public JSON-RPC responses captured on 2026-09-12 at 18:11 UTC.

- DWELLER: https://services.polkadothub-rpc.com/mainnet/
- eth-rpc: https://eth-rpc.polkadot.io/
- Block: 20570285 (`0x139e0ad`)
- Hash: `0x708e5e567d9df22a421a02ccd7dd9e7d6345f6848126fdd409facf2138ba8a86`

Both files preserve the response to a POST with Content-Type application/json:

```json
{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByHash","params":["0x708e5e567d9df22a421a02ccd7dd9e7d6345f6848126fdd409facf2138ba8a86",false]}
```

DWELLER returns null. eth-rpc returns the block, with zero gasUsed, zero bloom
and an empty transaction list: a valid empty block, not a completeness-guard
failure. A separate live by-number check confirmed DWELLER returns this same
block by number. Ponder's parent walk uses the hash lookup with fullTx=false.

These are captured responses, not reconstructed headers. Tests label synthetic
number/fullTx/error variants separately; the captured block has no transactions,
so its transaction representation is the same in either fullTx mode.
