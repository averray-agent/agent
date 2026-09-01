#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve } from "node:path";

import { primaryNavLinks } from "../../marketing/src/navigation.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);
const PAGES_ROOT = new URL("marketing/src/pages/", REPO_ROOT);
const FOOTER = new URL("marketing/src/components/SiteFooter.astro", REPO_ROOT);

// A route may be excluded only by naming it here and explaining why. There are
// deliberately no exclusions today: every public marketing page is a door.
export const INTENTIONALLY_UNLINKED_ROUTES = Object.freeze([]);

function normalizeRoute(href) {
  const path = href.split(/[?#]/u, 1)[0] || "/";
  if (path === "/") return path;
  return `/${path.replace(/^\/+|\/+$/gu, "")}/`;
}

export function pageFileToRoute(file) {
  const extension = extname(file);
  let route = file.slice(0, -extension.length).split("\\").join("/");
  route = route === "index" ? "" : route.replace(/\/index$/u, "");
  return normalizeRoute(route);
}

async function findAstroPages(directory = PAGES_ROOT) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return findAstroPages(url);
    return entry.isFile() && entry.name.endsWith(".astro") ? [url] : [];
  }));
  return files.flat();
}

export async function marketingPageInventory({ pagesRoot = PAGES_ROOT } = {}) {
  const rootPath = fileURLToPath(pagesRoot);
  const files = await findAstroPages(pagesRoot);
  return files.map((url) => {
    const file = relative(rootPath, fileURLToPath(url)).split("\\").join("/");
    return { file, route: pageFileToRoute(file), url };
  }).sort((a, b) => a.route.localeCompare(b.route));
}

function internalFooterDestinations(source) {
  return [...source.matchAll(/href="(\/[^"]*)"/gu)].map((match) => normalizeRoute(match[1]));
}

export function assertMarketingReachability({ pageRoutes, footerSource }) {
  const sharedDestinations = new Set([
    "/",
    ...primaryNavLinks().map((link) => normalizeRoute(link.href)),
    ...internalFooterDestinations(footerSource)
  ]);
  const allowlist = new Set(INTENTIONALLY_UNLINKED_ROUTES.map(normalizeRoute));
  const routes = pageRoutes.map(normalizeRoute);
  const missing = routes.filter((route) => !sharedDestinations.has(route) && !allowlist.has(route));

  if (missing.length > 0) {
    throw new Error(
      `Unlinked marketing page${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
      "Add each route to the shared navigation/footer or document a deliberate exception in " +
      "INTENTIONALLY_UNLINKED_ROUTES."
    );
  }

  return { routes, sharedDestinations, allowlist };
}

export async function checkMarketingReachability({ pagesRoot = PAGES_ROOT } = {}) {
  const [pages, footerSource] = await Promise.all([
    marketingPageInventory({ pagesRoot }),
    readFile(FOOTER, "utf8")
  ]);
  return assertMarketingReachability({
    pageRoutes: pages.map((page) => page.route),
    footerSource
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await checkMarketingReachability();
  console.log("Marketing navigation reaches every public page.");
}
