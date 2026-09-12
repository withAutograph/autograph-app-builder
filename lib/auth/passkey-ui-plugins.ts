// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function passkeyUiPlugins<Plugin>(enabled: boolean, createPlugin: () => Plugin) {
  return enabled ? [createPlugin()] : [];
}
