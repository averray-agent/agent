const call = async (url, to, data) => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
    return (await r.json()).result ?? 'FAIL';
  } catch (e) { return 'ERR:' + e.message; }
};
for (const url of ['https://eth-rpc.polkadot.io', 'https://services.polkadothub-rpc.com/mainnet']) {
  console.log(url);
  console.log('  wrapper.dispatchPaused():', await call(url, '0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc', '0x30c742d9'));
  console.log('  policy.paused()         :', await call(url, '0x226F14252A98BD2eA140271647De20132F09AF20', '0x5c975abb'));
}
