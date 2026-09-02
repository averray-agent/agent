import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex } from '@polkadot/util-crypto';

const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY_H160 = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const MULTISIG = '0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47';
const GROSS = 10_050_000n, SELL = 10_000_000n, MIN = 10_000_000n, FEE = 40_000n, NONCE = 2n;
const DEADLINE = 1786193710n;
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig) => keccakAsHex(sig).slice(0, 10);
const APPROVE = sel('approve(address,uint256)') + padAddr(ADAPTER) + pad(GROSS);
const STAGE = sel('stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)')
  + padAddr(TREASURY_H160) + pad(GROSS) + pad(SELL) + pad(MIN) + pad(FEE) + pad(DEADLINE) + pad(NONCE);

const DICT = {};
for (const sig of ['InvalidRequest()', 'Unauthorized()', 'ProtocolPaused()', 'CustodyMismatch()', 'InvalidConfiguration()',
  'InvalidStatus()', 'TransferFailed()', 'SafeTransferFailed()', 'TransferFromFailed()', 'DispatchDeadlineExpired()',
  'FeeAboveMaximum()', 'InvalidTransition()']) DICT[sel(sig)] = sig;

const api = await ApiPromise.create({ provider: new WsProvider('wss://asset-hub-polkadot-rpc.n.dwellir.com/'), noInitWarn: true });
const rcall = async (label, to, data) => {
  const r = await api.call.reviveApi.call(MULTISIG, to, 0, null, null, data);
  const j = r.toJSON();
  const res = j.result?.ok;
  if (!res) { console.log(`${label}: ERR ${JSON.stringify(j.result).slice(0, 200)}`); return; }
  const revert = (res.flags?.bits ?? res.flags) & 1;
  const selector = (res.data ?? '0x').slice(0, 10);
  console.log(`${label}: ${revert ? 'REVERT' : 'ok'} data=${(res.data ?? '0x').slice(0, 74)}${revert ? ` -> ${DICT[selector] ?? 'UNKNOWN selector'}` : ''} weight={${j.weightRequired.refTime},${j.weightRequired.proofSize}}`);
};
await rcall('approve via ReviveApi (multisig origin)', USDC, APPROVE);
await rcall('stage   via ReviveApi (multisig origin)', ADAPTER, STAGE);

// non-atomic batch: which index interrupts?
const c1 = api.tx.revive.call(USDC, 0, { refTime: 2_000_000_000n, proofSize: 200_000n }, 10_000_000_000n, APPROVE);
const c2 = api.tx.revive.call(ADAPTER, 0, { refTime: 8_000_000_000n, proofSize: 800_000n }, 20_000_000_000n, STAGE);
const batch = api.tx.utility.batch([c1, c2]);
let dry;
try { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method, 5); }
catch { dry = await api.call.dryRunApi.dryRunCall({ system: { Signed: MULTISIG } }, batch.method); }
const h = dry.toHuman().Ok ?? {};
const evs = (dry.asOk?.emittedEvents ?? []).map((e) => `${e.section}.${e.method}`);
console.log('non-atomic batch events:', evs.join(', ') || JSON.stringify(h).slice(0, 300));
await api.disconnect(); process.exit(0);
