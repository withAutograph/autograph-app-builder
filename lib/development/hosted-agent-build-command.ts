/** Bound the generated agent build, preserving other provider-owned Node options. */
export const hostedEveBuildCommand =
  // oxlint-disable-next-line eslint/no-template-curly-in-string -- Preserve this POSIX expansion for the generated Services build shell.
  'NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=2048" node --import ./.config/mise/scripts/repository/assert-hosted-eve-build-budget.mts node_modules/eve/bin/eve.js build';
