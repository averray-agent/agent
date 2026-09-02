import { ApiPromise, WsProvider } from '@polkadot/api';
const ADAPTER_ID = '0x96091d4477fe37e79557276d63883bbbbde73159eeeeeeeeeeeeeeeeeeeeeeee';
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const balAt = async (n) => {
  const at = await api.at(await api.rpc.chain.getBlockHash(n));
  const a = await at.query.assets.account(1337, ADAPTER_ID);
  return a.isSome ? 1 : 0;
};
let lo = 19103645, hi = 19103660;
while (hi - lo > 1) { const mid = (lo + hi) >> 1; (await balAt(mid)) ? (hi = mid) : (lo = mid); }
console.log('dust pull block =', hi);
const at = await api.at(await api.rpc.chain.getBlockHash(hi));
console.log('ts', new Date(Number(await at.query.timestamp.now())).toISOString());
for (const { event, phase } of await at.query.system.events()) {
  if (['system', 'transactionPayment', 'timestamp', 'parachainSystem', 'collatorSelection', 'session'].includes(event.section)) continue;
  console.log(phase.toString().slice(0, 28), event.section + '.' + event.method, JSON.stringify(event.data.toJSON()).slice(0, 200));
}
await api.disconnect(); process.exit(0);
