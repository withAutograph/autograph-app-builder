import type { MDXComponents } from "mdx/types";
import type { ComponentType } from "react";

import ConnectAccess from "@/content/docs/connect-access.mdx";
import CreateAnApp from "@/content/docs/create-an-app.mdx";
import InstallAutograph from "@/content/docs/install-autograph.mdx";
import Overview from "@/content/docs/overview.mdx";
import Troubleshooting from "@/content/docs/troubleshooting.mdx";

import type { DocsDocument } from "./docs-registry";

const contentBySlug: Record<
  DocsDocument["slug"],
  ComponentType<{ components?: MDXComponents }>
> = {
  overview: Overview,
  "install-autograph": InstallAutograph,
  "connect-access": ConnectAccess,
  "create-an-app": CreateAnApp,
  troubleshooting: Troubleshooting,
};

export function getDocumentContent(document: DocsDocument) {
  return contentBySlug[document.slug];
}
