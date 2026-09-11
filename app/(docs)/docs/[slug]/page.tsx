import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { DocsContent } from "../docs-content";
import { docs, getDocument } from "../docs-registry";
import { DocsShell } from "../docs-shell";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return docs
    .filter((document) => document.slug !== "overview")
    .map((document) => ({ slug: document.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const document = getDocument(slug);
  if (!document || document.slug === "overview") return {};
  return {
    title: document.title,
    description: document.description,
  };
}

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
