export const selectVendorReviewSourcePath = (paths: readonly string[]): string | undefined =>
  paths.find((path) => path.endsWith("/frontend/src/review/ReviewQueueServerPage.tsx")) ??
  paths.find((path) => path.endsWith("/app/vendor/review-queue/page.tsx")) ??
  paths.find((path) => /(?:^|\/)page[.]tsx$/u.test(path)) ??
  paths.find((path) => /[.]tsx$/u.test(path)) ??
  paths.at(0);

export const addVendorTaxVerificationStatus = (
  files: readonly { content: string; path: string }[],
): { content: string; path: string }[] =>
  files.flatMap(({ path, content }) => {
    const changed = content.replace(
      /(?<opening>return\s*\(\s*<(?:main|div|section)\b[^>]*>)/u,
      (opening) =>
        `${opening}\n<p data-vendor-review-status="tax-verification">Tax verification required</p>`,
    );
    return changed === content ? [] : [{ content: changed, path }];
  });
