import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function previewHostname(value: string | undefined) {
  if (
    value === undefined ||
    !value.endsWith(".vercel.app") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.vercel\.app$/u.test(value)
  )
    return undefined;
  return value;
}

/**
 * Better Auth OAuth state cookies are host-only. Always begin authentication
 * on the stable branch hostname so its canonical callback can consume them,
 * even when a developer entered through an immutable deployment URL.
 */
export function proxy(request: NextRequest) {
  if (
    process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION !== "1" ||
    process.env.VERCEL_ENV !== "preview"
  )
    return NextResponse.next();

  const canonicalHostname = previewHostname(process.env.VERCEL_BRANCH_URL);
  const requestHostname = previewHostname(request.nextUrl.hostname);
  if (
    canonicalHostname === undefined ||
    requestHostname === undefined ||
    requestHostname === canonicalHostname
  )
    return NextResponse.next();

  const destination = request.nextUrl.clone();
  destination.protocol = "https:";
  destination.hostname = canonicalHostname;
  destination.port = "";
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: ["/auth/sign-in", "/auth/sign-up", "/auth/sign-out"],
};
