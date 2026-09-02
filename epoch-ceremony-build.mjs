import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex, blake2AsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);
const APPROVE = sel('approve(address,uint256)') + padAddr(ADAPTER) + pad(10_050_000n);
const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY) + pad(10_050_000n) + pad(10_000_000n) + pad(10_000_000n) + pad(40_000n) + pad(1786193710n) + pad(2n);
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const build = (label, to, data, ref, proof, sd) => {
  const tx = api.tx.revive.call(to, 0, { refTime: ref, proofSize: proof }, sd, data);
  const hex = tx.method.toHex();
  console.log(`${label}:\n${hex}\nhash: ${blake2AsHex(hex, 256)}  (len ${(hex.length - 2) / 2} bytes)\n`);
};
build('CEREMONY E1 — APPROVE 10.05 USDC to adapter', USDC, APPROVE, 1_000_000_000n, 120_000n, 1_000_000_000n);
build('CEREMONY E2 — STAGE 10-USDC EPOCH (deadline 2026-08-08T12:55:10Z, nonce 2)', ADAPTER, STAGE, 8_000_000_000n, 800_000n, 30_000_000_000n);
await api.disconnect(); process.exit(0);
