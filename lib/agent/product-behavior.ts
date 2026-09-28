import { randomUUID } from "node:crypto";
import { readJsonPointerString } from "./streaming-json-pointer";

export interface ProductReadbackScenario {
  outcomeId: string;
  writePath: string;
  readPath: string;
  /** The verifier adds its unpredictable marker to this top-level JSON field. */
  markerField: string;
  body: Record<string, unknown>;
  readPointer: string;
}

const appUrl = (path: string, origin: string): string => {
  const url = new URL(path, origin);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    url.origin !== origin ||
    url.hash ||
    url.pathname.startsWith("/__autograph_preview")
  ) {
    throw new Error("Invalid application path");
  }
  return url.href;
};

class InvalidApplicationReadError extends Error {
  override name = "InvalidApplicationReadError";
}

const validAuthority = (launch: URL, expiresAt: number): boolean =>
  launch.protocol === "https:" &&
  !launch.username &&
  !launch.password &&
  launch.pathname === "/__autograph_preview_launch" &&
  Number.isFinite(expiresAt) &&
  expiresAt > Date.now();

const validScenario = (scenario: ProductReadbackScenario): boolean =>
  Boolean(scenario.markerField) &&
  scenario.markerField.length <= 128 &&
  scenario.readPointer.length <= 1024;

const needsApplicationAuth = (response: Response): boolean => [401, 403].includes(response.status);
const validExchange = (
  response: Response,
  location: string | null,
  origin: string,
  cookies: string[],
): boolean =>
  response.status === 303 &&
  location !== null &&
  new URL(location, origin).origin === origin &&
  cookies.length > 0;

/** Only action/readback evidence: never proof of restart durability, authentication or child generation. */
export const executeProductReadback = async (input: {
  authority: { launchUrl: string; expiresAt: number };
  scenario: ProductReadbackScenario;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) => {
  const result = (status: "passed" | "failed" | "blocked", reason: string) => ({
    coverage: "action-readback-only" as const,
    outcomeId: input.scenario.outcomeId,
    reason,
    status,
    unassessed: ["restart-durability", "authentication", "tenant-isolation", "child-generation"],
  });
  const signal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const transport = input.fetch ?? fetch;
  try {
    const launch = new URL(input.authority.launchUrl);
    if (!validAuthority(launch, input.authority.expiresAt)) {
      return result("blocked", "Preview authority is invalid or expired.");
    }
    const writeUrl = appUrl(input.scenario.writePath, launch.origin);
    const readUrl = appUrl(input.scenario.readPath, launch.origin);
    if (!validScenario(input.scenario)) {
      return result("blocked", "Invalid readback scenario.");
    }
    const marker = randomUUID();
    const body = JSON.stringify({ ...input.scenario.body, [input.scenario.markerField]: marker });
    const request = (url: string, options: RequestInit = {}) => {
      signal.throwIfAborted();
      if (Date.now() >= input.authority.expiresAt) {
        throw new Error("Expired authority");
      }
      return transport(url, { ...options, credentials: "omit", redirect: "manual", signal });
    };
    const access = await request(launch.href);
    const location = access.headers.get("location");
    const cookies = access.headers.getSetCookie().map((header) => header.split(";")[0]);
    await access.body?.cancel();
    if (!validExchange(access, location, launch.origin, cookies)) {
      return result("blocked", "Preview access exchange failed.");
    }
    const headers = { cookie: cookies.join("; ") };
    const write = await request(writeUrl, {
      body,
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    });
    await write.body?.cancel();
    if (needsApplicationAuth(write)) {
      return result("blocked", "Application authentication context is unavailable for this write.");
    }
    if (!write.ok) {
      return result("failed", "Application write did not succeed; redirects are not followed.");
    }
    const read = await request(readUrl, { headers, method: "GET" });
    if (!read.ok) {
      await read.body?.cancel();
      if (needsApplicationAuth(read)) {
        return result(
          "blocked",
          "Application authentication context is unavailable for this read.",
        );
      }
      return result("failed", "Independent read did not succeed; redirects are not followed.");
    }
    let observed: boolean;
    try {
      observed = await readJsonPointerString(read.body, input.scenario.readPointer, marker);
    } catch {
      throw new InvalidApplicationReadError("Invalid JSON response");
    }
    return observed
      ? result("passed", "Independent application read returned the verifier-written value.")
      : result("failed", "Independent application read did not return the verifier-written value.");
  } catch (error) {
    if (error instanceof InvalidApplicationReadError) {
      return result(
        "failed",
        "Independent application read returned malformed JSON or a response too deeply nested to verify. Check the read endpoint and its JSON output.",
      );
    }
    return result(
      "blocked",
      signal.aborted ? "Observation aborted or timed out." : "Observation could not complete.",
    );
  }
};

export type ProductReadbackResult = Awaited<ReturnType<typeof executeProductReadback>>;
