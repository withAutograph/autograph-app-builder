import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
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

// The local OAuth emulator only needs the application routes. Starting Eve's
// development sidecar would introduce an unrelated agent runtime requirement
// and prevents the sign-in UI from coming up.
export default process.env.APP_BUILDER_LOCAL_AUTH_EMULATION === "1"
  ? nextConfig
  : withEve(nextConfig);
