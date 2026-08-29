export function resolveAuthCallbackURL(defaultURL: string, search: string) {
  const callbackURL = new URLSearchParams(search).get("callbackURL");
  if (!callbackURL) return defaultURL;
  if (!callbackURL.startsWith("/") || callbackURL.startsWith("//")) {
    return defaultURL;
  }

  try {
    const parsed = new URL(callbackURL, "https://autograph.invalid");
    if (parsed.origin !== "https://autograph.invalid") return defaultURL;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return defaultURL;
  }
}
