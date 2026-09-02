const { ethers } = require("ethers");
(async () => {
  const hub = new ethers.JsonRpcProvider("https://services.polkadothub-rpc.com/mainnet/");
  const u = x => (Number(x)/1e6).toFixed(6);
  const pool = new ethers.Contract("0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30",
    ["function venueRecalls(uint256) view returns (uint256 deploymentId,uint256 requestedAssets,uint256 returnedAssets,bytes32 adapterRequestId,uint8 status)",
     "function bufferAssets() view returns (uint256)"], hub);
  const start = await hub.getBlockNumber();
  console.log("watching from block", start);
  for (let i = 0; i < 90; i++) {
    try {
      const head = await hub.getBlockNumber();
      const r = await pool.venueRecalls(6);
      const t = new Date().toISOString().slice(11,19);
      let logs = [];
      for (const a of ["0xE2801E6C640e0180798912649fD567E1Ea459a35","0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc","0x88eE70277E486136676c0b50Ed9b7D7A1a31371f"]) {
        const l = await hub.getLogs({ address: a, fromBlock: start, toBlock: head }).catch(()=>[]);
        logs.push(...l.map(x=>x.blockNumber));
      }
      if (Number(r[2]) > 0 || Number(r[4]) !== 1) {
        console.log(`[${t}] RETURNED — returned=${u(r[2])} status=${r[4]} buffer=${u(await pool.bufferAssets())}`); process.exit(0);
      }
      if (logs.length) console.log(`[${t}] lane-path activity: ${logs.length} log(s) @ ${[...new Set(logs)].join(",")} | returned=${u(r[2])}`);
      else if (i % 5 === 0) console.log(`[${t}] no activity yet | returned=${u(r[2])} buffer=${u(await pool.bufferAssets())}`);
    } catch (e) {}
    await new Promise(r => setTimeout(r, 45000));
  }
  console.log("watcher expired");
})();
