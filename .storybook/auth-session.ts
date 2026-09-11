import type { SessionData } from "@better-auth-ui/core";

import type { authClient } from "../lib/auth-client";

const fixtureDate = new Date("2026-01-01T00:00:00.000Z");

/**
 * A deterministic response matching Better Auth's `getSession` payload.
 *
 * Storybook must never use a developer's real browser session, but authenticated
 * stories should exercise the same AuthProvider and UserButton code as the app.
 */
export const storybookAuthenticatedSession = {
  session: {
    createdAt: fixtureDate,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    id: "storybook-session",
    ipAddress: null,
    token: "storybook-session-token",
    updatedAt: fixtureDate,
    userAgent: null,
    userId: "storybook-user",
  },
  user: {
    createdAt: fixtureDate,
    email: "storybook-user@example.com",
    emailVerified: true,
    id: "storybook-user",
    image: null,
    name: "Autograph User",
    updatedAt: fixtureDate,
  },
} satisfies NonNullable<SessionData<typeof authClient>>;
