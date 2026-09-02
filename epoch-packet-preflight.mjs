import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex, blake2AsHex } from '@polkadot/util-crypto';

const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const WRAPPER = '0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc';
const TREASURY_H160 = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const MULTISIG = '0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47';
const STRATEGY_ID = '0x' + Buffer.from('HYDRATION_USDC_V1').toString('hex').padEnd(64, '0');

const GROSS = 10_050_000n, SELL = 10_000_000n, MIN_SHARES = 10_000_000n, MAX_FEE = 40_000n, NONCE = 2n;
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 48 * 3600);
console.log('deadline:', DEADLINE.toString(), '=', new Date(Number(DEADLINE) * 1000).toISOString());

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);

const APPROVE = sel('approve(address,uint256)') + padAddr(ADAPTER) + pad(GROSS);
const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY_H160) + pad(GROSS) + pad(SELL) + pad(MIN_SHARES) + pad(MAX_FEE) + pad(DEADLINE) + pad(NONCE);
console.log('approve selector ok:', APPROVE.startsWith('0x095ea7b3'), '| stage selector ok:', STAGE.startsWith('0x9af30c6c'));

// previewRequestId((bytes32,uint8,address,address,address,uint256,uint256,uint64))
const PREVIEW_SEL = sel('previewRequestId((bytes32,uint8,address,address,address,uint256,uint256,uint64))');
const ctx = (assets, nonce) => PREVIEW_SEL + STRATEGY_ID.slice(2) + pad(0) + padAddr(TREASURY_H160)
  + padAddr(USDC) + padAddr(TREASURY_H160) + pad(assets) + pad(0) + pad(nonce);
const ethCall = async (to, data) => {
  for (const url of ['https://services.polkadothub-rpc.com/mainnet', 'https://eth-rpc.polkadot.io']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
      const j = await r.json(); if (j.result) return j.result;
    } catch {}
  }
  return 'FAIL';
};
const dustId = await ethCall(WRAPPER, ctx(150_000n, 1n));
console.log('encoding self-check (dust ctx) :', dustId, dustId === '0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac' ? 'PASS == known dust requestId' : 'FAIL');
const epochId = await ethCall(WRAPPER, ctx(GROSS, NONCE));
console.log('EPOCH requestId (nonce 2)      :', epochId);

// allowance + treasury balance now
const allowance = await ethCall(USDC, sel('allowance(address,address)') + padAddr(TREASURY_H160) + padAddr(ADAPTER));
console.log('current allowance treasury->adapter:', BigInt(allowance).toString());
const bal = await ethCall(USDC, sel('balanceOf(address)') + padAddr(TREASURY_H160));
console.log('treasury USDC balance          :', BigInt(bal).toString(), '(expect 10928804)');

// Build ceremony batch + dry-run it as the multisig
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const c1 = api.tx.revive.call(USDC, 0, { refTime: 1_000_000_000n, proofSize: 120_000n }, 10_000_000_000n, APPROVE);
const c2 = api.tx.revive.call(ADAPTER, 0, { refTime: 4_000_000_000n, proofSize: 400_000n }, 10_000_000_000n, STAGE);
const batch = api.tx.utility.batchAll([c1, c2]);
const hex = batch.method.toHex();

let dry;
try { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method, 5); }
catch { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method); }
const j = dry.toJSON();
const ok = j.ok?.executionResult?.ok !== undefined;
console.log('\nbatch dry-run (multisig origin):', ok ? 'SUCCESS' : 'FAILED', ok ? '' : JSON.stringify(j).slice(0, 500));
if (ok) {
  const ev = (dry.toHuman().Ok?.emittedEvents ?? []).map((e) => `${e.section ?? e.method ?? JSON.stringify(e).slice(0,60)}`);
  const evs = dry.asOk.emittedEvents.map((e) => `${e.section.toString()}.${e.method.toString()}`);
  console.log('events:', evs.join(', '));
}
console.log('\nCEREMONY — EPOCH STAGE (batchAll: approve 10.05 + stageTreasuryDeposit) inner call hex:');
console.log(hex);
console.log('call hash:', blake2AsHex(hex, 256), `(len ${(hex.length - 2) / 2} bytes)`);
await api.disconnect(); process.exit(0);
