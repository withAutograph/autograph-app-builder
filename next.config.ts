import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@emulators/core/dist/fonts/**/*",
      "./node_modules/.pnpm/@emulators+core@*/node_modules/@emulators/core/dist/fonts/**/*",
      "./node_modules/@emulators/github/dist/fonts/**/*",
      "./node_modules/.pnpm/@emulators+github@*/node_modules/@emulators/github/dist/fonts/**/*",
      "./node_modules/@emulators/vercel/dist/fonts/**/*",
      "./node_modules/.pnpm/@emulators+vercel@*/node_modules/@emulators/vercel/dist/fonts/**/*",
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

// The local OAuth emulator only needs the application routes. Starting Eve's
// development sidecar would introduce an unrelated agent runtime requirement
// and prevents the sign-in UI from coming up.
const tracedConfig = withEmulate(nextConfig, { routePrefix: "/api/emulate" });

const externalDevelopmentEve =
  process.env.APP_BUILDER_EXECUTION_MODE === "development" &&
  process.env.APP_BUILDER_LOCAL_ADAPTER === "1" &&
  process.env.EVE_AGENT_HOST?.startsWith("http://127.0.0.1:") === true;

export default process.env.APP_BUILDER_LOCAL_AUTH_EMULATION === "1" ||
externalDevelopmentEve
  ? tracedConfig
  : withEve(tracedConfig);
