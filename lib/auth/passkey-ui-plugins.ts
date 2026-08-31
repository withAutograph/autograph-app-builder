export function passkeyUiPlugins<Plugin>(
  enabled: boolean,
  createPlugin: () => Plugin,
) {
  return enabled ? [createPlugin()] : [];
}
