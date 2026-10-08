import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
test("branded missing pages, favicons and no-JS explanations are source-owned", async () => {
  for (const path of ["app/app/not-found.tsx", "marketing/src/pages/404.astro"]) {
    const source = await read(path);
    assert.match(source, /Averray · 404/);
    assert.match(source, /This page is not here/);
    assert.match(source, /href="\//);
  }
  const app = await read("app/app/layout.tsx");
  const site = await read("marketing/src/layouts/BaseLayout.astro");
  for (const source of [app, site]) {
    assert.match(source, /favicon.svg/);
    assert.match(source, /<noscript>/);
    assert.match(source, /https:\/\/api.averray.com\//);
  }
  assert.equal(await read("app/public/favicon.svg"), await read("marketing/public/favicon.svg"));
  const sync = await read("scripts/sync-marketing-site.mjs");
  for (const asset of ["404.html", "favicon.svg", "robots.txt", "sitemap.xml"]) assert.ok(sync.includes(`"${asset}"`), asset);
});

test("sitemap enumerates every static public page and omits the error page", async () => {
  const pages = (await readdir(new URL("marketing/src/pages/", root), { recursive: true })).filter((name) => name.endsWith(".astro"));
  const source = (await read("marketing/src/pages/sitemap.xml.ts"))
    .replace('import.meta.glob("./**/*.astro")', JSON.stringify(Object.fromEntries(pages.map((name) => ["./" + name, {}]))));
  const { GET } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const response = GET();
  assert.equal(response.headers.get("content-type"), "application/xml");
  const xml = await response.text();
  for (const page of pages.filter((name) => name !== "404.astro")) {
    const path = page === "index.astro" ? "/" : "/" + page.replace(".astro", "").replace(/\/index$/u, "") + "/";
    assert.ok(xml.includes(`<loc>https://averray.com${path}</loc>`), path);
  }
  for (const path of ["/agent.html", "/schemas/agent-badge-v1.html", "/schemas/agent-profile-v1.html"]) assert.ok(xml.includes(path), path);
  assert.ok(!xml.includes("/404"));
});

test("app sitemap pins all public doors and excludes the share template", async () => {
  const source = (await read("app/app/sitemap.ts")).replace(/^import type.*\n/m, "").replace(": MetadataRoute.Sitemap", "");
  const { default: sitemap } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  assert.deepEqual(sitemap().map((entry) => entry.url), ["/", "/work/", "/work-withdraw/", "/pool/", "/sign-in/"].map((path) => "https://app.averray.com" + path));
});

test("static live placeholders and glued copy are replaced without baking numbers", async () => {
  for (const name of ["pool", "transparency", "verify", "index"]) {
    const source = await read(`marketing/src/pages/${name}.astro`);
    assert.doesNotMatch(source, />—<|Reading[^<]*…/);
    assert.match(source, /[Nn]ot loaded|See live pricing/);
  }
  for (const name of ["receipts", "trust"]) {
    assert.match(await read(`marketing/src/pages/${name}.astro`), /raw JSON: \{" "\}/);
  }
  assert.match(await read("marketing/src/pages/pool.astro"), /GET \/pool<\/a>\{" "\}/);
});

const caddy = process.env.CADDY_BIN;
test("real Caddy returns branded 404 bodies on both site and app, never 200", {
  skip: !caddy && !process.env.CI, timeout: 30_000
}, async (t) => {
  assert.ok(caddy, "CI must provision CADDY_BIN");
  const dir = await mkdtemp(join(tmpdir(), "averray-branded-404-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const area of ["site", "frontend"]) {
    await mkdir(join(dir, area));
    await writeFile(join(dir, area, "404.html"), `<!doctype html><title>Averray · 404</title><h1>Averray ${area}: This page is not here.</h1>`);
  }
  const path = join(dir, "Caddyfile");
  await writeFile(path, await read("deploy/Caddyfile.averray"));
  const { stdout } = await promisify(execFile)(caddy, ["adapt", "--config", path, "--adapter", "caddyfile"]);
  const config = JSON.parse(stdout);
  const server = Object.values(config.apps.http.servers)[0];
  server.routes = server.routes.filter((route) => route.match?.some((match) => match.host?.some((host) => ["averray.com", "app.averray.com"].includes(host))));
  const replaceRoots = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === "/srv/site") value[key] = join(dir, "site");
      else if (entry === "/srv/frontend") value[key] = join(dir, "frontend");
      else replaceRoots(entry);
    }
  };
  replaceRoots(server);
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  server.listen = [`127.0.0.1:${port}`];
  server.automatic_https = { disable: true };
  config.admin = { disabled: true };
  config.storage = { module: "file_system", root: join(dir, "storage") };
  const json = join(dir, "config.json");
  await writeFile(json, JSON.stringify(config));
  const child = spawn(caddy, ["run", "--config", json], { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; });
  const request = (host) => new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/definitely-not-a-page`, { headers: { host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("edge timeout")));
    req.on("error", reject);
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { await request("averray.com"); ready = true; break; }
    catch { if (child.exitCode !== null) break; await delay(25); }
  }
  assert.ok(ready, logs);
  for (const host of ["averray.com", "app.averray.com"]) {
    const response = await request(host);
    assert.equal(response.status, 404, host);
    assert.match(response.headers["strict-transport-security"], /max-age=31536000/);
    assert.equal(response.headers["cache-control"], "no-cache");
    assert.match(response.body, /Averray.*This page is not here/);
  }
});
