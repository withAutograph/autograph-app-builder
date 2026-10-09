import { realpathSync } from "node:fs";
import path from "node:path";
import { withEmulate } from "@emulators/adapter-next";
import createMDX from "@next/mdx";
import { withEve } from "eve/next";
import type { NextConfig } from "next";
import { readProductionNavigationRuntimeConfig } from "./lib/testing/production-navigation";

const productionNavigationArtifact = Boolean(readProductionNavigationRuntimeConfig(process.env));

const externalDevelopmentEve =
  process.env.APP_BUILDER_EXECUTION_MODE === "development" &&
  process.env.APP_BUILDER_LOCAL_ADAPTER === "1" &&
  process.env.EVE_AGENT_HOST?.startsWith("http://127.0.0.1:") === true;

const developmentTurbopackRoot = () => {
  const dependencies = realpathSync(path.join(import.meta.dirname, "node_modules"));
  let root = realpathSync(import.meta.dirname);
  while (path.relative(root, dependencies).split(path.sep)[0] === "..") {
    root = path.dirname(root);
  }
  return root;
};

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    exposeTestingApiInProductionBuild: productionNavigationArtifact,
  },
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async headers() {
    return [
      {
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
        source: "/auth/:path*",
      },
    ];
  },
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
  partialPrefetching: true,
};

// Linked dependency caches must share Turbopack's filesystem root with live source.
if (
  process.env.NODE_ENV === "development" &&
  externalDevelopmentEve &&
  process.env.APP_BUILDER_LOCAL_AUTH_EMULATION !== "1" &&
  !productionNavigationArtifact
) {
  nextConfig.turbopack = { root: developmentTurbopackRoot() };
}

const withMDX = createMDX({});
const mdxConfig = withMDX(nextConfig);

// The local OAuth emulator only needs the application routes. Starting Eve's
// development sidecar would introduce an unrelated agent runtime requirement
// and prevents the sign-in UI from coming up.
const tracedConfig = withEmulate(mdxConfig, { routePrefix: "/api/emulate" });

export default productionNavigationArtifact ||
process.env.APP_BUILDER_LOCAL_AUTH_EMULATION === "1" ||
externalDevelopmentEve
  ? tracedConfig
  : withEve(tracedConfig);
