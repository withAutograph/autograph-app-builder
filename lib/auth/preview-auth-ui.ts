export function resolveAuthCallbackURL(defaultURL: string, search: string) {
  return new URLSearchParams(search).get("callbackURL") || defaultURL;
}
