export const DEFAULT_AUTH_REDIRECT_TO = "/auth/setting-up?callbackURL=%2F";

export type AuthPageSearchParams = Record<
  string,
  string | string[] | undefined
>;

export function serializeAuthPageSearchParams(
  searchParams: AuthPageSearchParams,
) {
  const serialized = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) serialized.append(key, item);
    } else if (value !== undefined) {
      serialized.append(key, value);
    }
  }
  const search = serialized.toString();
  return search ? `?${search}` : "";
}

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
