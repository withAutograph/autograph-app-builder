import { z } from "zod";
import { PublicReleaseProviderError } from "./public-release-provider-error";
import {
  githubReleaseDiagnosticSchema,
  githubReleaseGraphqlTypeSchema,
} from "./public-release-provider-diagnostic";

const requestRef = (headers: Readonly<Record<string, string | number | undefined>>) => {
  const parsed = githubReleaseDiagnosticSchema.shape.requestRef.safeParse(
    headers["x-github-request-id"],
  );
  return parsed.success && parsed.data !== undefined ? { requestRef: parsed.data } : {};
};
const httpCodes = new Map([
  [401, "bad_credentials"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [422, "validation_failed"],
  [429, "rate_limited"],
]);
/** Parse only actual HTTP metadata; provider bodies/messages/URLs never cross this boundary. */
export const githubReleaseFailure = (error: unknown): PublicReleaseProviderError | undefined => {
  if (error instanceof PublicReleaseProviderError) {
    return error;
  }
  const status = z
    .object({
      response: z.object({ status: z.number().int().min(400).max(599) }),
      status: z.number().int().min(400).max(599),
    })
    .safeParse(error);
  if (!status.success || status.data.status !== status.data.response.status) {
    return undefined;
  }
  const metadata = z
    .object({
      response: z.object({ headers: z.object({ "x-github-request-id": z.string().optional() }) }),
    })
    .safeParse(error);
  const code =
    httpCodes.get(status.data.status) ??
    (status.data.status >= 500 ? "provider_unavailable" : undefined);
  const requestReference = metadata.success
    ? requestRef(metadata.data.response.headers).requestRef
    : undefined;
  const diagnostic = {
    provider: "github",
    statusCode: status.data.status,
  } satisfies {
    provider: "github";
    statusCode: number;
    code?: string;
    requestRef?: string;
  };
  if (code !== undefined) {
    diagnostic.code = code;
  }
  if (requestReference !== undefined) {
    diagnostic.requestRef = requestReference;
  }
  return new PublicReleaseProviderError(githubReleaseDiagnosticSchema.parse(diagnostic));
};

/** GraphQL rejects mutations with HTTP200; retain only a closed error type. */
export const githubReleaseGraphqlFailure = (
  data: unknown,
  headers: Readonly<Record<string, string | number | undefined>>,
): PublicReleaseProviderError | undefined => {
  const parsed = z.object({ errors: z.array(z.unknown()).min(1) }).safeParse(data);
  if (!parsed.success) {
    return undefined;
  }
  let code: z.infer<typeof githubReleaseGraphqlTypeSchema> | undefined;
  for (const error of parsed.data.errors) {
    const typed = z.object({ type: githubReleaseGraphqlTypeSchema }).safeParse(error);
    if (typed.success) {
      code = typed.data.type;
      break;
    }
  }
  const ref = requestRef(headers).requestRef;
  const diagnostic = {
    provider: "github",
    statusCode: 200,
  } satisfies {
    provider: "github";
    statusCode: number;
    code?: z.infer<typeof githubReleaseGraphqlTypeSchema>;
    requestRef?: string;
  };
  if (code !== undefined) {
    diagnostic.code = code;
  }
  if (ref !== undefined) {
    diagnostic.requestRef = ref;
  }
  return new PublicReleaseProviderError(diagnostic);
};
