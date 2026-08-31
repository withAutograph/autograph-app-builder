import postgres from "postgres";
import { expect, test, type Page } from "playwright/test";

import { VirtualAuthenticator } from "./virtual-authenticator";
import {
  applicationCounts as authCounts,
  currentSession,
  databaseUrl,
  finishOAuth,
  registerPasskey,
  resetApplicationState,
  signOut,
} from "../support/harness";

const onboardingAlreadyAuthenticatedCode =
  "PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED";

const emptyAuthCounts = {
  users: 0,
  passkeys: 0,
  organizations: 0,
  members: 0,
  sessions: 0,
  activeSessions: 0,
  passkeyOnboardingContexts: 0,
  githubInstallations: 0,
  vercelInstallations: 0,
};

async function onboardingContextIds() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM passkey_onboarding ORDER BY id
    `;
    return rows.map(({ id }) => id);
  } finally {
    await sql.end();
  }
}

async function expireOnboardingContexts() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      UPDATE passkey_onboarding
      SET
        created_at = now() - interval '2 minutes',
        expires_at = now() - interval '1 minute'
    `;
  } finally {
    await sql.end();
  }
}

function reportPasskeyFailures(page: Page) {
  page.on("response", async (response) => {
    if (
      response.ok() ||
      !new URL(response.url()).pathname.startsWith("/api/auth/passkey/")
    ) {
      return;
    }
    const body = await response.text().catch(() => undefined);
    if (body === undefined) return;
    console.error(
      "passkey request failed",
      response.status(),
      new URL(response.url()).pathname,
      body,
    );
  });
}

test.beforeEach(async () => resetApplicationState());

test("Sign In and Sign Up are passive, reciprocal, and geometrically identical", async ({
  page,
}) => {
  const callbackURL = "/dashboard?tab=recent&tab=saved#complete";
  let passkeyRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/auth/passkey/")) {
      passkeyRequests += 1;
    }
  });

  await page.goto(
    `/auth/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`,
  );
  const signInCard = page.locator('[data-slot="card"]');
  const signInCardBox = await signInCard.boundingBox();
  const signUpLink = page.getByRole("link", { name: "Sign Up" });
  await expect(page.getByText("Need to create an account?")).toBeVisible();
  await expect(signUpLink).toBeVisible();
  const signUpHref = await signUpLink.getAttribute("href");

  expect(passkeyRequests).toBe(0);
  expect(await authCounts()).toEqual(emptyAuthCounts);

  await signUpLink.click();
  await expect(page).toHaveURL(/\/auth\/sign-up/u);
  const signUpCard = page.locator('[data-slot="card"]');
  const signUpCardBox = await signUpCard.boundingBox();
  const signInLink = page.getByRole("link", { name: "Sign In" });
  await expect(page.getByText("Already have an account?")).toBeVisible();
  await expect(signInLink).toBeVisible();
  expect(signUpCardBox).toEqual(signInCardBox);
  expect(passkeyRequests).toBe(0);
  expect(await authCounts()).toEqual(emptyAuthCounts);

  const signUpURL = new URL(signUpHref!, page.url());
  expect(signUpURL.searchParams.get("redirectTo")).toBe(
    "/auth/setting-up?callbackURL=%2Fdashboard%3Ftab%3Drecent%26tab%3Dsaved%23complete",
  );
  const signInURL = new URL(
    (await signInLink.getAttribute("href"))!,
    page.url(),
  );
  expect(signInURL.searchParams.get("redirectTo")).toBe(
    signUpURL.searchParams.get("redirectTo"),
  );
});

test("a sign-in challenge failure stays local without invoking WebAuthn", async ({
  page,
}) => {
  let credentialRequests = 0;
  await page.addInitScript(() => {
    const credentials = navigator.credentials;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        ...credentials,
        get: async () => {
          window.dispatchEvent(new Event("e2e-credential-request"));
          return null;
        },
      },
    });
  });
  await page.exposeFunction("recordCredentialRequest", () => {
    credentialRequests += 1;
  });
  await page.addInitScript(() => {
    window.addEventListener("e2e-credential-request", () => {
      void (
        window as typeof window & {
          recordCredentialRequest: () => Promise<void>;
        }
      ).recordCredentialRequest();
    });
  });
  await page.route(
    "**/api/auth/passkey/generate-authenticate-options*",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "CHALLENGE_UNAVAILABLE" }),
      }),
  );

  await page.goto("/auth/sign-in");
  await page.getByRole("button", { name: "Continue with Passkey" }).click();

  await expect(
    page.getByRole("button", { name: "Passkey failed (try again)" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
  expect(credentialRequests).toBe(0);
  expect(await authCounts()).toEqual(emptyAuthCounts);
});

for (const exceptionName of ["NotSupportedError", "SecurityError"] as const) {
  test(`a pre-assertion ${exceptionName} stays on Sign In without writes`, async ({
    page,
  }) => {
    let verificationRequests = 0;
    await page.addInitScript((name) => {
      const credentials = navigator.credentials;
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: {
          ...credentials,
          get: async () => {
            throw new DOMException("WebAuthn unavailable", name);
          },
        },
      });
    }, exceptionName);
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/auth/passkey/verify-authentication"
      ) {
        verificationRequests += 1;
      }
    });

    await page.goto("/auth/sign-in");
    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-in/u);
    await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
    expect(verificationRequests).toBe(0);
    expect(await authCounts()).toEqual(emptyAuthCounts);
  });
}

test("passkey registration guards Sign Up and supports returning login", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.addInitScript(() => {
      if (!window.PublicKeyCredential) return;
      Object.defineProperty(
        window.PublicKeyCredential,
        "isUserVerifyingPlatformAuthenticatorAvailable",
        { configurable: true, value: async () => true },
      );
    });
    await page.goto("/auth/sign-up");
    const registrationOptionsRequest = page.waitForRequest(
      /\/api\/auth\/passkey\/generate-register-options(?:\?|$)/u,
    );
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    expect(
      new URL((await registrationOptionsRequest).url()).searchParams.get(
        "authenticatorAttachment",
      ),
    ).toBe("platform");
    await expect
      .poll(() => authCounts(), { timeout: 30_000 })
      .toEqual({
        users: 1,
        passkeys: 1,
        organizations: 1,
        members: 1,
        sessions: 1,
        activeSessions: 1,
        passkeyOnboardingContexts: 0,
        githubInstallations: 0,
        vercelInstallations: 0,
      });
    expect(await authenticator.credentials()).toHaveLength(1);
    const registeredCounts = await authCounts();
    const deviceCredentials = await authenticator.credentials();
    let onboardingRequests = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/auth/passkey/onboarding-context"
      ) {
        onboardingRequests += 1;
      }
    });

    await page.goto(
      `/auth/sign-up?callbackURL=${encodeURIComponent(
        "/?source=signed-in#complete",
      )}`,
    );
    await expect(page).toHaveURL(/\/\?source=signed-in#complete$/u);
    await expect(
      page.getByRole("button", { name: "Continue with Passkey" }),
    ).toHaveCount(0);
    expect(onboardingRequests).toBe(0);
    expect(await authCounts()).toEqual(registeredCounts);
    expect(await authenticator.credentials()).toEqual(deviceCredentials);

    await signOut(page);
    await page.goto(
      `/auth/sign-in?callbackURL=${encodeURIComponent(
        "/?source=returning#complete",
      )}`,
    );
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect(page).toHaveURL(/\/\?source=returning#complete$/u);
    await expect
      .poll(async () =>
        (await page.request.get("/api/auth/get-session")).json(),
      )
      .toMatchObject({ user: { emailVerified: false } });
    expect(await authCounts()).toEqual(registeredCounts);
    expect(await authenticator.credentials()).toHaveLength(1);
  } finally {
    await authenticator.dispose();
  }
});

test("passkey registration keeps the alternate authenticator flow when platform detection fails", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  await page.addInitScript(() => {
    if (!window.PublicKeyCredential) return;
    Object.defineProperty(
      window.PublicKeyCredential,
      "isUserVerifyingPlatformAuthenticatorAvailable",
      {
        configurable: true,
        value: async () => {
          throw new DOMException("Unavailable", "NotSupportedError");
        },
      },
    );
  });
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.goto("/auth/sign-up");
    const registrationOptionsRequest = page.waitForRequest(
      /\/api\/auth\/passkey\/generate-register-options(?:\?|$)/u,
    );
    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    expect(
      new URL((await registrationOptionsRequest).url()).searchParams.has(
        "authenticatorAttachment",
      ),
    ).toBe(false);
    await expect
      .poll(async () => (await authCounts()).passkeys, { timeout: 30_000 })
      .toBe(1);
    expect(await authenticator.credentials()).toHaveLength(1);
  } finally {
    await authenticator.dispose();
  }
});

test("permanent Sign Up link preserves the callback after missing credentials", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    let authenticationVerificationRequests = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/auth/passkey/verify-authentication"
      ) {
        authenticationVerificationRequests += 1;
      }
    });
    const callbackURL = "/?source=brief#complete";
    await page.goto(
      `/auth/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`,
    );
    const signInCard = page.locator('[data-slot="card"]');
    const signUpLink = page.getByRole("link", { name: "Sign Up" });
    await expect(page.getByText("Need to create an account?")).toBeVisible();
    await expect(signUpLink).toBeVisible();
    const [cardBeforeFailure, signUpBeforeFailure] = await Promise.all([
      signInCard.boundingBox(),
      signUpLink.boundingBox(),
    ]);
    expect(signUpBeforeFailure?.y).toBeGreaterThanOrEqual(
      (cardBeforeFailure?.y ?? 0) + (cardBeforeFailure?.height ?? 0),
    );
    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(page).toHaveURL(/\/auth\/sign-in/u);
    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(signUpLink).toBeVisible();
    const [cardAfterFailure, signUpAfterFailure] = await Promise.all([
      signInCard.boundingBox(),
      signUpLink.boundingBox(),
    ]);
    expect(cardBeforeFailure).not.toBeNull();
    expect(cardAfterFailure).toEqual(cardBeforeFailure);
    expect(signUpAfterFailure).toEqual(signUpBeforeFailure);
    expect(authenticationVerificationRequests).toBe(0);
    expect(await authCounts()).toEqual({
      users: 0,
      passkeys: 0,
      organizations: 0,
      members: 0,
      sessions: 0,
      activeSessions: 0,
      passkeyOnboardingContexts: 0,
      githubInstallations: 0,
      vercelInstallations: 0,
    });

    await signUpLink.click();
    await expect(page).toHaveURL(/\/auth\/sign-up/u);
    await expect(page.locator('[data-slot="card"]')).toHaveCount(1);
    expect(await page.locator('[data-slot="card"]').boundingBox()).toEqual(
      cardBeforeFailure,
    );
    await expect(
      page.getByText(
        "We couldn’t use an existing passkey. Continue to create a new one.",
      ),
    ).toHaveCount(0);
    const signUpURL = new URL(page.url());
    expect(signUpURL.searchParams.has("passkey")).toBe(false);
    expect(signUpURL.searchParams.get("redirectTo")).toBe(
      "/auth/setting-up?callbackURL=%2F%3Fsource%3Dbrief%23complete",
    );
    await expect(page.getByText("Already have an account?")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign In" })).toHaveAttribute(
      "href",
      "/auth/sign-in?redirectTo=%2Fauth%2Fsetting-up%3FcallbackURL%3D%252F%253Fsource%253Dbrief%2523complete",
    );
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect(page).toHaveURL(/\?source=brief#complete$/u);
    expect(await authCounts()).toMatchObject({
      users: 1,
      passkeys: 1,
      organizations: 1,
      members: 1,
      activeSessions: 1,
    });
  } finally {
    await authenticator.dispose();
  }
});

test("an interrupted passkey ceremony keeps the permanent Sign Up link", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const credentials = navigator.credentials;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        ...credentials,
        get: async () => {
          throw new DOMException(
            "The operation was cancelled.",
            "NotAllowedError",
          );
        },
      },
    });
  });
  await page.goto("/auth/sign-in");
  const signUpLink = page.getByRole("link", { name: "Sign Up" });
  await expect(signUpLink).toBeVisible();
  await page.getByRole("button", { name: "Continue with Passkey" }).click();
  await expect(
    page.getByRole("button", { name: "Passkey failed (try again)" }),
  ).toBeVisible();
  await expect(signUpLink).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
  expect(await authCounts()).toMatchObject({
    users: 0,
    passkeys: 0,
    organizations: 0,
    members: 0,
    sessions: 0,
    passkeyOnboardingContexts: 0,
  });
});

test("cancelled passkey registration stays on Sign Up without partial state", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const credentials = navigator.credentials;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        ...credentials,
        create: async () => {
          throw new DOMException(
            "The operation was cancelled.",
            "NotAllowedError",
          );
        },
      },
    });
  });
  await page.goto("/auth/sign-up");
  await page.getByRole("button", { name: "Continue with Passkey" }).click();
  await expect(
    page.getByRole("button", { name: "Passkey failed (try again)" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/sign-up/u);
  const firstContextIds = await onboardingContextIds();
  expect(await authCounts()).toMatchObject({
    users: 0,
    passkeys: 0,
    organizations: 0,
    members: 0,
    sessions: 0,
    activeSessions: 0,
    passkeyOnboardingContexts: 1,
  });
  expect(firstContextIds).toHaveLength(1);

  await expireOnboardingContexts();
  await page
    .getByRole("button", { name: "Passkey failed (try again)" })
    .click();
  await expect(
    page.getByRole("button", { name: "Passkey failed (try again)" }),
  ).toBeVisible();
  const replacementContextIds = await onboardingContextIds();
  expect(replacementContextIds).toHaveLength(1);
  expect(replacementContextIds).not.toEqual(firstContextIds);
  expect(await authCounts()).toMatchObject({
    users: 0,
    passkeys: 0,
    organizations: 0,
    members: 0,
    sessions: 0,
    passkeyOnboardingContexts: 1,
  });
});

for (const contextFailure of [
  { name: "forbidden", status: 403 },
  { name: "unavailable", status: 503 },
] as const) {
  test(`a ${contextFailure.name} onboarding-context response stays on Sign Up without partial state`, async ({
    page,
  }) => {
    let registrationOptionsRequests = 0;
    await page.route("**/api/auth/passkey/onboarding-context", (route) =>
      route.fulfill({
        status: contextFailure.status,
        contentType: "application/json",
        body: JSON.stringify({ code: "ONBOARDING_CONTEXT_UNAVAILABLE" }),
      }),
    );
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/auth/passkey/generate-register-options"
      ) {
        registrationOptionsRequests += 1;
      }
    });

    await page.goto("/auth/sign-up");
    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-up/u);
    await expect(page.getByRole("link", { name: "Sign In" })).toBeVisible();
    expect(registrationOptionsRequests).toBe(0);
    expect(await authCounts()).toEqual(emptyAuthCounts);
  });
}

test("a registration-options failure retains only its bounded onboarding context", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.route(
      "**/api/auth/passkey/generate-register-options*",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "CHALLENGE_UNAVAILABLE" }),
        }),
    );

    await page.goto("/auth/sign-up");
    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-up/u);
    expect(await authenticator.credentials()).toHaveLength(0);
    expect(await authCounts()).toEqual({
      ...emptyAuthCounts,
      passkeyOnboardingContexts: 1,
    });
  } finally {
    await authenticator.dispose();
  }
});

test("verification transport loss stays on Sign In after an assertion", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await registerPasskey(context, page);
  try {
    await signOut(page);
    const baseline = await authCounts();
    let authenticationVerificationRequests = 0;
    await page.route("**/api/auth/passkey/verify-authentication", (route) => {
      authenticationVerificationRequests += 1;
      return route.abort("failed");
    });

    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-in/u);
    await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
    expect(authenticationVerificationRequests).toBe(1);
    expect(await authCounts()).toEqual(baseline);
  } finally {
    await authenticator.dispose();
  }
});

test("server rejection after an assertion stays on Sign In without changing identity state", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await registerPasskey(context, page);
  try {
    await signOut(page);
    const baseline = await authCounts();
    let verificationRequests = 0;
    await page.route("**/api/auth/passkey/verify-authentication", (route) => {
      verificationRequests += 1;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "INVALID_PASSKEY" }),
      });
    });

    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-in/u);
    await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
    expect(verificationRequests).toBe(1);
    expect(await authCounts()).toEqual(baseline);
    expect(await currentSession(page)).toBeNull();
  } finally {
    await authenticator.dispose();
  }
});

test("a session created after Sign Up renders blocks context issuance", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await registerPasskey(context, page);
  const staleSignUpPage = await context.newPage();
  try {
    await signOut(page);
    await staleSignUpPage.goto(
      `/auth/sign-up?callbackURL=${encodeURIComponent(
        "/?source=context-race#complete",
      )}`,
    );

    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect
      .poll(() => currentSession(page))
      .toMatchObject({ user: { id: expect.any(String) } });
    const baseline = await authCounts();
    const deviceCredentials = await authenticator.credentials();

    const responsePromise = staleSignUpPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/api/auth/passkey/onboarding-context",
    );
    await staleSignUpPage
      .getByRole("button", { name: "Continue with Passkey" })
      .click();
    const response = await responsePromise;

    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({
      code: onboardingAlreadyAuthenticatedCode,
    });
    await expect(staleSignUpPage).toHaveURL(
      /\/\?source=context-race#complete$/u,
    );
    expect(await authCounts()).toEqual(baseline);
    expect(await authenticator.credentials()).toEqual(deviceCredentials);
  } finally {
    await staleSignUpPage.close();
    await authenticator.dispose();
  }
});

test("a session created after context issuance blocks registration", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  let releaseOptionsResponse = () => {};
  const optionsResponseMayContinue = new Promise<void>((resolve) => {
    releaseOptionsResponse = resolve;
  });
  let markOptionsGenerated = () => {};
  const optionsGenerated = new Promise<void>((resolve) => {
    markOptionsGenerated = resolve;
  });
  let sessionPage: Page | undefined;

  try {
    await page.route(
      /\/api\/auth\/passkey\/generate-register-options(?:\?|$)/u,
      async (route) => {
        const response = await route.fetch();
        markOptionsGenerated();
        await optionsResponseMayContinue;
        await route.fulfill({ response });
      },
    );
    await page.goto(
      `/auth/sign-up?callbackURL=${encodeURIComponent(
        "/?source=verification-race#complete",
      )}`,
    );
    const clickPromise = page
      .getByRole("button", { name: "Continue with Passkey" })
      .click();
    await optionsGenerated;

    sessionPage = await context.newPage();
    await finishOAuth(sessionPage, "GitHub");
    const baseline = await authCounts();
    expect(baseline.passkeyOnboardingContexts).toBe(1);

    const verificationResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/api/auth/passkey/verify-registration",
    );
    releaseOptionsResponse();
    await clickPromise;
    const verificationResponse = await verificationResponsePromise;

    expect(verificationResponse.status()).toBe(409);
    expect(await verificationResponse.json()).toMatchObject({
      code: onboardingAlreadyAuthenticatedCode,
    });
    await expect(page).toHaveURL(/\/\?source=verification-race#complete$/u);
    expect(await authCounts()).toEqual(baseline);
    expect(await authenticator.credentials()).toHaveLength(1);
    expect((await authCounts()).passkeys).toBe(0);
  } finally {
    releaseOptionsResponse();
    await sessionPage?.close();
    await authenticator.dispose();
  }
});

test("a final persistence failure rolls back registration state", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(
      'DROP TRIGGER IF EXISTS "fail_passkey_session_insert" ON "session"',
    );
    await sql.unsafe("DROP FUNCTION IF EXISTS fail_passkey_session_insert()");
    await sql.unsafe(`
      CREATE FUNCTION fail_passkey_session_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'forced passkey session failure';
      END;
      $$
    `);
    await sql.unsafe(`
      CREATE TRIGGER fail_passkey_session_insert
      BEFORE INSERT ON "session"
      FOR EACH ROW
      EXECUTE FUNCTION fail_passkey_session_insert()
    `);

    await page.goto("/auth/sign-up");
    await page.getByRole("button", { name: "Continue with Passkey" }).click();

    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-up/u);
    expect(await authenticator.credentials()).toHaveLength(1);
    expect(await authCounts()).toMatchObject({
      users: 0,
      passkeys: 0,
      organizations: 0,
      members: 0,
      sessions: 0,
      activeSessions: 0,
      passkeyOnboardingContexts: 1,
    });
    expect(await currentSession(page)).toBeNull();
  } finally {
    await sql.unsafe(
      'DROP TRIGGER IF EXISTS "fail_passkey_session_insert" ON "session"',
    );
    await sql.unsafe("DROP FUNCTION IF EXISTS fail_passkey_session_insert()");
    await sql.end();
    await authenticator.dispose();
  }
});

test("an authenticator credential missing from server storage is not recreated", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.goto("/auth/sign-up");
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect
      .poll(async () => (await authCounts()).passkeys, { timeout: 30_000 })
      .toBe(1);
    await signOut(page);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`DELETE FROM passkey`;
    } finally {
      await sql.end();
    }
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
    expect((await authCounts()).passkeys).toBe(0);
    expect((await authCounts()).users).toBe(1);
  } finally {
    await authenticator.dispose();
  }
});

for (const provider of ["GitHub", "Vercel"] as const) {
  test(`${provider} Emulate completes OAuth provisioning and returning login`, async ({
    page,
  }) => {
    await finishOAuth(page, provider);
    expect(await authCounts()).toMatchObject({
      users: 1,
      organizations: 1,
      members: 1,
      activeSessions: 1,
    });
    await signOut(page);
    await finishOAuth(page, provider);
    expect((await authCounts()).users).toBe(1);
  });
}

test("provider account supports multiple passkeys but retains its final passkey", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  let authenticator: VirtualAuthenticator | undefined =
    await VirtualAuthenticator.create(context, page);
  try {
    await finishOAuth(page, "GitHub");
    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Add passkey" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("OAuth recovery passkey");
    const settingsRegistrationOptionsRequest = page.waitForRequest(
      /\/api\/auth\/passkey\/generate-register-options(?:\?|$)/u,
    );
    await dialog.getByRole("button", { name: "Add passkey" }).click();
    expect(
      new URL(
        (await settingsRegistrationOptionsRequest).url(),
      ).searchParams.has("authenticatorAttachment"),
    ).toBe(false);
    await expect.poll(async () => (await authCounts()).passkeys).toBe(1);
    await expect(dialog).toBeHidden();

    // Chromium permits only one internal authenticator per browser context.
    // Removing the first authenticator models switching to a second device
    // while retaining the first credential in Better Auth's real database.
    await authenticator.dispose();
    authenticator = await VirtualAuthenticator.create(context, page);
    await page.getByRole("button", { name: "Add passkey" }).first().click();
    await dialog.getByLabel("Name").fill("Second passkey");
    await dialog.getByRole("button", { name: "Add passkey" }).click();
    await expect.poll(async () => (await authCounts()).passkeys).toBe(2);

    const list = await page.request.get("/api/auth/passkey/list-user-passkeys");
    expect(list.ok()).toBeTruthy();
    const credentials = (await list.json()) as Array<{ id: string }>;
    expect(credentials).toHaveLength(2);
    const deletePasskey = (id: string) =>
      page.evaluate(async (passkeyId) => {
        const response = await fetch("/api/auth/passkey/delete-passkey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: passkeyId }),
        });
        return { ok: response.ok, status: response.status };
      }, id);
    expect((await deletePasskey(credentials[0].id)).ok).toBeTruthy();
    expect(await deletePasskey(credentials[1].id)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect((await authCounts()).passkeys).toBe(1);
  } finally {
    await authenticator?.dispose();
  }
});
