import { z } from "zod";

const resumeKeySchema = z.uuid();
export const providerConnectionReturnToSchema = z.union([
  z.literal("/"),
  z
    .string()
    .refine((value) => value.startsWith("/handoff/") && z.uuid().safeParse(value.slice(9)).success)
    .transform((value) => value as `/handoff/${string}`),
]);

export interface ProviderConnectionReturn {
  returnTo: z.infer<typeof providerConnectionReturnToSchema>;
  resumeKey?: string;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function first(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseProviderConnectionReturn(input: {
  returnTo?: string | string[];
  resumeKey?: string | string[];
}): ProviderConnectionReturn {
  const returnTo = first(input.returnTo);
  const resumeKey = first(input.resumeKey);
  const result: ProviderConnectionReturn = {
    returnTo: providerConnectionReturnToSchema.parse(returnTo ?? "/"),
  };
  if (resumeKey !== undefined) {
    result.resumeKey = resumeKeySchema.parse(resumeKey);
  }
  return result;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function providerConnectionReturnFromFormData(formData: FormData): ProviderConnectionReturn {
  return parseProviderConnectionReturn({
    // oxlint-disable-next-line typescript/no-base-to-string -- Preserve FormData conversion for both string and File entries.
    resumeKey: formData.get("resumeKey")?.toString(),
    // oxlint-disable-next-line typescript/no-base-to-string -- Preserve FormData conversion for both string and File entries.
    returnTo: formData.get("returnTo")?.toString(),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function safeProviderConnectionReturn(input: {
  returnTo?: string | string[];
  resumeKey?: string | string[];
}): ProviderConnectionReturn {
  try {
    return parseProviderConnectionReturn(input);
  } catch {
    return { returnTo: "/" };
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function providerConnectionRedirect(input: {
  origin: string;
  provider: "vercel" | "github";
  status: "connected" | "failed";
  reason?: string;
  returnState?: ProviderConnectionReturn;
}) {
  const url = new URL(
    providerConnectionReturnToSchema.parse(input.returnState?.returnTo ?? "/"),
    input.origin,
  );
  url.searchParams.set(input.provider, input.status);
  if (input.status === "failed" && input.reason) {
    url.searchParams.set(`${input.provider}Reason`, input.reason);
  }
  if (input.returnState?.resumeKey) {
    url.searchParams.set("resume", input.returnState.resumeKey);
  }
  return url.toString();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseProviderResumeKey(value: string | string[] | undefined) {
  const parsed = resumeKeySchema.safeParse(first(value));
  return parsed.success ? parsed.data : undefined;
}
