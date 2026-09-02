const { ethers } = require("ethers");
(async () => {
  const p = new ethers.JsonRpcProvider("https://services.polkadothub-rpc.com/mainnet/");
  const ad = "0xE2801E6C640e0180798912649fD567E1Ea459a35";
  const rid = "0xe69b4a13983bda6bced68afefec896d01f2d0f93c2819b911c035a350522d959";
  const c = new ethers.Contract(ad, ["function getRequest(bytes32) view returns (uint8 kind,uint8 status,uint256 assets,uint256 settledAssets,uint64 createdAt)"], p);
  const names = { 0: "None", 1: "Pending", 2: "Succeeded", 3: "Failed" };
  for (let i = 0; i < 170; i++) {
    try {
      const r = await c.getRequest(rid);
      const st = Number(r[1]);
      if (st !== 1) {
        console.log(`TERMINAL: status=${st} (${names[st]}) settled=${(Number(r[3]) / 1e6).toFixed(6)} assets=${(Number(r[2]) / 1e6).toFixed(6)}`);
        process.exit(0);
      }
      if (i % 10 === 0) console.log(`[${new Date().toISOString().slice(11, 19)}] still Pending (check ${i + 1})`);
    } catch (e) { if (i % 20 === 0) console.log("read error:", String(e.message).slice(0, 50)); }
    await new Promise(r => setTimeout(r, 60000));
  }
  console.log("watcher expired after ~170 minutes, still Pending");
})();
