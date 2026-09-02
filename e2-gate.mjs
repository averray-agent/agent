import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const MULTISIG = '0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);

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
const allowance = await ethCall(USDC, sel('allowance(address,address)') + padAddr(TREASURY) + padAddr(ADAPTER));
console.log('allowance treasury->adapter:', BigInt(allowance).toString(), BigInt(allowance) === 10_050_000n ? 'PASS == 10,050,000' : 'FAIL');

const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY) + pad(10_050_000n) + pad(10_000_000n) + pad(10_000_000n) + pad(40_000n) + pad(1786193710n) + pad(2n);
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const r = await api.call.reviveApi.call(MULTISIG, ADAPTER, 0, null, null, STAGE);
const j = r.toJSON(); const res = j.result?.ok;
if (!res) { console.log('stage dry-run: ERR', JSON.stringify(j.result).slice(0, 300)); }
else {
  const revert = (res.flags?.bits ?? 0) & 1;
  console.log('stage dry-run vs REAL state:', revert ? 'REVERT ' + res.data.slice(0, 10) : 'CLEAN');
  console.log('returned requestId:', res.data, res.data === '0xeaa4d5007c8154d390bbab0557a8c03d1c59c1a1b4faca8c761902241b087767' ? 'PASS == epoch requestId' : '(compare: 0xeaa4d500…7767)');
  console.log('weightRequired:', JSON.stringify(j.weightRequired), 'storageDeposit:', JSON.stringify(j.storageDeposit));
}
await api.disconnect(); process.exit(0);
