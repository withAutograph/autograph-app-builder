import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { DocsContent } from "../docs-content";
import { docs, getDocument } from "../docs-registry";
import { DocsShell } from "../docs-shell";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function generateStaticParams() {
  return docs
    .filter((document) => document.slug !== "overview")
    .map((document) => ({ slug: document.slug }));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const document = getDocument(slug);
  if (!document || document.slug === "overview") return {};
  return {
    title: document.title,
    description: document.description,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function DocumentContent({ params }: PageProps) {
  const { slug } = await params;
  const document = getDocument(slug);
  if (!document || document.slug === "overview") notFound();
  return (
    <DocsShell document={document}>
      <DocsContent slug={document.slug} />
    </DocsShell>
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function DocsLoading() {
  return <main aria-busy="true" className="min-h-screen" />;
}

export default function DocumentPage(props: PageProps) {
  return (
    <Suspense fallback={<DocsLoading />}>
      <DocumentContent {...props} />
    </Suspense>
  );
}
