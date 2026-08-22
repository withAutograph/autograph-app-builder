import { disableTool } from "eve/tools";

// Repository execution is exposed only through phase-specific, approval-aware
// builder tools. A general shell would bypass those authority boundaries.
export default disableTool();
