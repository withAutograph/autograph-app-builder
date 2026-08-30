export function resolveAuthCallbackURL(
  defaultURL: string,
  search: string,
  sameOrigin?: string,
) {
  const callbackURL = new URLSearchParams(search).get("callbackURL");
  if (!callbackURL) return defaultURL;

  try {
    const parsed = new URL(callbackURL, "https://autograph.invalid");
    const isRootRelative =
      callbackURL.startsWith("/") && !callbackURL.startsWith("//");
    const isSameOriginAbsolute =
      sameOrigin !== undefined && parsed.origin === sameOrigin;
    if (!isRootRelative && !isSameOriginAbsolute) return defaultURL;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return defaultURL;
  }
}

export function resolveProviderCallbackURL(
  redirectTo: string,
  callbackURL: string,
  origin: string,
) {
  const providerCallbackURL = new URL(redirectTo, origin);
  providerCallbackURL.searchParams.set("callbackURL", callbackURL);
  return providerCallbackURL;
}
