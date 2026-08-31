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

export function resolvePasskeyRedirectTo(
  redirectTo: string,
  search: string,
  origin: string,
) {
  const searchParams = new URLSearchParams(search);
  const inheritedRedirect = searchParams.get("redirectTo");
  if (inheritedRedirect) {
    return resolveAuthCallbackURL(
      redirectTo,
      `?callbackURL=${encodeURIComponent(inheritedRedirect)}`,
      origin,
    );
  }
  if (!searchParams.has("callbackURL")) return redirectTo;

  const callbackURL = resolveAuthCallbackURL("/", search, origin);
  const resolved = resolveProviderCallbackURL(redirectTo, callbackURL, origin);
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
