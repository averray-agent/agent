import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY_H160 = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const MULTISIG = '0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);

const ethCall = async (from, to, data) => {
  for (const url of ['https://services.polkadothub-rpc.com/mainnet', 'https://eth-rpc.polkadot.io']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to, data }, 'latest'] }) });
      const j = await r.json();
      if (j.result !== undefined) return 'ok ' + j.result.slice(0, 40);
      if (j.error) return 'REVERT ' + JSON.stringify(j.error).slice(0, 120);
    } catch {}
  }
  return 'RPC_FAIL';
};
for (const amt of [1n, 150_000n, 10_050_000n]) {
  console.log(`transfer(adapter, ${amt}) from treasury lens:`, await ethCall(TREASURY_H160, USDC, sel('transfer(address,uint256)') + padAddr(ADAPTER) + pad(amt)));
}

const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const acct = await api.query.assets.account(1337, MULTISIG);
console.log('treasury assets.account full:', JSON.stringify(acct.toJSON()));

// replay-stage (dust params, existing request -> skips transferFrom) via native multisig origin
const STAGE_REPLAY = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY_H160) + pad(150_000n) + pad(100_000n) + pad(100_000n) + pad(40_000n) + pad(1786131330n) + pad(1n);
const r = await api.call.reviveApi.call(MULTISIG, ADAPTER, 0, null, null, STAGE_REPLAY);
const j = r.toJSON(); const res = j.result?.ok;
console.log('replay-stage via native origin:', res ? ((res.flags?.bits ?? 0) & 1 ? `REVERT ${res.data.slice(0, 10)}` : 'ok') : JSON.stringify(j.result).slice(0, 150));
await api.disconnect(); process.exit(0);
