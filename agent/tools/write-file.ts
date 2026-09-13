import { disableTool } from "eve/tools";

// Writes are introduced through digest-bound workspace tools in the next
// execution slice. Keep the generic writer unavailable until then.
export default disableTool();
