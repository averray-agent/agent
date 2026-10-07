// Enumerate source pages so adding a public page cannot silently omit it.
const pages = Object.keys(import.meta.glob("./**/*.astro"))
  .map((file) => file.replace("./", "").replace(".astro", ""))
  .filter((name) => name !== "404")
  .map((name) => name === "index" ? "/" : `/${name.replace(/\/index$/u, "")}/`);
const legacyPages = ["/agent.html", "/schemas/agent-badge-v1.html", "/schemas/agent-profile-v1.html"];
export function GET() {
  const urls = [...new Set([...pages, ...legacyPages])].sort();
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((path) => `<url><loc>https://averray.com${path}</loc></url>`).join("")}</urlset>`, {
    headers: { "content-type": "application/xml" }
  });
}
