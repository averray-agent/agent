import { ApiPromise, WsProvider } from '@polkadot/api';
const CONVERTED = '0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3';
const hyd = await ApiPromise.create({ provider: new WsProvider('wss://hydration-rpc.n.dwellir.com/'), noInitWarn: true });
const at = await hyd.at(await hyd.rpc.chain.getBlockHash(13488842));
for (const { event } of await at.query.system.events()) {
  if (event.section === 'broadcast' && event.method.startsWith('Swapped')) {
    const d = event.data.toJSON();
    const s = JSON.stringify(d);
    if (s.includes('48df881b') || s.includes('12eYrKzitqg8')) {
      console.log('OUR swap:', JSON.stringify(d).slice(0, 420));
    }
  }
}
await hyd.disconnect();
process.exit(0);
