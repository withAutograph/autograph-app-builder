import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { microsandbox } from "eve/sandbox/microsandbox";

import {
  configuredToolchainImage,
  sandboxRevalidationKey,
} from "@/lib/sandbox/toolchain";

const image = configuredToolchainImage();
const useFixtureSandbox =
  process.env.APP_BUILDER_TEST_MODEL === "1" &&
  process.env.APP_BUILDER_REAL_SANDBOX !== "1";

export default defineSandbox({
  // A missing or invalid external image is not allowed to fall back to Eve's
  // floating default image. just-bash has no real target toolchain, so the
  // typed inspection receipt remains fail-closed.
  backend:
    useFixtureSandbox || image === undefined
      ? justbash({ autoInstall: false })
      : microsandbox({
          image,
          pullPolicy: "never",
          setup: { autoInstall: false },
          networkPolicy: "deny-all",
        }),
  // Eve 0.43 requires a template hook for revalidation. This deliberately
  // performs no installation, network access, or workspace mutation.
  async bootstrap({ use }) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
    await use();
  },
  revalidationKey: () => sandboxRevalidationKey(image),
});
