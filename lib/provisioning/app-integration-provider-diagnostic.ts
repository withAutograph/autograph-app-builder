import { z } from "zod";

export const integrationProviderDiagnosticSchema = z.strictObject({
  code: z.enum([
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "invalid_request",
    "rate_limited",
    "provider_unavailable",
    "request_rejected",
  ]),
  provider: z.literal("ampersand"),
  requestRef: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u)
    .optional(),
  statusCode: z.number().int().min(400).max(599),
});
export type IntegrationProviderDiagnostic = z.infer<typeof integrationProviderDiagnosticSchema>;
/** Only closed HTTP facts and a validated provider request header cross this boundary. */
export class IntegrationProviderError extends Error {
  readonly diagnostic: IntegrationProviderDiagnostic;
  constructor(diagnostic: IntegrationProviderDiagnostic) {
    super("app_integration_provider_rejected");
    this.name = "IntegrationProviderError";
    this.diagnostic = integrationProviderDiagnosticSchema.parse(diagnostic);
  }
}
const httpCode = (status: number): IntegrationProviderDiagnostic["code"] => {
  switch (status) {
    case 401: {
      return "unauthenticated";
    }
    case 403: {
      return "forbidden";
    }
    case 404: {
      return "not_found";
    }
    case 409: {
      return "conflict";
    }
    case 422: {
      return "invalid_request";
    }
    case 429: {
      return "rate_limited";
    }
    default: {
      return status >= 500 ? "provider_unavailable" : "request_rejected";
    }
  }
};
export const integrationProviderHttpError = (response: Response) => {
  const { status } = response;
  const requestRef = integrationProviderDiagnosticSchema.shape.requestRef.safeParse(
    response.headers.get("x-request-id") ?? response.headers.get("x-amzn-requestid") ?? undefined,
  );
  const details = {
    code: httpCode(status),
    provider: "ampersand" as const,
    statusCode: status,
  };
  if (requestRef.success && requestRef.data !== undefined) {
    return new IntegrationProviderError({ ...details, requestRef: requestRef.data });
  }
  return new IntegrationProviderError(details);
};
