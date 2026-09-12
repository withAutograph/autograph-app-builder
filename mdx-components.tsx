import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";

function headingId(children: ReactNode) {
  return String(children)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/(^-|-$)/gu, "");
}

const components: MDXComponents = {
  h2: ({ children, ...props }) => (
    <h2 id={headingId(children)} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 id={headingId(children)} {...props}>
      {children}
    </h3>
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}
