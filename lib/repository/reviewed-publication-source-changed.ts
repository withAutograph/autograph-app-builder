/** Observed bytes no longer match this app's reviewed publication subject. */
export class ReviewedPublicationSourceChangedError extends Error {
  readonly appId: string;
  readonly reviewDigest: string;
  readonly path?: string;

  constructor(input: { appId: string; reviewDigest: string; path?: string }) {
    super(
      "The selected app changed after review. Review its current files again before publishing the draft pull request.",
    );
    this.name = "ReviewedPublicationSourceChangedError";
    this.appId = input.appId;
    this.reviewDigest = input.reviewDigest;
    if (input.path !== undefined) {
      this.path = input.path;
    }
  }
}
