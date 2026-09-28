export type GitHubOperation =
  | "resolve-existing-source"
  | "create-fresh-repository"
  | "publish-draft-pull-request";

export interface GitHubPermissions {
  metadata: "read";
  contents: "read" | "write";
  workflows: "none" | "write";
  pullRequests: "none" | "write";
  administration: "none" | "write";
  variables: "read";
}

// eslint-disable-next-line eslint/func-style -- Preserve existing function declaration semantics.
export function githubPermissionsFor(operation: GitHubOperation): GitHubPermissions {
  switch (operation) {
    case "resolve-existing-source": {
      return {
        administration: "none",
        contents: "read",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "none",
      };
    }
    case "create-fresh-repository": {
      return {
        administration: "write",
        contents: "write",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "write",
      };
    }
    case "publish-draft-pull-request": {
      return {
        administration: "none",
        contents: "write",
        metadata: "read",
        pullRequests: "write",
        variables: "read",
        workflows: "write",
      };
    }
    default: {
      throw new Error("Unsupported GitHub operation.");
    }
  }
}
