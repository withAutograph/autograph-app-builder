declare module "*.mdx" {
  import type { MDXComponents } from "mdx/types";
  import type { ComponentType } from "react";

  const MDXContent: ComponentType<{ components?: MDXComponents }>;
  export default MDXContent;
}
