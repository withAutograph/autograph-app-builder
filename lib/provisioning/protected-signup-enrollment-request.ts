import { z } from "zod";

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const signupRequestSchema = z.strictObject({
  version: z.literal(1),
  policyId: id,
  policyDigest: digest,
  policyOperationRef: z.uuid(),
  planDigest: digest,
  resourceDigest: digest,
  actorId: id,
  sessionId: id,
  appId: id,
  origin: z
    .url()
    .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
  appPath: z
    .string()
    .max(2048)
    .regex(/^\/(?!\/)[^?#\\]*$/u),
});
export type ProtectedSignupEnrollmentRequest = z.infer<typeof signupRequestSchema>;
export type ProtectedSignupEnrollmentResponse =
  | { status: "ready"; generation: number }
  | { status: "pending" | "blocked" };

const statuses = { ready: 200, pending: 202, blocked: 403 } as const;
const response = (result: ProtectedSignupEnrollmentResponse) =>
  Response.json(result, {
    status: statuses[result.status],
    headers: { "cache-control": "private, no-store" },
  });

export const createProtectedSignupEnrollmentRequestHandler =
  (
    continueSignup: (
      request: Request,
      input: ProtectedSignupEnrollmentRequest,
    ) => Promise<ProtectedSignupEnrollmentResponse>,
  ) =>
  async (request: Request) => {
    const authorization = request.headers.get("authorization");
    if (
      authorization?.startsWith("Bearer ") !== true ||
      authorization.length > 16_384 ||
      request.body === null
    ) {
      return response({ status: "blocked" });
    }
    let body: ProtectedSignupEnrollmentRequest;
    const reader = request.body.getReader();
    try {
      const buffer = Buffer.alloc(8192);
      let size = 0;
      /* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- The stream must stop reading immediately at the byte bound. */
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        if (size + chunk.value.byteLength > buffer.length) {
          await reader.cancel();
          return response({ status: "blocked" });
        }
        buffer.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
      /* oxlint-enable eslint/no-await-in-loop, react-doctor/async-await-in-loop */
      body = signupRequestSchema.parse(JSON.parse(buffer.subarray(0, size).toString("utf-8")));
    } catch {
      return response({ status: "blocked" });
    } finally {
      reader.releaseLock();
    }
    try {
      return response(await continueSignup(request, body));
    } catch {
      return response({ status: "pending" });
    }
  };
