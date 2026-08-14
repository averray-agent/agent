import { networkInterfaces } from "node:os";

const interfaces = Object.keys(networkInterfaces()).sort();
console.log(`CONTAINER_INTERFACES=${interfaces.join(",")}`);
if (interfaces.length !== 1 || interfaces[0] !== "lo") {
  console.error("NetworkMode is not none: non-loopback interface observed");
  process.exit(1);
}
