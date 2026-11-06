import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const id = "123e4567-e89b-42d3-a456-426614174001";
const handoffPath = `/handoff/${id}`;
const signInUrl = `/auth/sign-in?callbackURL=${encodeURIComponent(handoffPath)}`;
const githubReturnUrl = `/github/installations?returnTo=${encodeURIComponent(handoffPath)}`;
const vercelReturnUrl = `/vercel/installations?returnTo=${encodeURIComponent(handoffPath)}`;

interface HandoffData {
  handoffId: string;
  intent: {
    appName: string;
    brief: string;
    connections: string[];
    provisioning?: {
      github?: { code: string; status: string };
      vercel?: { code: string; status: string };
    };
    repository: { private: boolean; requestedName: string };
  };
}

interface HandoffServices {
  load: (handoffId: string, cookie: string) => Promise<HandoffData | undefined>;
}

const renderHandoff = async (services: HandoffServices) => {
  let data: HandoffData | undefined;
  try {
    data = await services.load(id, "web-session");
  } catch {
    return renderToStaticMarkup(
      <main>
        <h1>Handoff unavailable</h1>
        <a href={signInUrl}>Sign in with the same account</a>
      </main>,
    );
  }

  if (!data) {
    throw new Error(`redirect:${signInUrl}`);
  }

  const { intent } = data;
  const github = intent.provisioning?.github;
  const vercel = intent.provisioning?.vercel;
  const githubSkipped = github?.status === "skipped" && github.code === "not_selected";
  let githubLabel = "GitHub storage was turned off.";
  if (!githubSkipped) {
    const visibility = intent.repository.private ? "Private" : "Public";
    githubLabel = `${intent.repository.requestedName} (${visibility})`;
  }
  const reconnectGithub =
    github?.status === "failed" &&
    ["credential_unavailable", "installation_inactive"].includes(github.code);
  const reconnectVercel =
    vercel?.status === "failed" &&
    ["credential_unavailable", "installation_inactive"].includes(vercel.code);

  return renderToStaticMarkup(
    <main>
      <h1>{intent.appName}</h1>
      <section>
        <strong>GitHub repository</strong>
        <span>{githubLabel}</span>
        {reconnectGithub ? <a href={githubReturnUrl}>Reconnect GitHub</a> : null}
        {reconnectVercel ? <a href={vercelReturnUrl}>Reconnect Vercel</a> : null}
      </section>
      {intent.connections.length ? <p>{intent.connections.join(", ")}</p> : null}
      <p>{intent.brief}</p>
      <div>Continue controls</div>
    </main>,
  );
};

describe("authenticated handoff page", () => {
  it("redirects a missing web session back through the same handoff", async () => {
    let received: { handoffId: string; cookie: string } | undefined;
    await expect(
      renderHandoff({
        load: async (handoffId, cookie) => {
          received = { cookie, handoffId };
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(`redirect:${signInUrl}`);
    expect(received).toEqual({ cookie: "web-session", handoffId: id });
  });

  it("does not expose server errors or owner information for an unavailable handoff", async () => {
    const html = await renderHandoff({
      load: async () => await Promise.reject(new Error("private-owner@example.com database error")),
    });
    expect(html).toContain("Handoff unavailable");
    expect(html).not.toContain("private-owner");
    expect(html).not.toContain("database error");
  });

  it("shows that GitHub storage was turned off for a private run", async () => {
    const html = await renderHandoff({
      load: async () =>
        await Promise.resolve({
          handoffId: id,
          intent: {
            appName: "Unit Converter",
            brief: "Convert temperatures",
            connections: [],
            provisioning: { github: { code: "not_selected", status: "skipped" } },
            repository: { private: true, requestedName: "unit-converter" },
          },
        }),
    });
    expect(html).toContain("GitHub storage was turned off.");
    expect(html).not.toContain("unit-converter (Private)");
    expect(html).toContain("Continue controls");
  });

  it.each(["credential_unavailable", "provider_unavailable"])(
    "renders saved context and only offers reconnect for credential failures: %s",
    async (code) => {
      const html = await renderHandoff({
        load: async () =>
          await Promise.resolve({
            handoffId: id,
            intent: {
              appName: "Support App",
              brief: "Help customers",
              connections: ["QuickBooks"],
              provisioning: {
                github: { code, status: "failed" },
                vercel: { code, status: "failed" },
              },
              repository: { private: true, requestedName: "support-app" },
            },
          }),
      });
      expect(html).toContain("Support App");
      expect(html).toContain("Help customers");
      expect(html).toContain("QuickBooks");
      if (code === "credential_unavailable") {
        expect(html).toContain(githubReturnUrl);
        expect(html).toContain(vercelReturnUrl);
      } else {
        expect(html).not.toContain("Reconnect");
      }
    },
  );
});
