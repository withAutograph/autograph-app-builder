/* oxlint-disable eslint/no-await-in-loop -- Domain metadata is consumed in bounded stream order, then ownership is rechecked. */
import { z } from "zod";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import { HostedOperatorError } from "./hosted-operator-contract";

const unavailable = () => new HostedOperatorError("builder_destination_configuration_required");
const absent = (value: string | null | undefined) => value === null || value === undefined;
const domainSchema = z.object({
  customEnvironmentId: z.string().nullable().optional(),
  gitBranch: z.string().nullable().optional(),
  name: z.string().min(1),
  redirect: z.string().nullable().optional(),
  verified: z.boolean(),
});
const readDomains = async (response: Response) => {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) {
        throw unavailable();
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw unavailable();
  }
  const parsed = z
    .object({
      domains: z.array(domainSchema),
      pagination: z.object({ next: z.number().nullable().optional() }).optional(),
    })
    .safeParse(decoded);
  if (!parsed.success) {
    throw unavailable();
  }
  return parsed.data;
};

/** Only an independently listed, uniquely selected production domain supplies Auth's origin. */
export const readStandardBuilderPublicOrigins = async (input: {
  destination: { projectId: string; teamId: string; installationId: string };
  assertCurrent: () => Promise<void>;
  readCredential: () => Promise<{ token: string; binding: VercelInstallationBinding } | undefined>;
  fetch?: typeof fetch;
  apiOrigin?: string;
}): Promise<string[]> => {
  await input.assertCurrent();
  const credential = await input.readCredential();
  if (
    ![
      credential !== undefined,
      credential?.binding.active === true,
      credential?.binding.installationId === input.destination.installationId,
      credential?.binding.scopeType === "team",
      credential?.binding.scopeId === input.destination.teamId,
    ].every(Boolean) ||
    credential === undefined
  ) {
    throw unavailable();
  }
  const url = new URL(
    `/v9/projects/${encodeURIComponent(input.destination.projectId)}/domains`,
    input.apiOrigin ?? "https://api.vercel.com",
  );
  url.searchParams.set("teamId", input.destination.teamId);
  const observed: z.infer<typeof domainSchema>[] = [];
  const cursors = new Set<number>();
  for (;;) {
    await input.assertCurrent();
    const response = await (input.fetch ?? fetch)(url, {
      headers: { authorization: `Bearer ${credential.token}` },
      redirect: "error",
    });
    const page = await readDomains(response);
    observed.push(...page.domains);
    await input.assertCurrent();
    const next = page.pagination?.next;
    if (next === null || next === undefined) {
      break;
    }
    if (cursors.has(next)) {
      throw unavailable();
    }
    cursors.add(next);
    url.searchParams.set("until", String(next));
  }
  const domains = observed.filter((domain) =>
    [
      domain.verified,
      absent(domain.gitBranch),
      absent(domain.customEnvironmentId),
      absent(domain.redirect),
      !domain.name.startsWith("*."),
    ].every(Boolean),
  );
  const origins = domains.map((domain) => {
    let origin: URL;
    try {
      origin = new URL(`https://${domain.name}`);
    } catch {
      throw unavailable();
    }
    if (
      origin.hostname !== domain.name ||
      origin.origin !== `https://${domain.name}` ||
      origin.username !== "" ||
      origin.password !== ""
    ) {
      throw unavailable();
    }
    return origin.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw unavailable();
  }
  await input.assertCurrent();
  return origins.toSorted();
};

export const readStandardBuilderPublicOrigin = async (
  input: Parameters<typeof readStandardBuilderPublicOrigins>[0] & { selectedPublicOrigin?: string },
): Promise<string> => {
  const origins = await readStandardBuilderPublicOrigins(input);
  if (input.selectedPublicOrigin !== undefined) {
    if (!origins.includes(input.selectedPublicOrigin)) {
      throw new HostedOperatorError("builder_public_domain_selection_required");
    }
    return input.selectedPublicOrigin;
  }
  if (origins.length !== 1 || origins[0] === undefined) {
    throw new HostedOperatorError("builder_public_domain_selection_required");
  }
  return origins[0];
};
