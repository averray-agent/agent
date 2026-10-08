import type { MetadataRoute } from "next";
export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  // Session/operator pages and parameterized job/receipt templates are not
  // public index entries. Their concrete records are discovered from the API.
  return ["/", "/work/", "/work-withdraw/", "/pool/", "/sign-in/"].map((path) => ({ url: `https://app.averray.com${path}` }));
}
