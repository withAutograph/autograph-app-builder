/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { disableTool } from "eve/tools";

// Writes are introduced through digest-bound workspace tools in the next
// execution slice. Keep the generic writer unavailable until then.
export default disableTool();
