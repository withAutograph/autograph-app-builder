import { disableTool } from "eve/tools";

// Immutable target inspection is exposed only through manifest-bound builder
// tools. A general file reader lets the model guess paths, bypass the prepared
// source manifest, and exhaust a session without producing a plan.
export default disableTool();
