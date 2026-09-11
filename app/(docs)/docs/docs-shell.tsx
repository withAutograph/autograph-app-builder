import type { ReactNode } from "react";

import { ArrowLeft, ArrowRight, BookOpen } from "@geist-ui/icons";
import Link from "next/link";

import {
  docs,
  docsHref,
  getAdjacentDocuments,
  type DocsDocument,
} from "./docs-registry";
import styles from "./docs.module.css";

export function DocsShell({
  children,
  document,
}: {
  children: ReactNode;
  document: DocsDocument;
}) {
  const { next, previous } = getAdjacentDocuments(document);

  return (
    <main className={styles.page} id="main-content">
      <a className={styles.skipLink} href="#docs-article">
        Skip to documentation
      </a>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <BookOpen aria-hidden="true" size={18} />
          <span>Autograph</span>
        </Link>
        <span className={styles.headerLabel}>Documentation</span>
        <Link className={styles.buildLink} href="/">
          Build an app <ArrowRight aria-hidden="true" size={15} />
        </Link>
      </header>
      <div className={styles.layout}>
        <nav aria-label="Documentation" className={styles.sidebar}>
          <p>Get started</p>
          <ul>
            {docs.map((item) => (
              <li key={item.slug}>
                <Link
                  aria-current={
                    item.slug === document.slug ? "page" : undefined
                  }
                  href={docsHref(item)}
                >
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className={styles.article} id="docs-article">
          <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
            <Link href="/">Autograph</Link>
            <span aria-hidden="true">/</span>
            <Link href="/docs">Docs</Link>
            {document.slug === "overview" ? null : (
              <>
                <span aria-hidden="true">/</span>
                <span>{document.title}</span>
              </>
            )}
          </nav>
          <header className={styles.articleHeader}>
            <p>Autograph App Builder</p>
            <h1>{document.title}</h1>
            <p>{document.description}</p>
          </header>
          <div className={styles.content}>{children}</div>
          <nav aria-label="Documentation pages" className={styles.pagination}>
            {previous ? (
              <Link href={docsHref(previous)}>
                <ArrowLeft aria-hidden="true" size={16} />
                <span>
                  <small>Previous</small>
                  {previous.title}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={docsHref(next)}>
                <span>
                  <small>Next</small>
                  {next.title}
                </span>
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            ) : null}
          </nav>
        </article>
        <aside aria-label="On this page" className={styles.toc}>
          <p>On this page</p>
          <ul>
            {document.toc.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`}>{item.label}</a>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
