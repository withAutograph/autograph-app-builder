/* oxlint-disable promise/prefer-await-to-then -- serialize file writes from synchronous child process event callbacks */
/* oxlint-disable eslint/no-await-in-loop -- preserve deterministic archive collection and partial error handling */
import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "../sandbox/development-toolchain";

import { hostedEvalWorkerSource } from "./hosted-self-reproduction-worker-source";

export const hostedEvalBootstrapFiles = () => [
  {
    content: Buffer.from(hostedEvalWorkerSource),
    path: "/tmp/self-reproduction-worker-bootstrap.mjs",
  },
  {
    content: Buffer.from(
      JSON.stringify({
        environment: DEVELOPMENT_SANDBOX_ENVIRONMENT,
        toolchain: developmentPinnedToolchainCommand(),
      }),
    ),
    path: "/tmp/self-reproduction-worker-config.json",
  },
];
