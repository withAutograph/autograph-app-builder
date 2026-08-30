import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

import type { BuilderProvisionAuthority } from "./journal";

const credentialConfigSchema = z
  .object({
    key: z.instanceof(Buffer).refine((value) => value.length === 32),
    keyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/u),
  })
  .strict();

export type GitHubUserCredentialConfig = z.infer<typeof credentialConfigSchema>;

export function readGitHubUserCredentialEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubUserCredentialConfig {
  return credentialConfigSchema.parse({
    key: Buffer.from(environment.GITHUB_APP_USER_TOKEN_KEY ?? "", "base64"),
    keyVersion: environment.GITHUB_APP_USER_TOKEN_KEY_VERSION,
  });
}

export const githubUserTokenSetSchema = z
  .object({
    accessToken: z.string().min(20).max(512),
    accessTokenExpiresAt: z.string().datetime({ offset: true }).optional(),
    refreshToken: z.string().min(20).max(512).optional(),
    refreshTokenExpiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.accessTokenExpiresAt === undefined) !==
        (value.refreshToken === undefined) ||
      (value.refreshToken === undefined) !==
        (value.refreshTokenExpiresAt === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Expiring GitHub user tokens require a complete refresh set.",
      });
    }
  });

export type GitHubUserTokenSet = z.infer<typeof githubUserTokenSetSchema>;
export type GitHubUserCredential = {
  providerUserId: string;
  providerLogin: string;
  tokens: GitHubUserTokenSet;
  revision: number;
  active: boolean;
  updatedAt: Date;
};

export interface GitHubUserCredentialStore {
  bind(input: {
    authority: BuilderProvisionAuthority;
    providerUserId: string;
    providerLogin: string;
    tokens: GitHubUserTokenSet;
    now: Date;
  }): Promise<GitHubUserCredential>;
  read(input: {
    authority: BuilderProvisionAuthority;
    providerUserId: string;
  }): Promise<GitHubUserCredential | undefined>;
  rotate(input: {
    authority: BuilderProvisionAuthority;
    providerUserId: string;
    expectedRevision: number;
    tokens: GitHubUserTokenSet;
    now: Date;
  }): Promise<GitHubUserCredential | undefined>;
  deactivate(input: {
    authority: BuilderProvisionAuthority;
    providerUserId: string;
    now: Date;
  }): Promise<number>;
}

export function githubCredentialAssociatedData(input: {
  authority: BuilderProvisionAuthority;
  providerUserId: string;
}) {
  return JSON.stringify({
    ...input.authority,
    providerUserId: input.providerUserId,
  });
}

export function encryptGitHubUserTokens(input: {
  tokens: GitHubUserTokenSet;
  key: Buffer;
  associatedData: string;
}) {
  const tokens = githubUserTokenSetSchema.parse(input.tokens);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.associatedData));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return {
    encryptedCredential: encrypted.toString("base64"),
    credentialIv: iv.toString("base64"),
    credentialTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptGitHubUserTokens(input: {
  encryptedCredential: string;
  credentialIv: string;
  credentialTag: string;
  key: Buffer;
  associatedData: string;
}) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    input.key,
    Buffer.from(input.credentialIv, "base64"),
  );
  decipher.setAAD(Buffer.from(input.associatedData));
  decipher.setAuthTag(Buffer.from(input.credentialTag, "base64"));
  return githubUserTokenSetSchema.parse(
    JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(input.encryptedCredential, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as unknown,
  );
}
