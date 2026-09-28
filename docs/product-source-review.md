# Product source review

After app validation, Builder reads selected app source, changed paths, and root
manifests through the Sandbox byte stream. It hashes each complete file against
the observed overlay and sends source to the independent reviewer in bounded
pages. The page size manages one model request; it is not a file or repository
size ceiling. A line longer than one page is split with its original starting
line and column recorded.

The reviewer assesses pages in source order. It may cite only exact excerpts
within the supplied page, using line numbers relative to that page. Builder
checks each excerpt and requirement quote mechanically, then translates valid
citations to original file line numbers. A changed file digest, changed overlay
tree, failed model page, or invalid citation prevents a completed assessment.
Runtime behavior remains unassessed by source review; executed product checks
provide separate evidence.
