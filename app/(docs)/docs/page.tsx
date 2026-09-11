import type { Metadata } from "next";

import { DocsContent } from "./docs-content";
import { docs } from "./docs-registry";
import { DocsShell } from "./docs-shell";

const overview = docs[0];

export const metadata: Metadata = {
  title: "Documentation",
  description: overview.description,
};

export default function DocsPage() {
  return (
    <DocsShell document={overview}>
      <DocsContent slug={overview.slug} />
    </DocsShell>
  );
}
