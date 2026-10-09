/** SDK creation source for the deployment-owned immutable worker filesystem. */
export type HostedOperatorSandboxSource =
  | { image: string }
  | { source: { type: "snapshot"; snapshotId: string } };

/** Snapshot-backed Sandboxes use source, while existing image-backed configurations keep image. */
export const hostedOperatorSandboxSourceOptions = (configuration: HostedOperatorSandboxSource) =>
  "source" in configuration ? { source: configuration.source } : { image: configuration.image };
