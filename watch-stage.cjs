const { ethers } = require("ethers");
(async () => {
  const p = new ethers.JsonRpcProvider("https://services.polkadothub-rpc.com/mainnet/");
  const u = x => (Number(x)/1e6).toFixed(6);
  const pool = new ethers.Contract("0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30",
    ["function venueRecalls(uint256) view returns (uint256 deploymentId,uint256 requestedAssets,uint256 returnedAssets,bytes32 adapterRequestId,uint8 status)",
     "function bufferAssets() view returns (uint256)"], p);
  const addrs = ["0xE2801E6C640e0180798912649fD567E1Ea459a35","0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc","0x88eE70277E486136676c0b50Ed9b7D7A1a31371f"];
  const from = 20138900;
  let staged = false;
  for (let i = 0; i < 120; i++) {
    try {
      const head = await p.getBlockNumber();
      let n = 0, blocks = [];
      for (const a of addrs) {
        const logs = await p.getLogs({ address: a, fromBlock: from, toBlock: head }).catch(() => []);
        n += logs.length; logs.forEach(l => blocks.push(l.blockNumber));
      }
      const r = await pool.venueRecalls(6);
      const t = new Date().toISOString().slice(11,19);
      if (n > 0 && !staged) { staged = true; console.log(`[${t}] STAGED — ${n} log(s) at blocks ${[...new Set(blocks)].join(",")}`); }
      if (Number(r[4]) !== 1 || Number(r[2]) > 0) {
        console.log(`[${t}] SETTLED/CHANGED — returned=${u(r[2])} status=${r[4]} buffer=${u(await pool.bufferAssets())}`);
        process.exit(0);
      }
      if (i % 5 === 0) console.log(`[${t}] staged=${staged} recall status=${r[4]} returned=${u(r[2])} buffer=${u(await pool.bufferAssets())}`);
    } catch (e) {}
    await new Promise(r => setTimeout(r, 60000));
  }
  console.log("watcher expired");
})();
