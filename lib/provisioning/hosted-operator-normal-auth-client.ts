import { Cookie, CookieJar } from "tough-cookie";
import { z } from "zod";
import type { NormalBrowserStorageState } from "./hosted-operator-normal-actor-program";

const id = z.string().min(1).max(512);
const email = z.email().max(320);
const credentials = z.object({ email, password: z.string().min(1).max(1024) });
const signUpInput = credentials.extend({ name: z.string().min(1).max(120) });
const organizationInput = z.object({ organizationId: id });
const invitationSchema = z.object({
  id,
  email,
  role: id,
  organizationId: id,
  status: z.enum(["pending", "accepted", "rejected", "canceled"]),
  expiresAt: z.iso.datetime({ offset: true }),
});
const memberSchema = z.object({ id, userId: id, organizationId: id, role: id });
const membersSchema = z.object({
  members: z.array(memberSchema.extend({ user: z.object({ id, email }) })),
  total: z.number().int().nonnegative(),
});
const sessionSchema = z
  .object({
    session: z.object({ id, userId: id, expiresAt: z.iso.datetime({ offset: true }) }),
    user: z.object({ id, email }),
  })
  .nullable();

export interface NormalAuthSession {
  actorId: string;
  sessionId: string;
  email: string;
  expiresAt: string;
}
export type NormalAuthInvitation = z.infer<typeof invitationSchema>;
export type NormalAuthMember = z.infer<typeof memberSchema>;
export type NormalAuthOperation =
  | "sign_up"
  | "sign_in"
  | "get_session"
  | "invite_member"
  | "accept_invitation"
  | "list_invitations"
  | "list_members";

/** Private orchestration port: none of these credential/session values are public tool results. */
export interface NormalAuthClient {
  signUp: (input: { email: string; password: string; name: string }) => Promise<void>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  getSession: () => Promise<NormalAuthSession | null>;
  inviteMember: (input: {
    organizationId: string;
    email: string;
    role: string;
  }) => Promise<NormalAuthInvitation>;
  acceptInvitation: (input: { invitationId: string }) => Promise<{
    invitation: NormalAuthInvitation;
    member: NormalAuthMember;
  }>;
  listInvitations: (input: { organizationId: string }) => Promise<NormalAuthInvitation[]>;
  /** Optional actor filter makes uncertainty readback independent of the server's first page. */
  listMembers: (input: {
    organizationId: string;
    userId?: string;
  }) => Promise<z.infer<typeof membersSchema>>;
  exportStorageState: () => NormalBrowserStorageState;
}

const errorCodes = z.enum([
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  "INVALID_EMAIL_OR_PASSWORD",
  "EMAIL_NOT_VERIFIED",
  "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
  "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
  "INVITATION_NOT_FOUND",
  "ORGANIZATION_NOT_FOUND",
  "MEMBER_NOT_FOUND",
  "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
  "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
  "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
]);
type Failure =
  | "invalid_origin"
  | "invalid_storage_state"
  | "invalid_input"
  | "approval_required"
  | "transport_failed"
  | "auth_rejected"
  | "invalid_response";

/** Deliberately has no raw body, cause, request URL, cookies, credentials, or server message. */
export class NormalAuthClientError extends Error {
  readonly code: Failure;
  readonly operation?: NormalAuthOperation;
  readonly httpStatus?: number;
  readonly authCode?: z.infer<typeof errorCodes>;

  constructor(
    code: Failure,
    details: {
      operation?: NormalAuthOperation;
      httpStatus?: number;
      authCode?: z.infer<typeof errorCodes>;
    } = {},
  ) {
    super(`Normal Auth operation failed (${code}).`);
    this.name = "NormalAuthClientError";
    this.code = code;
    this.operation = details.operation;
    this.httpStatus = details.httpStatus;
    this.authCode = details.authCode;
  }
}

const parseInput = <T>(schema: z.ZodType<T>, value: T, operation: NormalAuthOperation): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new NormalAuthClientError("invalid_input", { operation });
  }
  return parsed.data;
};

const maximumResponseBytes = 128 * 1024;
const readJson = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.body) {
    throw new Error("Missing body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // A stream reader permits one outstanding read; check the byte bound between chunks.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximumResponseBytes) {
        // oxlint-disable-next-line no-await-in-loop -- cancel the same reader before discarding its bytes.
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
};

const receiveCookies = (jar: CookieJar, response: Response, url: URL): void => {
  // Never split on commas: Expires contains a comma and headers may contain several cookies.
  for (const setCookie of response.headers.getSetCookie()) {
    const parsed = Cookie.parse(setCookie);
    if (!parsed || (parsed.sameSite === "none" && !parsed.secure)) {
      continue;
    }
    // tough-cookie 5 computes Max-Age from last access. HTTP expiry is fixed at receipt;
    // convert it once so readback and private resume cannot extend an existing session.
    if (parsed.maxAge !== null) {
      const expires = parsed.expiryTime(new Date());
      parsed.expires = new Date(Math.max(0, Math.min(expires ?? 0, 8_640_000_000_000_000)));
      parsed.maxAge = null;
    }
    // Browsers ignore invalid cookies; do not rewrite a rejected Domain into this origin.
    jar.setCookieSync(parsed, url.href, { ignoreError: true });
  }
};

const rejectedResponse = async (
  response: Response,
  operation: NormalAuthOperation,
): Promise<NormalAuthClientError> => {
  let authCode: z.infer<typeof errorCodes> | undefined;
  try {
    const parsed = await readJson(response, z.object({ code: errorCodes }));
    authCode = parsed.code;
  } catch {
    // Error bodies are untrusted and stay private, including malformed or oversized responses.
  }
  return new NormalAuthClientError("auth_rejected", {
    operation,
    httpStatus: response.status,
    ...(authCode ? { authCode } : {}),
  });
};

const cookieSameSite = (cookie: Cookie): "Strict" | "None" | "Lax" => {
  if (cookie.sameSite === "strict") {
    return "Strict";
  }
  if (cookie.sameSite === "none") {
    return "None";
  }
  return "Lax";
};

/**
 * The coordinator supplies the reviewed journal-owned origin and private transport.
 * Only fixed ordinary Auth endpoints are reachable; callers cannot supply a URL or headers.
 * Password generation and durable private checkpointing belong to the coordinator before effects.
 */
export const createHostedOperatorNormalAuthClient = (options: {
  origin: string;
  storageState?: NormalBrowserStorageState;
  fetch?: typeof fetch;
  assertApprovedEffect?: (operation: NormalAuthOperation) => Promise<void>;
}): NormalAuthClient => {
  let origin: URL;
  try {
    origin = new URL(options.origin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== options.origin ||
      origin.username ||
      origin.password
    ) {
      throw new Error("Invalid origin");
    }
  } catch {
    throw new NormalAuthClientError("invalid_origin");
  }
  const jar = new CookieJar(undefined, { prefixSecurity: "strict", allowSpecialUseDomain: false });
  try {
    for (const saved of options.storageState?.cookies ?? []) {
      const cookie = new Cookie({
        key: saved.name,
        value: saved.value,
        domain: saved.domain.replace(/^\./u, ""),
        hostOnly: !saved.domain.startsWith("."),
        path: saved.path,
        expires: saved.expires === -1 ? "Infinity" : new Date(saved.expires * 1000),
        secure: saved.secure,
        httpOnly: saved.httpOnly,
        sameSite: saved.sameSite.toLowerCase(),
      });
      // Restore only cookies for this actual origin, without changing a Domain or Path.
      if (cookie.hostOnly === true && cookie.domain !== origin.hostname) {
        throw new Error("Different host");
      }
      jar.setCookieSync(cookie, origin.href);
    }
    if ((options.storageState?.origins.length ?? 0) > 0) {
      throw new Error("Auth client has no local storage");
    }
  } catch {
    throw new NormalAuthClientError("invalid_storage_state");
  }

  const request = async <T>(
    operation: NormalAuthOperation,
    path: string,
    schema: z.ZodType<T>,
    input?: Record<string, string>,
    query?: Record<string, string>,
  ): Promise<T> => {
    const url = new URL(`/api/auth/${path}`, origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    if (input !== undefined) {
      if (!options.assertApprovedEffect) {
        throw new NormalAuthClientError("approval_required", { operation });
      }
      try {
        await options.assertApprovedEffect(operation);
      } catch {
        throw new NormalAuthClientError("approval_required", { operation });
      }
    }
    const headers = new Headers({ accept: "application/json", origin: origin.origin });
    const cookie = jar.getCookieStringSync(url.href, { sameSiteContext: "strict" });
    if (cookie) {
      headers.set("cookie", cookie);
    }
    if (input !== undefined) {
      headers.set("content-type", "application/json");
    }
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, {
        method: input === undefined ? "GET" : "POST",
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== origin.origin)) {
        throw new Error("Unexpected redirect");
      }
    } catch {
      throw new NormalAuthClientError("transport_failed", { operation });
    }
    receiveCookies(jar, response, url);
    if (!response.ok) {
      throw await rejectedResponse(response, operation);
    }
    try {
      return await readJson(response, schema);
    } catch {
      throw new NormalAuthClientError("invalid_response", {
        operation,
        httpStatus: response.status,
      });
    }
  };

  return {
    async signUp(input) {
      await request(
        "sign_up",
        "sign-up/email",
        z.object({ user: z.object({ id, email }) }),
        parseInput(signUpInput, input, "sign_up"),
      );
    },
    async signIn(input) {
      await request(
        "sign_in",
        "sign-in/email",
        z.object({ user: z.object({ id, email }) }),
        parseInput(credentials, input, "sign_in"),
      );
    },
    async getSession() {
      const value = await request("get_session", "get-session", sessionSchema, undefined, {
        disableRefresh: "true",
        disableCookieCache: "true",
      });
      if (value === null) {
        return null;
      }
      if (value.session.userId !== value.user.id) {
        throw new NormalAuthClientError("invalid_response", { operation: "get_session" });
      }
      return {
        actorId: value.user.id,
        sessionId: value.session.id,
        email: value.user.email,
        expiresAt: value.session.expiresAt,
      };
    },
    async inviteMember(input) {
      return await request(
        "invite_member",
        "organization/invite-member",
        invitationSchema,
        parseInput(organizationInput.extend({ email, role: id }), input, "invite_member"),
      );
    },
    async acceptInvitation(input) {
      return await request(
        "accept_invitation",
        "organization/accept-invitation",
        z.object({ invitation: invitationSchema, member: memberSchema }),
        parseInput(z.object({ invitationId: id }), input, "accept_invitation"),
      );
    },
    async listInvitations(input) {
      const parsed = parseInput(organizationInput, input, "list_invitations");
      return await request(
        "list_invitations",
        "organization/list-invitations",
        z.array(invitationSchema),
        undefined,
        parsed,
      );
    },
    async listMembers(input) {
      const parsed = parseInput(
        organizationInput.extend({ userId: id.optional() }),
        input,
        "list_members",
      );
      return await request("list_members", "organization/list-members", membersSchema, undefined, {
        organizationId: parsed.organizationId,
        ...(parsed.userId === undefined
          ? {}
          : { filterField: "userId", filterValue: parsed.userId, filterOperator: "eq" }),
      });
    },
    exportStorageState() {
      const now = Date.now();
      const cookies = (jar.serializeSync()?.cookies ?? []).flatMap((saved) => {
        const cookie = Cookie.fromJSON(saved);
        if (!cookie) {
          return [];
        }
        const expires = cookie.expiryTime() ?? Infinity;
        if (expires <= now) {
          return [];
        }
        return [
          {
            name: cookie.key,
            value: cookie.value,
            domain: `${cookie.hostOnly === true ? "" : "."}${cookie.domain}`,
            path: cookie.path ?? "/",
            expires: Number.isFinite(expires) ? expires / 1000 : -1,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookieSameSite(cookie),
          },
        ];
      });
      return { cookies, origins: [] };
    },
  };
};
