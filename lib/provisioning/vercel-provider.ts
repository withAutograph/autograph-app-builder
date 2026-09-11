import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type { GitHubProvisionResult, VercelProvisionResult } from "./contracts";
import { suffixedProviderName } from "./names";

const projectSchema = z
  .object({
    framework: z.literal("nextjs"),
    id: z.string().min(1),
    link: z
      .object({
        type: z.literal("github"),
        repo: z.string().min(1),
        org: z.string().min(1),
      })
      .passthrough()
      .optional(),
    name: z.string().min(1),
    rootDirectory: z.string().min(1),
  })
  .passthrough();

function suffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)]
    .map((value) => alphabet[value % alphabet.length])
    .join("");
}

export async function provisionVercelProject(input: {
  installation: VercelInstallationBinding;
  token: string;
  appId: string;
  github: GitHubProvisionResult;
  githubSelected: boolean;
  persistedCandidates: readonly string[];
  persistedAbsentCandidates: readonly string[];
  persistCandidate(candidate: string): Promise<void>;
  persistAbsent(candidate: string): Promise<void>;
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

  async function vercel(args: {
    method?: "GET" | "POST";
    path: string;
    body?: unknown;
    expected: readonly number[];
  }) {
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 2 * 1024 * 1024) {
      throw new Error("invalid-response");
    }
    let body: unknown;
    try {
      body = bytes.byteLength
        ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        : undefined;
    } catch {
      throw new Error("invalid-response");
    }
    if (response.status === 401) {
      throw new Error("credential-rejected");
    }
    if (!args.expected.includes(response.status)) {
      throw new Error(`vercel-status-${response.status}`);
    }
    return { body, status: response.status };
  }

  async function inspect(name: string) {
    return vercel({
      expected: [200, 404],
      path: `/v9/projects/${encodeURIComponent(name)}`,
    });
  }

  const baseName = `apps-${input.appId}`;
  const linkedRepository =
    input.github.status === "succeeded" ? input.github.fullName : undefined;
  try {
    const candidates = [...input.persistedCandidates];
    for (
      let generated = 0;
      candidates.length < 5 && generated < 20;
      generated += 1
    ) {
      const candidate =
        candidates.length === 0
          ? baseName
          : suffixedProviderName({
              base: baseName,
              maximumLength: 100,
              suffix: (input.generateSuffix ?? suffix)(),
            });
      if (candidates.includes(candidate)) {
        continue;
      }
      await input.persistCandidate(candidate);
      candidates.push(candidate);
    }
    for (const candidate of candidates.slice(0, 5)) {
      const before = await inspect(candidate);
      const wasAbsent = input.persistedAbsentCandidates.includes(candidate);
      if (before.status === 200 && !wasAbsent) {
        continue;
      }
      if (before.status === 404 && !wasAbsent) {
        await input.persistAbsent(candidate);
      }
      if (before.status === 404) {
        const created = await vercel({
          body: {
            framework: "nextjs",
            name: candidate,
            rootDirectory: `apps/${input.appId}`,
            ...(linkedRepository
              ? {
                  gitRepository: {
                    type: "github",
                    repo: linkedRepository,
                  },
                }
              : {}),
          },
          expected: [200, 201, 400, 403, 409],
          method: "POST",
          path: "/v11/projects",
        });
        if (created.status === 400 || created.status === 403) {
          return {
            code: "provider_rejected",
            retryable: true,
            status: "failed",
          };
        }
        if (created.status === 409) {
          const recovered = await inspect(candidate);
          if (recovered.status !== 200) {
            continue;
          }
        }
      }
      const observed = await inspect(candidate);
      if (observed.status !== 200) {
        return {
          status: "failed",
          code: "postcondition_failed",
          retryable: false,
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
          status: "failed",
          code: "postcondition_failed",
          retryable: false,
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
        ...(linkedRepository
          ? { linkedGitHubRepository: linkedRepository }
          : {}),
      };
    }
    return { code: "name_conflict", retryable: true, status: "failed" };
  } catch (error) {
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
