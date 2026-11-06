import { z } from "zod";

const resumeKeySchema = z.uuid();
export const providerConnectionReturnToSchema = z.union([
  z.literal("/"),
  z.templateLiteral(["/handoff/", z.uuid()]),
]);

export interface ProviderConnectionReturn {
  returnTo: z.infer<typeof providerConnectionReturnToSchema>;
  resumeKey?: string;
}

type StringOrStrings = string | string[];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
const first = (value: StringOrStrings | undefined) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .parse(value);

const firstValue = (value: StringOrStrings | undefined) => {
  const parsed = first(value);
  return Array.isArray(parsed) ? parsed[0] : parsed;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseProviderConnectionReturn(input: {
  returnTo?: StringOrStrings;
  resumeKey?: StringOrStrings;
}): ProviderConnectionReturn {
  const returnTo = firstValue(input.returnTo);
  const resumeKey = firstValue(input.resumeKey);
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
  const formDataSchema = z.object({
    resumeKey: z.string().optional(),
    returnTo: z.string().optional(),
  });
  const { resumeKey, returnTo } = formDataSchema.parse({
    resumeKey: formData.get("resumeKey") ?? undefined,
    returnTo: formData.get("returnTo") ?? undefined,
  });
  return parseProviderConnectionReturn({
    resumeKey,
    returnTo,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function safeProviderConnectionReturn(input: {
  returnTo?: StringOrStrings;
  resumeKey?: StringOrStrings;
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
  if (input.status === "failed" && input.reason !== undefined && input.reason !== "") {
    url.searchParams.set(`${input.provider}Reason`, input.reason);
  }
  if (input.returnState?.resumeKey !== undefined && input.returnState.resumeKey !== "") {
    url.searchParams.set("resume", input.returnState.resumeKey);
  }
  return url.toString();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseProviderResumeKey(value: StringOrStrings | undefined) {
  const parsed = resumeKeySchema.safeParse(firstValue(value));
  return parsed.success ? parsed.data : undefined;
}
