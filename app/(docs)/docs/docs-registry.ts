export interface DocsTableOfContentsItem {
  id: string;
  label: string;
}

export interface DocsDocument {
  slug: "overview" | "install-autograph" | "connect-access" | "create-an-app" | "troubleshooting";
  title: string;
  description: string;
  toc: DocsTableOfContentsItem[];
}

export const docs: readonly DocsDocument[] = [
  {
    slug: "overview",
    title: "Welcome to Autograph",
    description: "Learn how Autograph App Builder turns a product idea into a working application.",
    toc: [
      { id: "what-you-can-do", label: "What you can do" },
      { id: "your-first-app", label: "Your first app" },
      { id: "where-to-go-next", label: "Where to go next" },
    ],
  },
  {
    slug: "install-autograph",
    title: "Install Autograph",
    description: "Install Autograph App Builder and start your first Codex task.",
    toc: [
      { id: "confirm-the-installation", label: "Confirm the installation" },
      { id: "sign-in-when-prompted", label: "Sign in when prompted" },
      {
        id: "update-an-existing-installation",
        label: "Update an existing installation",
      },
    ],
  },
  {
    slug: "connect-access",
    title: "Connect accounts and access",
    description: "Connect Autograph to the accounts and repositories you choose.",
    toc: [
      { id: "sign-in-to-autograph", label: "Sign in to Autograph" },
      { id: "give-repository-access", label: "Give repository access" },
      {
        id: "connect-services-when-needed",
        label: "Connect services when needed",
      },
      { id: "you-stay-in-control", label: "You stay in control" },
    ],
  },
  {
    slug: "create-an-app",
    title: "Create an app",
    description: "Start with an outcome, review the product, and choose where it lives when ready.",
    toc: [
      { id: "start-with-the-outcome", label: "Start with the outcome" },
      { id: "review-and-refine", label: "Review and refine" },
      { id: "choose-where-it-lives", label: "Choose where it lives" },
      { id: "keep-going-later", label: "Keep going later" },
    ],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description:
      "Resolve common installation, sign-in, repository, and provider connection issues.",
    toc: [
      {
        id: "autograph-is-not-available-in-a-task",
        label: "Autograph is not available in a task",
      },
      {
        id: "the-browser-asks-you-to-sign-in-again",
        label: "The browser asks you to sign in again",
      },
      { id: "a-repository-is-not-listed", label: "A repository is not listed" },
      {
        id: "a-provider-connection-did-not-finish",
        label: "A provider connection did not finish",
      },
      { id: "you-want-to-change-an-app", label: "You want to change an app" },
    ],
  },
];

export function docsHref(document: DocsDocument) {
  return document.slug === "overview" ? "/docs" : `/docs/${document.slug}`;
}

export function getDocument(slug: string) {
  return docs.find((document) => document.slug === slug);
}

export function getAdjacentDocuments(document: DocsDocument) {
  const index = docs.indexOf(document);
  return {
    previous: index > 0 ? docs[index - 1] : undefined,
    next: index < docs.length - 1 ? docs[index + 1] : undefined,
  };
}
