export class ExistingAppChangePreimageError extends Error {
  readonly code = "existing_app_change_preimage_missing" as const;
  readonly rejectedPaths: readonly string[];
  readonly exactAppOwnedPaths: readonly string[];

  constructor(input: { rejectedPaths: readonly string[]; exactAppOwnedPaths: readonly string[] }) {
    const repair = {
      code: "existing_app_change_preimage_missing",
      rejectedPaths: [...input.rejectedPaths],
      exactAppOwnedPaths: [...input.exactAppOwnedPaths],
      next: "Inspect only the listed exact paths, draft replacements from their returned contents, and retry target planning without resolving or preparing the source again.",
    } as const;
    super(`Existing-app changes require exact source preimages. ${JSON.stringify(repair)}`);
    this.name = "ExistingAppChangePreimageError";
    this.rejectedPaths = repair.rejectedPaths;
    this.exactAppOwnedPaths = repair.exactAppOwnedPaths;
  }
}
