import { describe, expect, it, vi } from "vitest";

import { hostedEveOperationScopes, type HostedPrincipal } from "./hosted-auth";
import {
  createHostedHttpMembership,
  createHostedHttpTransport,
  type HostedWorkloadIdentity,
} from "./hosted-http";
import {
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-service";

const principal: HostedPrincipal = {
  issuer: "https://identity.example.test",
  audience: "eve-hosted",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
};

const config = {
  baseUrl: "https://eve-workload.example.test",
  workloadAudience: "eve-workload",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function identity(token = "workload-token"): HostedWorkloadIdentity {
  return { token: vi.fn(async () => token) };
}

describe("hosted HTTPS workload adapters", () => {
  it("uses a fresh workload token and exact fixed route for each transport call", async () => {
    const workloadIdentity = identity();
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer workload-token",
      );
      if (String(url).endsWith("/v1/eve/get")) {
        return json({ status: "waiting", events: [] });
      }
      return json({
        adapterSessionId: "adapter_1",
        snapshot: { status: "waiting", events: [] },
      });
    });
    const transport = createHostedHttpTransport({
      config,
      workloadIdentity,
      fetchImplementation,
    });

    await expect(
      transport.start({ principal, operationId: "op_1", prompt: "Build" }),
    ).resolves.toMatchObject({ adapterSessionId: "adapter_1" });
    await expect(
      transport.get({ principal, adapterSessionId: "adapter_1" }),
    ).resolves.toEqual({ status: "waiting", events: [] });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://eve-workload.example.test/v1/eve/start",
      expect.any(Object),
    );
    expect(workloadIdentity.token).toHaveBeenCalledWith({
      audience: "eve-workload",
      principal,
    });
    expect(workloadIdentity.token).toHaveBeenCalledTimes(2);
  });

  it("distinguishes pre-dispatch identity failure from uncertain fetch failure", async () => {
    const unavailableIdentity: HostedWorkloadIdentity = {
      token: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    };
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      createHostedHttpTransport({
        config,
        workloadIdentity: unavailableIdentity,
        fetchImplementation,
      }).start({ principal, operationId: "op_1", prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionRejectedBeforeDispatchError);
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(
      createHostedHttpTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(async () => {
          throw new Error("connection lost");
        }),
      }).start({ principal, operationId: "op_1", prompt: "Build" }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("accepts only the closed explicit rejection and rejects redirects", async () => {
    await expect(
      createHostedHttpTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(async () =>
          json(
            { error: "rejected_before_dispatch", code: "policy_denied" },
            422,
          ),
        ),
      }).start({ principal, operationId: "op_1", prompt: "Build" }),
    ).rejects.toMatchObject({
      name: SubmissionRejectedBeforeDispatchError.name,
      code: "policy_denied",
    });

    await expect(
      createHostedHttpTransport({
        config,
        workloadIdentity: identity(),
        fetchImplementation: vi.fn(
          async () =>
            new Response(null, {
              status: 307,
              headers: { location: "https://attacker.example.test" },
            }),
        ),
      }).send({
        principal,
        operationId: "op_2",
        adapterSessionId: "adapter_1",
        message: "Continue",
      }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("denies mismatched membership locally and closes the response schema", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      json({ member: true }),
    );
    const membership = createHostedHttpMembership({
      config,
      workloadIdentity: identity(),
      fetchImplementation,
    });
    await expect(
      membership.isMember({ principal, workspaceId: "workspace_other" }),
    ).resolves.toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(
      membership.isMember({ principal, workspaceId: principal.workspaceId }),
    ).resolves.toBe(true);
  });

  it("rejects credentialed or path-bearing gateway configuration", () => {
    expect(() =>
      createHostedHttpTransport({
        config: { ...config, baseUrl: "https://user:pass@example.test/path" },
        workloadIdentity: identity(),
      }),
    ).toThrow();
  });

  it("bounds declared response bytes before reading the body", async () => {
    const transport = createHostedHttpTransport({
      config,
      workloadIdentity: identity(),
      fetchImplementation: vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(2 * 1024 * 1024 + 1),
            },
          }),
      ),
    });
    await expect(
      transport.send({
        principal,
        operationId: "op_3",
        adapterSessionId: "adapter_1",
        message: "Continue",
      }),
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });
});
