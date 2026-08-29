import { z } from "zod";

const resumeKeySchema = z.string().uuid();
const returnToSchema = z.literal("/");

export type ProviderConnectionReturn = {
  returnTo: "/";
  resumeKey?: string;
};

function first(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

export function parseProviderConnectionReturn(input: {
  returnTo?: string | string[];
  resumeKey?: string | string[];
}): ProviderConnectionReturn {
  const returnTo = first(input.returnTo);
  const resumeKey = first(input.resumeKey);
  return {
    returnTo: returnToSchema.parse(returnTo ?? "/"),
    ...(resumeKey === undefined
      ? {}
      : { resumeKey: resumeKeySchema.parse(resumeKey) }),
  };
}

export function providerConnectionReturnFromFormData(
  formData: FormData,
): ProviderConnectionReturn {
  return parseProviderConnectionReturn({
    returnTo: formData.get("returnTo")?.toString(),
    resumeKey: formData.get("resumeKey")?.toString(),
  });
}

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

export function providerConnectionRedirect(input: {
  origin: string;
  provider: "vercel" | "github";
  status: "connected" | "failed";
  reason?: string;
  returnState?: ProviderConnectionReturn;
}) {
  const url = new URL(input.returnState?.returnTo ?? "/", input.origin);
  url.searchParams.set(input.provider, input.status);
  if (input.status === "failed" && input.reason)
    url.searchParams.set(`${input.provider}Reason`, input.reason);
  if (input.returnState?.resumeKey)
    url.searchParams.set("resume", input.returnState.resumeKey);
  return url.toString();
}

export function parseProviderResumeKey(value: string | string[] | undefined) {
  const parsed = resumeKeySchema.safeParse(first(value));
  return parsed.success ? parsed.data : undefined;
}
