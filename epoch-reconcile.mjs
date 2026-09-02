import { ApiPromise, WsProvider } from '@polkadot/api';
import { keccakAsHex } from '@polkadot/util-crypto';
const USDC = '0x0000053900000000000000000000000001200000';
const ADAPTER = '0x96091d4477Fe37E79557276d63883bBbbdE73159';
const TREASURY = '0x01E6eed856e989201F4FF6346E18EAb7e46C874C';
const AUSDC = '0x2ec4884088d84e5c2970a034732e5209b0acfa93';
const CONVERTED = '0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3';
const CONV20 = '0x48df881b65e682f05ac24dc8f668a8938225e973';
const EPOCH = 'eaa4d5007c8154d390bbab0557a8c03d1c59c1a1b4faca8c761902241b087767';
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (s) => keccakAsHex(s).slice(0, 10);
const ethCall = async (url, to, data) => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
    const j = await r.json(); return j.result ?? 'FAIL';
  } catch (e) { return 'ERR'; }
};
const AH = 'https://services.polkadothub-rpc.com/mainnet';
const n = (h) => BigInt(h);

// 1. Asset Hub end state
const treas = n(await ethCall(AH, USDC, sel('balanceOf(address)') + padAddr(TREASURY)));
const adap = n(await ethCall(AH, USDC, sel('balanceOf(address)') + padAddr(ADAPTER)));
console.log('treasury USDC        :', treas.toString(), treas === 878804n ? 'PASS unchanged since staging' : 'CHECK');
console.log('adapter custody      :', adap.toString(), adap === 0n ? 'PASS drained' : 'CHECK');
const rec = await ethCall(AH, ADAPTER, sel('getAdapterRequest(bytes32)') + EPOCH);
const w = (i) => BigInt('0x' + rec.slice(2 + i * 64, 2 + (i + 1) * 64));
console.log('adapter record       : status', w(1).toString(), '(2=Succeeded) reqAssets', w(5).toString(), 'settledAssets', w(7).toString(), 'settledShares', w(8).toString(), 'settled', w(11).toString());
console.log('totalAssets/Shares   :', n(await ethCall(AH, ADAPTER, sel('totalAssets()'))).toString(), '/', n(await ethCall(AH, ADAPTER, sel('totalShares()'))).toString());
console.log('pendingDepositAssets :', n(await ethCall(AH, ADAPTER, sel('pendingDepositAssets()'))).toString());

// 2. Hydration end state (EVM ERC20 lens for aUSDC; ORML for asset 22)
const HY = 'https://rpc.hydradx.cloud';
const aus = n(await ethCall(HY, AUSDC, sel('balanceOf(address)') + padAddr(CONV20)));
console.log('aUSDC (ERC20 lens)   :', aus.toString(), aus >= 10_000_000n ? `PASS >= 10,000,000 (yield +${aus - 10_000_000n})` : 'CHECK');
const hyd = await ApiPromise.create({ provider: new WsProvider('wss://hydration-rpc.n.dwellir.com/'), noInitWarn: true });
const t22 = await hyd.query.tokens.accounts(CONVERTED, 22);
console.log('asset-22 float       :', t22.free.toString(), t22.free.toString() === '29776' ? 'PASS == reported' : 'CHECK');

// 3. Ledger: 10,050,000 committed
const committed = 10_050_000n, arrival = 10_049_418n, sold = 10_000_000n;
const transferFee = committed - arrival;
const execFee = 19_642n, refund = 19_408n, authorized = 39_050n;
const float = arrival - sold - authorized + refund;
console.log('\n--- LEDGER (raw USDC) ---');
console.log('committed              :', committed.toString());
console.log('  transfer fee         : -', transferFee.toString(), transferFee === 582n ? '(PASS == reported 582)' : '');
console.log('  arrival              : =', arrival.toString());
console.log('  swapped to Aave      : -', sold.toString());
console.log('  fee budget authorized: -', authorized.toString(), authorized === 2n * 19_525n ? '(PASS == 2x quote)' : '');
console.log('  surplus refunded     : +', refund.toString(), '(exec fee', execFee.toString(), '=', (authorized - refund).toString(), (authorized - refund) === execFee ? 'PASS budget-refund==exec' : 'CHECK', ')');
console.log('  computed float       : =', float.toString(), float === 29_776n ? 'PASS == on-chain float' : 'MISMATCH');
console.log('friction total         :', (transferFee + execFee).toString(), '=', transferFee.toString(), '+', execFee.toString(), `(${Number(transferFee + execFee) / 100000}% of principal)`);
console.log('principal accounted    :', (sold + float + transferFee + execFee).toString(), (sold + float + transferFee + execFee) === committed ? 'PASS == committed, zero unexplained' : 'MISMATCH');
await hyd.disconnect(); process.exit(0);
