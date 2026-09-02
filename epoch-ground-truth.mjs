import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY_H160 = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const MULTISIG = '0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);

// 1. FULL return data of a plain transfer simulation
const r = await fetch('https://services.polkadothub-rpc.com/mainnet', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: TREASURY_H160, to: USDC, data: sel('transfer(address,uint256)') + padAddr(ADAPTER) + pad(150_000n) }, 'latest'] }) });
const jr = await r.json();
console.log('transfer(150k) FULL result:', JSON.stringify(jr.result ?? jr.error), 'len:', jr.result ? (jr.result.length - 2) / 2 : '-');

const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });

// 2. batch dry-run with full event data
const APPROVE = sel('approve(address,uint256)') + padAddr(ADAPTER) + pad(10_050_000n);
const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY_H160) + pad(10_050_000n) + pad(10_000_000n) + pad(10_000_000n) + pad(40_000n) + pad(1786193710n) + pad(2n);
const c1 = api.tx.revive.call(USDC, 0, { refTime: 2_000_000_000n, proofSize: 200_000n }, 10_000_000_000n, APPROVE);
const c2 = api.tx.revive.call(ADAPTER, 0, { refTime: 8_000_000_000n, proofSize: 800_000n }, 20_000_000_000n, STAGE);
let dry;
const batch = api.tx.utility.batch([c1, c2]);
try { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method, 5); }
catch { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method); }
for (const e of dry.asOk.emittedEvents) {
  console.log('batch event:', e.section.toString() + '.' + e.method.toString(), JSON.stringify(e.data.toHuman()).slice(0, 220));
}

// 3. dust-stage ground truth: binary-search block at timestamp 1785959136s, read its events
const target = 1_785_959_136_000;
let lo = 19_100_000, hi = 19_126_902;
const tsAt = async (n) => Number(await (await api.at(await api.rpc.chain.getBlockHash(n))).query.timestamp.now());
while (hi - lo > 1) { const mid = (lo + hi) >> 1; (await tsAt(mid)) < target ? (lo = mid) : (hi = mid); }
console.log('dust-stage block ~', hi, 'ts', await tsAt(hi));
for (let n = hi - 2; n <= hi + 2; n++) {
  const at = await api.at(await api.rpc.chain.getBlockHash(n));
  for (const { event } of await at.query.system.events()) {
    if (event.section === 'assets' && ['ApprovedTransfer', 'Transferred', 'TransferredApproved'].includes(event.method)) {
      console.log(`blk ${n} assets.${event.method}:`, JSON.stringify(event.data.toHuman()).slice(0, 220));
    }
  }
}
await api.disconnect(); process.exit(0);
