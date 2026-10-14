import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createHostedOperatorClient } from "./hosted-operator-client";

const selection = {
  appId: "test-app",
  branch: "main",
  environment: "preview" as const,
  projectId: "project",
  sessionId: "private-session",
};
const operationRef = "83cf8be5-3e1f-4e73-8e2f-e270fd2e6833";

describe("closed outbound operator action diagnostics", () => {
  it.each(["status", "execute"] as const)(
    "distinguishes %s without changing requests or results",
    async (action) => {
      const logs = vi.spyOn(console, "info").mockImplementation(() => {});
      const result = {
        appId: selection.appId,
        authenticatedBehavior: "unassessed",
        status: "pending",
        operationRef,
      };
      const request = {
        action,
        selection,
        operationRef,
        ...(action === "execute" ? { callId: "private-call", planDigest: "a".repeat(64) } : {}),
      };
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        const body = z.string().parse(init?.body);
        expect(JSON.parse(body)).toEqual(request);
        return await Promise.resolve(Response.json(result));
      });
      const client = createHostedOperatorClient({
        endpoint: "https://operator.example",
        fetch: transport,
        token: async () => await Promise.resolve("private-bearer"),
      });
      try {
        const value =
          action === "execute"
            ? await client.request({
                action,
                selection,
                operationRef,
                callId: "private-call",
                planDigest: "a".repeat(64),
              })
            : await client.request({ action, selection, operationRef });
        expect(value).toEqual(result);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(logs).toHaveBeenCalledWith(
          "[builder:hosted-neon-consent]",
          expect.objectContaining({ operatorAction: action, outcome: "started" }),
        );
        expect(logs).toHaveBeenCalledWith(
          "[builder:hosted-neon-consent]",
          expect.objectContaining({ operatorAction: action, httpStatus: 200, outcome: "verified" }),
        );
        const serialized = JSON.stringify(logs.mock.calls);
        for (const secret of ["private-session", "private-call", "private-bearer", operationRef]) {
          expect(serialized).not.toContain(secret);
        }
      } finally {
        logs.mockRestore();
      }
    },
  );
});
