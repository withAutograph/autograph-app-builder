import { disableTool } from "eve/tools";

// Every App Builder phase shares one session-scoped workflow state. Eve's
// recursive agent sessions have independent state, so delegation cannot safely
// record artifacts or continue the root build.
export default disableTool();
