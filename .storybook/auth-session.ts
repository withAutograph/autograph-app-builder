import type { SessionData } from "@better-auth-ui/core";

import { authClient } from "../lib/auth-client";

const fixtureDate = new Date("2026-01-01T00:00:00.000Z");

/**
 * A deterministic response matching Better Auth's `getSession` payload.
 *
 * Storybook must never use a developer's real browser session, but authenticated
 * stories should exercise the same AuthProvider and UserButton code as the app.
 */
export const storybookAuthenticatedSession = {
  session: {
    id: "storybook-session",
    userId: "storybook-user",
    token: "storybook-session-token",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    createdAt: fixtureDate,
    updatedAt: fixtureDate,
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "storybook-user",
    name: "Autograph User",
    email: "storybook-user@example.com",
    emailVerified: true,
    image: null,
    createdAt: fixtureDate,
    updatedAt: fixtureDate,
  },
} satisfies NonNullable<SessionData<typeof authClient>>;
