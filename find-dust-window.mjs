import { ApiPromise, WsProvider } from '@polkadot/api';
const ADAPTER_ID = '0x96091d4477fe37e79557276d63883bbbbde73159eeeeeeeeeeeeeeeeeeeeeeee';
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const balAt = async (n) => {
  const at = await api.at(await api.rpc.chain.getBlockHash(n));
  const a = await at.query.assets.account(1337, ADAPTER_ID);
  return a.isSome ? BigInt(a.unwrap().balance.toString()) : -1n;
};
for (const n of [19103630, 19103641, 19103645, 19103660, 19103700, 19103800, 19104200, 19105000, 19106500, 19108000, 19109500]) {
  console.log(n, (await balAt(n)).toString());
}
await api.disconnect(); process.exit(0);
