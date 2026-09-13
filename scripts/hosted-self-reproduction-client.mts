/* oxlint-disable eslint/no-await-in-loop -- Polling and partial artifact retention are sequential and bounded. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";

interface Status {
  status: string;
  artifacts: { id: string; contentType: string }[];
}
interface ClientInput {
  endpoint: string;
  audience: string;
  tokenRequestUrl: string;
  tokenRequestToken: string;
  outputDirectory: string;
  fetch?: typeof fetch;
  now?: () => number;
  pause?: () => Promise<void>;
  timeoutMs?: number;
}

/** GitHub-hosted client; all execution and Vercel credentials stay in the controller. */
export const runHostedSelfReproductionClient = async (input: ClientInput) => {
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const pause = input.pause ?? (() => setTimeout(5000));
  await mkdir(input.outputDirectory, { recursive: true });
  const downloaded = new Set<string>();
  const failures: string[] = [];
  const deadline = now() + (input.timeoutMs ?? 50 * 60_000);
  const save = (name: string, value: unknown) =>
    writeFile(path.join(input.outputDirectory, name), JSON.stringify(value, null, 2));
  let status: Status | undefined;
  const call = async (action: "start" | "status" | "artifact", artifactId?: string) => {
    const tokenUrl = new URL(input.tokenRequestUrl);
    tokenUrl.searchParams.set("audience", input.audience);
    const tokenResponse = await request(tokenUrl, {
      headers: { authorization: `Bearer ${input.tokenRequestToken}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!tokenResponse.ok) throw new Error("GitHub OIDC request failed.");
    const token = (await tokenResponse.json()) as { value?: unknown };
    if (typeof token.value !== "string" || !token.value)
      throw new Error("GitHub OIDC response invalid.");
    const response = await request(input.endpoint, {
      body: JSON.stringify({ action, ...(artifactId ? { artifactId } : {}) }),
      headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Controller ${action} failed (HTTP ${response.status}).`);
    return response;
  };
  const capture = async () => {
    for (const artifact of status?.artifacts ?? []) {
      if (downloaded.has(artifact.id)) continue;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(artifact.id)) {
        failures.push("Controller returned an invalid artifact identifier.");
        continue;
      }
      try {
        const response = await call("artifact", artifact.id);
        await mkdir(path.join(input.outputDirectory, "artifacts"), { recursive: true });
        await writeFile(
          path.join(input.outputDirectory, "artifacts", artifact.id),
          new Uint8Array(await response.arrayBuffer()),
        );
        downloaded.add(artifact.id);
      } catch {
        failures.push(`Artifact download failed: ${artifact.id}`);
      }
    }
  };
  try {
    if (
      !input.audience ||
      !input.tokenRequestToken ||
      !input.tokenRequestUrl ||
      new URL(input.endpoint).protocol !== "https:"
    )
      throw new Error("Hosted eval requires an HTTPS controller and GitHub OIDC configuration.");
    const readStatus = async (response: Response) => {
      const value = (await response.json()) as Status;
      if (!value || typeof value.status !== "string" || !Array.isArray(value.artifacts))
        throw new Error("Controller status response invalid.");
      for (const artifact of value.artifacts) {
        if (
          !artifact ||
          typeof artifact.id !== "string" ||
          typeof artifact.contentType !== "string"
        )
          throw new Error("Controller artifact response invalid.");
      }
      await save("controller-status.json", value);
      return value;
    };
    status = await readStatus(await call("start"));
    while (status?.status !== "completed" && status?.status !== "failed") {
      if (now() >= deadline)
        throw new Error(
          "Hosted eval polling timed out; controller cleanup deadline remains active.",
        );
      await pause();
      status = await readStatus(await call("status"));
    }
  } catch (error) {
    // Never retain arbitrary provider/network errors, which may include credentials.
    failures.push(
      error instanceof Error && /^(?:Hosted eval|Controller|GitHub OIDC)/u.test(error.message)
        ? error.message
        : "Hosted eval transport failed.",
    );
  } finally {
    await capture();
    await save("client-receipt.json", {
      downloaded: [...downloaded],
      failures,
      status: status?.status ?? "unavailable",
    });
  }
  return status?.status === "completed" && failures.length === 0 ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runHostedSelfReproductionClient({
    audience: process.env.SELF_REPRODUCTION_GITHUB_AUDIENCE ?? "",
    endpoint: process.env.SELF_REPRODUCTION_CONTROLLER_URL ?? "",
    outputDirectory: process.env.SELF_REPRODUCTION_OUTPUT_DIR ?? "",
    tokenRequestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
    tokenRequestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
  });
}
