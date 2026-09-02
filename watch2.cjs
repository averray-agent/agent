const { ethers } = require("ethers");
(async () => {
  const hub = new ethers.JsonRpcProvider("https://services.polkadothub-rpc.com/mainnet/");
  const u = x => (Number(x)/1e6).toFixed(6);
  const pool = new ethers.Contract("0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30",
    ["function venueRecalls(uint256) view returns (uint256 deploymentId,uint256 requestedAssets,uint256 returnedAssets,bytes32 adapterRequestId,uint8 status)",
     "function bufferAssets() view returns (uint256)"], hub);
  const usdc = new ethers.Contract("0x0000053900000000000000000000000001200000", ["function balanceOf(address) view returns (uint256)"], hub);
  const watch = { adapter: "0xE2801E6C640e0180798912649fD567E1Ea459a35", wrapper: "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc", lane: "0x88eE70277E486136676c0b50Ed9b7D7A1a31371f" };
  for (let i = 0; i < 150; i++) {
    try {
      const r = await pool.venueRecalls(6);
      const t = new Date().toISOString().slice(11, 19);
      let arrived = 0n;
      for (const a of Object.values(watch)) arrived += BigInt((await usdc.balanceOf(a)).toString());
      if (Number(r[2]) > 0 || Number(r[4]) !== 1) {
        console.log(`[${t}] RECALL MOVED — returned=${u(r[2])} status=${r[4]} buffer=${u(await pool.bufferAssets())}`); process.exit(0);
      }
      if (arrived > 0n) { console.log(`[${t}] USDC ARRIVED on the lane path: ${u(arrived)} — ready to settle`); process.exit(0); }
      if (i % 5 === 0) console.log(`[${t}] in transit — returned=${u(r[2])} laneUsdc=${u(arrived)} buffer=${u(await pool.bufferAssets())}`);
    } catch (e) {}
    await new Promise(r => setTimeout(r, 60000));
  }
  console.log("watcher expired, still in transit");
})();
