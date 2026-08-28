import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/*": [
      "./agent/skills/**/*",
      "./artifacts/hosted/arrusted-c9a5faf2-preview.tar.gz",
    ],
  },
  async headers() {
    return [
      {
        source: "/auth/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default withEve(nextConfig);
