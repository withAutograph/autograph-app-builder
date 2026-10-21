import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBuilderApprovalStreamFetch,
  createHostedOperatorApprovalObserver,
} from "./hosted-operator-approval-observer";
import { SubmissionRejectedBeforeDispatchError } from "../eve/hosted-service";
import type { HostedOperatorContext } from "./hosted-operator-service";

const authority = {
  issuer: "https://identity.example.test",
  audience: "eve-hosted",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const principal = { ...authority, scopes: ["autograph:session"] };
const context = (): HostedOperatorContext => ({
  authority,
  target: {
    appId: "fixture",
    branch: "preview",
    environment: "preview",
    installationId: "installation",
    projectId: "project",
    scopeId: "team",
    scopeType: "team",
    sessionId: "public-session",
  },
  ownerContext: {
    kind: "direct",
    adapterGeneration: 1,
    adapterSessionId: "wrun_1",
    authority,
    principal,
    sessionId: "public-session",
  },
});
const observation = {
  principal,
  adapterSessionId: "wrun_1",
  sessionId: "public-session",
  onEvent: () => {},
};
const stream = () =>
  new Response(
    `${JSON.stringify({ data: {}, type: "session.started" })}\n${JSON.stringify({ data: {}, meta: { at: 1, id: "event" }, type: "session.waiting" })}\n`,
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-eve-session-id": "wrun_1",
        "x-eve-stream-format": "ndjson",
        "x-eve-stream-tail-index": "1",
        "x-eve-stream-version": "25",
      },
    },
  );
const setup = (authorized = true) => {
  const ambientToken = vi.fn(() => Promise.resolve("operator-token"));
  const verifyReadAuthority = vi.fn(() => Promise.resolve(authorized));
  const fetchImplementation = vi.fn<typeof fetch>(() => Promise.resolve(stream()));
  const observer = createHostedOperatorApprovalObserver({
    builderOrigin: "https://builder.example.test",
    workloadIdentity: { token: ambientToken },
    verifyReadAuthority,
    fetchImplementation,
  });
  return { observer, ambientToken, verifyReadAuthority, fetchImplementation };
};

describe("request-owned approval observation", () => {
  it("uses the verified Builder carrier through a copied context without changing the ambient observer", async () => {
    const f = setup();
    const owned = context();
    f.observer.bindWorkload(owned, () => "builder-token", new AbortController().signal);
    await f.observer.forContext({ ...owned })(observation);
    expect(f.ambientToken).not.toHaveBeenCalled();
    expect(f.verifyReadAuthority).toHaveBeenCalledWith({
      principal,
      adapterSessionId: "wrun_1",
      sessionId: "public-session",
    });
    const boundHeaders = new Headers(f.fetchImplementation.mock.calls[0]?.[1]?.headers);
    expect(boundHeaders.get("authorization")).toBe("Bearer builder-token");
    expect(boundHeaders.get("x-vercel-trusted-oidc-idp-token")).toBe("builder-token");
    await f.observer.forContext(structuredClone(owned))(observation);
    await f.observer.forContext(context())(observation);
    expect(f.ambientToken).toHaveBeenCalledTimes(2);
    expect(
      new Headers(f.fetchImplementation.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer operator-token");
  });

  it("keeps concurrent requests' owner capabilities separate", async () => {
    const f = setup();
    const first = context();
    const second = context();
    f.observer.bindWorkload(first, () => "first-builder", new AbortController().signal);
    f.observer.bindWorkload(second, () => "second-builder", new AbortController().signal);
    await Promise.all([
      f.observer.forContext(first)(observation),
      f.observer.forContext(second)(observation),
    ]);
    expect(
      f.fetchImplementation.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("authorization"),
      ),
    ).toEqual(["Bearer first-builder", "Bearer second-builder"]);
    expect(f.ambientToken).not.toHaveBeenCalled();
  });

  it("retains canonical read authorization before using the carrier", async () => {
    const f = setup(false);
    const owned = context();
    f.observer.bindWorkload(owned, () => "builder-token", new AbortController().signal);
    await expect(f.observer.forContext(owned)(observation)).rejects.toBeInstanceOf(
      SubmissionRejectedBeforeDispatchError,
    );
    expect(f.fetchImplementation).not.toHaveBeenCalled();
    expect(f.ambientToken).not.toHaveBeenCalled();
  });

  it("rejects an ended request without an ambient fallback", async () => {
    const f = setup();
    const owned = context();
    const abort = new AbortController();
    const reason = new Error("request ended");
    f.observer.bindWorkload(owned, () => "builder-token", abort.signal);
    abort.abort(reason);
    await expect(f.observer.forContext(owned)(observation)).rejects.toBe(reason);
    expect(f.fetchImplementation).not.toHaveBeenCalled();
    expect(f.ambientToken).not.toHaveBeenCalled();
  });

  it("does not follow a Builder stream redirect to a foreign host", async () => {
    const f = setup();
    const owned = context();
    f.fetchImplementation.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://foreign.example.test/stream" },
        }),
      ),
    );
    f.observer.bindWorkload(owned, () => "builder-token", new AbortController().signal);
    await expect(f.observer.forContext(owned)(observation)).rejects.toThrow();
    expect(f.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(f.fetchImplementation.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});

describe("Builder approval stream credential boundary", () => {
  it.each([
    "https://foreign.example.test/eve/v1/session/wrun_1/stream",
    "https://builder.example.test/eve/v1/session/wrun_2/stream",
    "https://builder.example.test/eve/v1/session/wrun_1/stream-extra",
    "https://user@builder.example.test/eve/v1/session/wrun_1/stream",
  ])("does not forward stream credentials to %s", async (url) => {
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(stream()));
    const guarded = createBuilderApprovalStreamFetch({
      origin: "https://builder.example.test",
      adapterSessionId: "wrun_1",
      signal: new AbortController().signal,
      fetchImplementation: raw,
    });
    await expect(
      guarded(url, { headers: { authorization: "Bearer builder-token" } }),
    ).rejects.toThrow("authorization_required");
    expect(raw).not.toHaveBeenCalled();
  });

  it("preserves request and init semantics while combining cancellation and forcing manual redirects", async () => {
    const requestAbort = new AbortController();
    const deadline = new AbortController();
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(stream()));
    const guarded = createBuilderApprovalStreamFetch({
      origin: "https://builder.example.test",
      adapterSessionId: "wrun_1",
      signal: requestAbort.signal,
      fetchImplementation: raw,
    });
    const request = new Request("https://builder.example.test/eve/v1/session/wrun_1/stream", {
      headers: { inherited: "request" },
    });
    const headers = new Headers({ authorization: "Bearer builder-token", custom: "unchanged" });
    await guarded(request, {
      method: "POST",
      body: "payload",
      headers,
      signal: deadline.signal,
      redirect: "follow",
    });
    expect(raw.mock.calls[0]?.[0]).toBe(request);
    const init = raw.mock.calls[0]?.[1];
    expect(init?.headers).toBe(headers);
    expect(init?.body).toBe("payload");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal?.aborted).toBe(false);
    requestAbort.abort();
    expect(init?.signal?.aborted).toBe(true);
  });
});

describe("native approval history reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("resumes absolute native indices after a complete callback at the unchanged deadline", async () => {
    const f = setup();
    const owned = context();
    f.observer.bindWorkload(owned, () => "builder-token", new AbortController().signal);
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const events: string[] = [];
    const first = await f.observer.privateHistoryForContext({ ...owned })({
      ...observation,
      startIndex: 0,
      onEvent: (event) => {
        events.push(event.type);
        deadline.abort();
      },
    });
    expect(first).toEqual({ complete: false, nextNativeIndex: 1, nativeTailIndex: 1 });
    const tail = new Response(`${JSON.stringify({ data: {}, type: "session.waiting" })}\n`, {
      headers: stream().headers,
    });
    f.fetchImplementation.mockResolvedValueOnce(tail);
    const next = await f.observer.privateHistoryForContext(owned)({
      ...observation,
      startIndex: first.nextNativeIndex,
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    expect(next).toEqual({ complete: true, nextNativeIndex: 2, nativeTailIndex: 1 });
    expect(events).toEqual(["session.started", "session.waiting"]);
    const resumedResource = f.fetchImplementation.mock.calls[1]?.[0];
    const resumedUrl = resumedResource instanceof Request ? resumedResource.url : resumedResource;
    expect(resumedUrl?.toString()).toContain("startIndex=1&");
    expect(f.verifyReadAuthority).toHaveBeenCalledTimes(2);
    expect(f.ambientToken).not.toHaveBeenCalled();
    expect(
      new Headers(f.fetchImplementation.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer builder-token");
  });
  it("does not checkpoint a failed event callback or bypass fresh read authority", async () => {
    const f = setup();
    const failure = new Error("capture rejected");
    await expect(
      f.observer.privateHistoryForContext(context())({
        ...observation,
        startIndex: 0,
        onEvent: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    const denied = setup(false);
    await expect(
      denied.observer.privateHistoryForContext(context())({ ...observation, startIndex: 0 }),
    ).rejects.toBeInstanceOf(SubmissionRejectedBeforeDispatchError);
    expect(denied.fetchImplementation).not.toHaveBeenCalled();
  });
});
