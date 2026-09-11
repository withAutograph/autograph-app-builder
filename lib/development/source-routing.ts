/**
 * Development runs inspect their immutable snapshot only when the user named
 * the checkout that launched this run. Other paths remain subject to the
 * ordinary allowlist at the inspection boundary.
 */
export function developmentInspectionPath(input: {
  requestedPath: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): string {
  const environment = input.environment ?? process.env;
  if (
    environment.APP_BUILDER_EXECUTION_MODE === "development" &&
    environment.APP_BUILDER_DEVELOPMENT_SOURCE_ROOT === input.requestedPath &&
    environment.APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT !== undefined
  )
    return environment.APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT;
  return input.requestedPath;
}
