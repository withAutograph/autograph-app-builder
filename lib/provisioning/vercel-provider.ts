import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type { GitHubProvisionResult, VercelProvisionResult } from "./contracts";
import { suffixedProviderName } from "./names";
import { runSequentiallyUntilAsync } from "../async-sequential.ts";

const projectSchema = z
  .object({
    framework: z.literal("nextjs"),
    id: z.string().min(1),
    link: z
      .object({
        org: z.string().min(1),
        repo: z.string().min(1),
        type: z.literal("github"),
      })
      .passthrough()
      .optional(),
    name: z.string().min(1),
    rootDirectory: z.string().min(1),
  })
  .passthrough();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function suffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)].map((value) => alphabet[value % alphabet.length]).join("");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function provisionVercelProject(input: {
  installation: VercelInstallationBinding;
  token: string;
  appId: string;
  github: GitHubProvisionResult;
  githubSelected: boolean;
  persistedCandidates: readonly string[];
  persistedAbsentCandidates: readonly string[];
  persistCandidate: (candidate: string) => Promise<void>;
  persistAbsent: (candidate: string) => Promise<void>;
  renewLease?: () => Promise<void>;
  recordRetryAfter?: (milliseconds: number) => void;
  fetch?: typeof fetch;
  generateSuffix?: () => string;
}): Promise<VercelProvisionResult> {
  if (input.githubSelected && input.github.status !== "succeeded") {
    return { code: "github_required", retryable: false, status: "skipped" };
  }
  const request = input.fetch ?? fetch;
  const query =
    input.installation.scopeType === "team"
      ? `?teamId=${encodeURIComponent(input.installation.scopeId)}`
      : "";

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function vercel(args: {
    method?: "GET" | "POST";
    path: string;
    body?: unknown;
    expected: readonly number[];
  }) {
    if (args.method === "POST") {
      await input.renewLease?.();
    }
    let response: Response;
    try {
      response = await request(`https://api.vercel.com${args.path}${query}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          "User-Agent": "autograph-app-builder-provisioning",
        },
        method: args.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      });
    } catch {
      throw new Error("provider-unavailable");
    }
    let body: unknown;
    try {
      body = response.body === null ? undefined : await response.json();
    } catch {
      throw new Error("invalid-response");
    }
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      const milliseconds = Number.isFinite(seconds)
        ? Math.ceil(seconds * 1000)
        : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(milliseconds) && milliseconds >= 0) {
        input.recordRetryAfter?.(milliseconds);
      }
    }
    if (response.status === 401) {
      throw new Error("credential-rejected");
    }
    if (!args.expected.includes(response.status)) {
      if (response.status === 429) {
        throw new Error("provider-rate-limited");
      }
      if (response.status === 403) {
        throw new Error("provider-permission-denied");
      }
      throw new Error(`vercel-status-${response.status}`);
    }
    return { body, status: response.status };
  }

  // eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
  async function inspect(name: string) {
    return vercel({
      expected: [200, 404],
      path: `/v9/projects/${encodeURIComponent(name)}`,
    });
  }

  const baseName = `apps-${input.appId}`;
  const linkedRepository = input.github.status === "succeeded" ? input.github.fullName : undefined;
  const candidates = async function* candidates(): AsyncGenerator<string> {
    const seen = new Set<string>();
    for (const candidate of input.persistedCandidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        yield candidate;
      }
    }
    for (;;) {
      const candidate =
        seen.size === 0
          ? baseName
          : suffixedProviderName({
              base: baseName,
              maximumLength: 100,
              suffix: (input.generateSuffix ?? suffix)(),
            });
      if (seen.has(candidate)) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- each candidate must be durably recorded before the next provider operation.
      await input.persistCandidate(candidate);
      seen.add(candidate);
      yield candidate;
    }
  };
  try {
    const result = await runSequentiallyUntilAsync<string, VercelProvisionResult>(
      candidates(),
      async (candidate) => {
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const before = await inspect(candidate);
        const wasAbsent = input.persistedAbsentCandidates.includes(candidate);
        if (before.status === 200 && !wasAbsent) {
          return null;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        if (before.status === 404 && !wasAbsent) {
          await input.persistAbsent(candidate);
        }
        if (before.status === 404) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          const created = await vercel({
            body: {
              framework: "nextjs",
              name: candidate,
              rootDirectory: `apps/${input.appId}`,
              ...(linkedRepository
                ? {
                    gitRepository: {
                      repo: linkedRepository,
                      type: "github",
                    },
                  }
                : {}),
            },
            expected: [200, 201, 400, 403, 409, 429],
            method: "POST",
            path: "/v11/projects",
          });
          if (created.status === 400 || created.status === 403 || created.status === 429) {
            let code:
              | "provider_validation_failed"
              | "provider_permission_denied"
              | "provider_rate_limited" = "provider_validation_failed";
            if (created.status === 403) {
              code = "provider_permission_denied";
            } else if (created.status === 429) {
              code = "provider_rate_limited";
            }
            return {
              code,
              retryable: created.status === 429,
              status: "failed",
            };
          }
          if (created.status === 409) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
            const recovered = await inspect(candidate);
            if (recovered.status !== 200) {
              const collision = z
                .object({
                  error: z.object({
                    code: z.enum(["project_already_exists", "name_already_exists"]),
                  }),
                })
                .safeParse(created.body).success;
              return collision
                ? null
                : { code: "provider_rejected", retryable: false, status: "failed" };
            }
          }
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const observed = await inspect(candidate);
        if (observed.status !== 200) {
          return {
            code: "postcondition_failed",
            retryable: false,
            status: "failed",
          };
        }
        const project = projectSchema.parse(observed.body);
        if (
          project.name !== candidate ||
          project.rootDirectory !== `apps/${input.appId}` ||
          (linkedRepository !== undefined &&
            `${project.link?.org}/${project.link?.repo}` !== linkedRepository) ||
          (linkedRepository === undefined && project.link !== undefined)
        ) {
          return {
            code: "postcondition_failed",
            retryable: false,
            status: "failed",
          };
        }
        return {
          dashboardUrl: `https://vercel.com/${input.installation.slug}/${project.name}`,
          framework: "nextjs",
          installationId: input.installation.installationId,
          name: project.name,
          projectId: project.id,
          rootDirectory: project.rootDirectory,
          scope: {
            id: input.installation.scopeId,
            slug: input.installation.slug,
            type: input.installation.scopeType,
          },
          status: "succeeded",
          ...(linkedRepository ? { linkedGitHubRepository: linkedRepository } : {}),
        };
      },
    );
    return result ?? { code: "provider_unavailable", retryable: true, status: "failed" };
  } catch (error) {
    if (error instanceof Error && error.message === "provider-rate-limited") {
      return { code: "provider_rate_limited", retryable: true, status: "failed" };
    }
    if (error instanceof Error && error.message === "provider-permission-denied") {
      return { code: "provider_permission_denied", retryable: false, status: "failed" };
    }
    return {
      code:
        error instanceof Error && error.message === "credential-rejected"
          ? "credential_unavailable"
          : "provider_unavailable",
      retryable: true,
      status: "failed",
    };
  }
}
