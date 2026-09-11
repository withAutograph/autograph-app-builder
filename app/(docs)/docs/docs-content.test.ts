import { describe, expect, it } from "vitest";

import {
  docs,
  docsHref,
  getAdjacentDocuments,
  getDocument,
} from "./docs-registry";

describe("documentation registry", () => {
  it("publishes the curated newcomer journey in a stable order", () => {
    expect(docs.map((document) => document.slug)).toEqual([
      "overview",
      "install-autograph",
      "connect-access",
      "create-an-app",
      "troubleshooting",
    ]);
    expect(new Set(docs.map((document) => document.slug))).toHaveLength(
      docs.length
    );
  });

  it("uses only public documentation URLs", () => {
    expect(docs.map(docsHref)).toEqual([
      "/docs",
      "/docs/install-autograph",
      "/docs/connect-access",
      "/docs/create-an-app",
      "/docs/troubleshooting",
    ]);
  });

  it("finds documents and determines adjacent pages", () => {
    const install = getDocument("install-autograph");
    expect(install).toBeDefined();
    expect(getDocument("private-plan")).toBeUndefined();
    expect(getAdjacentDocuments(install!)).toMatchObject({
      previous: { slug: "overview" },
      next: { slug: "connect-access" },
    });
  });
});
