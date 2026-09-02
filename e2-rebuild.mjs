import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex, blake2AsHex } from '@polkadot/util-crypto';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);
const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY) + pad(10_050_000n) + pad(10_000_000n) + pad(10_000_000n) + pad(40_000n) + pad(1786193710n) + pad(2n);
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const tx = api.tx.revive.call(ADAPTER, 0, { refTime: 14_200_000_000n, proofSize: 1_800_000n }, 30_000_000_000n, STAGE);
const hex = tx.method.toHex();
console.log('CEREMONY E2 (v2) — STAGE 10-USDC EPOCH, quote x2 (refTime 14.2e9, proofSize 1.8M):');
console.log(hex);
console.log('hash:', blake2AsHex(hex, 256), `(len ${(hex.length - 2) / 2} bytes)`);
await api.disconnect(); process.exit(0);
