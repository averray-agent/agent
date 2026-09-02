import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const MULTISIG = '0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);
const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });

const nowV = api.runtimeVersion.specVersion.toNumber();
const oldHash = await api.rpc.chain.getBlockHash(19103645);
const oldApi = await api.at(oldHash);
console.log('specVersion now:', nowV, '| at 19,103,645:', oldApi.runtimeVersion.specVersion.toNumber());

const APPROVE = sel('approve(address,uint256)') + padAddr(ADAPTER) + pad(150_000n);
const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY) + pad(150_000n) + pad(100_000n) + pad(100_000n) + pad(40_000n) + pad(1785999999n) + pad(3n);
const batch = api.tx.utility.batch([
  api.tx.revive.call(USDC, 0, { refTime: 2_000_000_000n, proofSize: 200_000n }, 10_000_000_000n, APPROVE),
  api.tx.revive.call(ADAPTER, 0, { refTime: 8_000_000_000n, proofSize: 800_000n }, 20_000_000_000n, STAGE),
]);
const runAt = async (label, at) => {
  let dry;
  try { dry = await at.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method, 5); }
  catch (e) { try { dry = await at.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method); } catch (e2) { console.log(label, 'dryrun unavailable:', e2.message.slice(0, 80)); return; } }
  const evs = dry.asOk.emittedEvents.map((e) => e.section + '.' + e.method + (e.section === 'utility' ? ' ' + JSON.stringify(e.data.toJSON()).slice(0, 90) : ''));
  console.log(label + ':\n  ' + evs.join('\n  '));
};
await runAt('same-tx batch vs PRE-DUST state (blk 19,103,645)', oldApi);
await api.disconnect(); process.exit(0);
