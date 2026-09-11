export type BuildDestination = "web" | "codex" | "cursor";

export type BuilderForm = {
  appName: string;
  repository: string;
  brief: string;
  privateRepository: boolean;
  buildDestination: BuildDestination;
  connections: string[];
  vercelInstallationId?: string;
  githubInstallationId?: string;
  modelId: string;
};

export type ProviderField = "vercel" | "github";
export type StorageProvider = "github" | "gitlab" | "bitbucket";
export type DeploymentProvider = "vercel" | "netlify" | "cloudflare";

export type BuilderDraft = {
  version: 1;
  form: BuilderForm;
  team: string;
  gitScope: string;
  model: string;
  zdrOnly: boolean;
  showMoreConnections: boolean;
  search: string;
  connectedConnections: string[];
  storageProvider?: StorageProvider | null;
  deploymentProvider?: DeploymentProvider | null;
  focusOrigin: ProviderField;
  appNameEditedByUser: boolean;
  repositoryEditedByUser: boolean;
};
