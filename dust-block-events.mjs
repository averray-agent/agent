import { ApiPromise, WsProvider } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const at = await api.at(await api.rpc.chain.getBlockHash(19103641));
for (const { event, phase } of await at.query.system.events()) {
  if (['system', 'balances', 'transactionPayment', 'timestamp', 'parachainSystem'].includes(event.section)) continue;
  console.log(phase.toString().slice(0, 30), event.section + '.' + event.method, JSON.stringify(event.data.toJSON()).slice(0, 160));
}
await api.disconnect(); process.exit(0);
