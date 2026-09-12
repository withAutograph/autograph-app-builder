import ConnectAccess from "@/content/docs/connect-access.mdx";
import CreateAnApp from "@/content/docs/create-an-app.mdx";
import InstallAutograph from "@/content/docs/install-autograph.mdx";
import Overview from "@/content/docs/overview.mdx";
import Troubleshooting from "@/content/docs/troubleshooting.mdx";

import type { DocsDocument } from "./docs-registry";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function DocsContent({ slug }: Pick<DocsDocument, "slug">) {
  switch (slug) {
    case "overview": {
      return <Overview />;
    }
    case "install-autograph": {
      return <InstallAutograph />;
    }
    case "connect-access": {
      return <ConnectAccess />;
    }
    case "create-an-app": {
      return <CreateAnApp />;
    }
    case "troubleshooting": {
      return <Troubleshooting />;
    }
    default: {
      return null;
    }
  }
}
