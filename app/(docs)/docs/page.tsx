import type { Metadata } from "next";

import { getDocumentContent } from "./docs-content";
import { docs } from "./docs-registry";
import { DocsShell } from "./docs-shell";

const overview = docs[0];

export const metadata: Metadata = {
  title: "Documentation",
  description: overview.description,
};

export default function DocsPage() {
  const Content = getDocumentContent(overview);
  return (
    <DocsShell document={overview}>
      <Content />
    </DocsShell>
  );
}
