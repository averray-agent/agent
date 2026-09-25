// Test-only preload: observe the real server process without a production route.
const observed = [];
const observe = (reason) => observed.push({ name: reason?.name, code: reason?.code, message: reason?.message });
process.on("unhandledRejection", observe);
process.on("message", async ({ command }) => {
  if (command === "reject") {
    // Only the production listener may keep the process alive for this probe.
    process.removeListener("unhandledRejection", observe);
    Promise.reject(Object.assign(new Error("contained probe failure"), { code: "PROBE_FAILURE" }));
  }
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.send({ command, observed, listenerCount: process.listenerCount("unhandledRejection"), uncaughtExceptionListeners: process.listenerCount("uncaughtException") });
});
