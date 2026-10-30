import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-contract";
import {
  createNativeTargetVercelProject,
  observeNativeTargetVercelProject,
} from "./native-target-vercel-provider";

const installation: VercelInstallationBinding = {
  active: true,
  displayName: "Owned team",
  installationId: "installation-one",
  plan: "pro",
  scopeId: "team-owned",
  scopeType: "team",
  slug: "owned-team",
  updatedAt: new Date(0),
};
const settings = {
  buildCommand: null,
  framework: null,
  rootDirectory: "apps/spend-review",
  sourceFilesOutsideRootDirectory: true,
};
const name = "spend-review-requests";
const token = "synthetic-secret-token";
const project = {
  accountId: installation.scopeId,
  buildCommand: null,
  framework: null,
  id: "prj-owned",
  name,
  rootDirectory: settings.rootDirectory,
  sourceFilesOutsideRootDirectory: true,
  ssoProtection: nativeTargetRequiredProjectProtection.ssoProtection,
  oidcTokenConfig: nativeTargetRequiredProjectProtection.oidcTokenConfig,
};

type MockPayload = typeof project | { id: string } | { error: { code: string } };
const json = (value: MockPayload, status = 200): Response => Response.json(value, { status });

const fixture = () => {
  const order: string[] = [];
  const authorizeAttempt = vi.fn(() => {
    order.push("journal");
    return Promise.resolve();
  });
  const acceptProjectId = vi.fn((_projectId: string) => {
    order.push("receipt");
    return Promise.resolve();
  });
  const request = vi.fn<typeof fetch>((_url, options) => {
    order.push(options?.method ?? "GET");
    return Promise.resolve(
      options?.method === "POST" ? json({ id: project.id }, 201) : json(project),
    );
  });
  return {
    acceptProjectId,
    authorizeAttempt,
    input: {
      installation,
      token,
      name,
      settings,
      protection: nativeTargetRequiredProjectProtection,
      authorizeAttempt,
      acceptProjectId,
      fetch: request,
    },
    order,
    request,
  };
};

describe("native target Vercel project provider", () => {
  it("accepts provider defaults for omitted source settings while verifying the exact root and protection", async () => {
    const f = fixture();
    const rootOnly = { rootDirectory: "apps/spend-review" };
    f.request.mockResolvedValueOnce(json({ id: project.id }, 201));
    f.request.mockResolvedValueOnce(
      Response.json({
        ...project,
        buildCommand: null,
        framework: null,
        sourceFilesOutsideRootDirectory: true,
      }),
    );
    expect(await createNativeTargetVercelProject({ ...f.input, settings: rootOnly })).toEqual({
      name,
      projectId: project.id,
      scopeId: installation.scopeId,
      settings: rootOnly,
      protection: nativeTargetRequiredProjectProtection,
      status: "verified",
    });
    const createOptions = f.request.mock.calls[0]?.[1];
    expect(createOptions?.body).toBe(
      JSON.stringify({
        name,
        rootDirectory: rootOnly.rootDirectory,
        ssoProtection: nativeTargetRequiredProjectProtection.ssoProtection,
        oidcTokenConfig: nativeTargetRequiredProjectProtection.oidcTokenConfig,
      }),
    );
    expect(f.order).toEqual(["journal", "receipt"]);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      requested: { rootDirectory: settings.rootDirectory, framework: null },
      observed: { ...project, framework: "nextjs" },
    },
    {
      requested: { rootDirectory: settings.rootDirectory, buildCommand: null },
      observed: { ...project, buildCommand: "provider default" },
    },
    {
      requested: { rootDirectory: settings.rootDirectory, sourceFilesOutsideRootDirectory: true },
      observed: { ...project, sourceFilesOutsideRootDirectory: false },
    },
  ])("rejects an explicit source setting mismatch on readback", async ({ requested, observed }) => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json(observed));
    expect(
      await observeNativeTargetVercelProject({
        ...f.input,
        settings: requested,
        projectId: project.id,
      }),
    ).toEqual({
      status: "candidate",
      projectId: project.id,
      reason: "name_or_profile_mismatch",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("journals before one exact create, saves the ID, then independently verifies the trusted native profile", async () => {
    const f = fixture();
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      name,
      projectId: project.id,
      scopeId: installation.scopeId,
      settings,
      protection: nativeTargetRequiredProjectProtection,
      status: "verified",
    });
    expect(f.order).toEqual(["journal", "POST", "receipt", "GET"]);
    expect(f.request).toHaveBeenCalledTimes(2);
    const [createUrl, createOptions] = f.request.mock.calls[0] ?? [];
    const [readUrl, readOptions] = f.request.mock.calls[1] ?? [];
    expect(createUrl).toBe("https://api.vercel.com/v11/projects?teamId=team-owned");
    expect(createOptions?.method).toBe("POST");
    expect(createOptions?.body).toBe(
      JSON.stringify({
        name,
        framework: settings.framework,
        rootDirectory: settings.rootDirectory,
        buildCommand: settings.buildCommand,
        ssoProtection: nativeTargetRequiredProjectProtection.ssoProtection,
        oidcTokenConfig: nativeTargetRequiredProjectProtection.oidcTokenConfig,
      }),
    );
    expect(readUrl).toBe("https://api.vercel.com/v9/projects/prj-owned?teamId=team-owned");
    expect(readOptions?.method).toBe("GET");
    expect(
      JSON.stringify(
        await createNativeTargetVercelProject({
          ...f.input,
          authorizeAttempt: () => Promise.reject(new Error("already dispatched")),
        }),
      ),
    ).not.toContain(token);
  });

  it.each([true, false])(
    "uses the create API contract and independently checks outside-root access (%s)",
    async (outsideRoot) => {
      const f = fixture();
      f.request.mockImplementation((_url, options) => {
        if (options?.method === "POST") {
          const body = z.looseObject({}).parse(JSON.parse(z.string().parse(options.body)));
          // Vercel POST /v11/projects has additionalProperties:false and does not
          // accept sourceFilesOutsideRootDirectory (the PATCH endpoint does).
          if (Object.hasOwn(body, "sourceFilesOutsideRootDirectory")) {
            return Promise.resolve(json({ error: { code: "bad_request" } }, 400));
          }
          return Promise.resolve(json({ id: project.id }, 201));
        }
        return Promise.resolve(json({ ...project, sourceFilesOutsideRootDirectory: outsideRoot }));
      });
      const result = await createNativeTargetVercelProject(f.input);
      expect(result.status).toBe(outsideRoot ? "verified" : "candidate");
      expect(f.acceptProjectId).toHaveBeenCalledWith(project.id);
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );

  it("does not dispatch when the caller cannot authorize and durably record the attempt", async () => {
    const f = fixture();
    f.authorizeAttempt.mockRejectedValueOnce(new Error("lease lost"));
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      status: "rejected",
      reason: "authorization_denied",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.acceptProjectId).not.toHaveBeenCalled();
  });

  it.each([
    [409, "collision"],
    [401, "permission_denied"],
    [403, "permission_denied"],
    [429, "rate_limited"],
    [400, "provider_rejected"],
  ] as const)(
    "returns a bounded rejection for HTTP %i without a second request",
    async (status, reason) => {
      const f = fixture();
      f.request.mockResolvedValueOnce(json({ error: { code: "synthetic" } }, status));
      expect(await createNativeTargetVercelProject(f.input)).toEqual({
        status: "rejected",
        reason,
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.acceptProjectId).not.toHaveBeenCalled();
    },
  );

  it("keeps a lost POST response unknown and never retries or adopts a matching name", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("connection lost"));
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      status: "uncertain",
      reason: "unknown_write",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.acceptProjectId).not.toHaveBeenCalled();
  });

  it.each([
    Response.json({ accepted: true }, { status: 201 }),
    json({ error: { code: "temporary" } }, 500),
  ])("keeps an invalid or ambiguous create response unknown after one POST", async (response) => {
    const f = fixture();
    f.request.mockResolvedValueOnce(response);
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      status: "uncertain",
      reason: "unknown_write",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.acceptProjectId).not.toHaveBeenCalled();
  });

  it("keeps an accepted ID uncertain when the durable receipt callback fails, without readback", async () => {
    const f = fixture();
    f.acceptProjectId.mockRejectedValueOnce(new Error("journal unavailable"));
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      status: "uncertain",
      reason: "receipt_unavailable",
      projectId: project.id,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("exposes a candidate on readback mismatch without silently adopting it", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(json({ id: project.id }, 201));
    f.request.mockResolvedValueOnce(json({ ...project, accountId: "other-team" }));
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      status: "candidate",
      projectId: project.id,
      reason: "name_or_profile_mismatch",
    });
    expect(f.acceptProjectId).toHaveBeenCalledWith(project.id);
  });

  it("does not verify a project whose Vercel Authentication or team OIDC was disabled", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(json({ id: project.id }, 201));
    f.request.mockResolvedValueOnce(Response.json({ ...project, ssoProtection: null }));
    expect(await createNativeTargetVercelProject(f.input)).toEqual({
      status: "candidate",
      projectId: project.id,
      reason: "name_or_profile_mismatch",
    });
    expect(f.request).toHaveBeenCalledTimes(2);

    const oidc = fixture();
    oidc.request.mockResolvedValueOnce(
      Response.json({ ...project, oidcTokenConfig: { enabled: false, issuerMode: "global" } }),
    );
    expect(
      await observeNativeTargetVercelProject({ ...oidc.input, projectId: project.id }),
    ).toEqual({
      status: "candidate",
      projectId: project.id,
      reason: "name_or_profile_mismatch",
    });
    expect(oidc.request).toHaveBeenCalledTimes(1);
  });

  it("keeps omitted protection readback uncertain", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ ...project, oidcTokenConfig: undefined }));
    expect(await observeNativeTargetVercelProject({ ...f.input, projectId: project.id })).toEqual({
      status: "uncertain",
      projectId: project.id,
      reason: "invalid_response",
    });
  });

  it("reconciles only by the accepted ID and treats a 404 as uncertain", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(json({ error: { code: "not_found" } }, 404));
    expect(await observeNativeTargetVercelProject({ ...f.input, projectId: project.id })).toEqual({
      status: "uncertain",
      projectId: project.id,
      reason: "unobserved_project",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(`/projects/${project.id}?`),
    );
  });
});
