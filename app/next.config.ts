import type { NextConfig } from "next";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";
const staticExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  generateBuildId: async () => process.env.NEXT_BUILD_ID ?? "averray-operator",
  ...(staticExport ? { output: "export" as const, trailingSlash: true } : {}),
  ...(staticExport
    ? {}
    : {
        async redirects() {
          return [
            {
              source: "/work/withdraw",
              destination: "/work-withdraw",
              permanent: true,
            },
          ];
        },
        async rewrites() {
          return [
            {
              source: "/work/session/:sessionId",
              destination: "/work/session",
            },
            {
              source: "/work/:jobId",
              destination: "/work/job",
            },
            {
              source: "/api/:path*",
              destination: `${apiBaseUrl}/:path*`,
            },
          ];
        },
      }),
};

export default nextConfig;
