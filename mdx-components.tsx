import type { MDXComponents } from "mdx/types";
import type { ComponentProps, ReactNode } from "react";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function headingId(children: ReactNode) {
  // oxlint-disable-next-line typescript/no-base-to-string -- Preserve React child coercion when deriving the heading identifier.
  return String(children)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/(?<edge>^-|-$)/gu, "");
}

const components: MDXComponents = {
  h2: ({ children, ...props }: ComponentProps<"h2">) => (
    <h2 id={headingId(children)} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentProps<"h3">) => (
    <h3 id={headingId(children)} {...props}>
      {children}
    </h3>
  ),
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function useMDXComponents(): MDXComponents {
  return components;
}
