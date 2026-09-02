import { keccakAsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const WRAPPER = '0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc';
const TREASURY = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const EPOCH_ID = 'eaa4d5007c8154d390bbab0557a8c03d1c59c1a1b4faca8c761902241b087767';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);
const call = async (to, data) => {
  for (const url of ['https://services.polkadothub-rpc.com/mainnet', 'https://eth-rpc.polkadot.io']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
      const j = await r.json(); if (j.result) return j.result;
    } catch {}
  }
  return 'FAIL';
};
const n = (h) => BigInt(h).toString();
console.log('treasury USDC  :', n(await call(USDC, sel('balanceOf(address)') + padAddr(TREASURY))), '(expect 878804)');
console.log('adapter custody:', n(await call(USDC, sel('balanceOf(address)') + padAddr(ADAPTER))), '(expect 10050000)');
console.log('allowance left :', n(await call(USDC, sel('allowance(address,address)') + padAddr(TREASURY) + padAddr(ADAPTER))), '(expect 0)');
const rec = await call(ADAPTER, sel('getAdapterRequest(bytes32)') + EPOCH_ID);
const w = (i) => rec.slice(2 + i * 64, 2 + (i + 1) * 64);
console.log('adapter record : kind', BigInt('0x' + w(0)).toString(), '(0=Deposit) | status', BigInt('0x' + w(1)).toString(), '(1=Pending) | account 0x' + w(2).slice(24),
  '| requestedAssets', BigInt('0x' + w(5)).toString(), '| settled', BigInt('0x' + w(11)).toString());
console.log('pendingDeposits:', n(await call(ADAPTER, sel('pendingDepositAssets()'))), '(expect 10050000)');
