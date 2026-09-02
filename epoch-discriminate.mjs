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
const rc = (to, data, ref = 4_000_000_000n) => api.tx.revive.call(to, 0, { refTime: ref, proofSize: 400_000n }, 20_000_000_000n, data);
const run = async (label, calls) => {
  const batch = api.tx.utility.batch(calls);
  let dry;
  try { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method, 5); }
  catch { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method); }
  const evs = dry.asOk.emittedEvents.map((e) => {
    const d = e.section === 'utility' || e.section === 'assets' ? ' ' + JSON.stringify(e.data.toJSON()).slice(0, 110) : '';
    return e.section + '.' + e.method + d;
  });
  console.log(label + ':\n  ' + evs.join('\n  '));
};

// A. self-delegated transferFrom: owner=lens-param, spender=lens-caller, dest=adapter
//    isolates assets-pallet transfer_approved resolution with NO adapter code involved
await run('A. approve(self) + transferFrom(treasury->adapter) as multisig', [
  rc(USDC, sel('approve(address,uint256)') + padAddr(TREASURY) + pad(10_050_000n)),
  rc(USDC, sel('transferFrom(address,address,uint256)') + padAddr(TREASURY) + padAddr(ADAPTER) + pad(10_050_000n)),
]);

// B. dust-sized FRESH stage (nonce 3): amount-dependence test
await run('B. approve(adapter,150k) + stage(150k/100k, nonce 3)', [
  rc(USDC, sel('approve(address,uint256)') + padAddr(ADAPTER) + pad(150_000n)),
  rc(ADAPTER, sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
    + padAddr(TREASURY) + pad(150_000n) + pad(100_000n) + pad(100_000n) + pad(40_000n) + pad(1786193710n) + pad(3n), 8_000_000_000n),
]);
await api.disconnect(); process.exit(0);
