import { askQuestion } from "eve/tools/ask_question";
import { defineWorkflowTool } from "eve/tools";

import { productQuestionInputSchema } from "@/lib/agent/product-question-policy";

const nativeQuestion = askQuestion();

export default defineWorkflowTool({
  ...nativeQuestion,
  description:
    "Ask one material product question whose answer changes the app's users, behavior, data meaning, roles, retention or intended outcome. Infer ordinary defaults. Synthetic verification actors and their tenant/role fixture layout belong to Builder: derive them from accepted permissions and required coverage, never ask the user to design that mapping. Empty app roles mean no app assignment. Preserve the real owner's existing tenant and membership; real account creation and access changes still require exact effect review. Questions about real people, their product roles and tenant meaning remain ordinary choices. Repository refs, source lookup, checkout preparation and recovery belong to Builder; never ask the user to find branches, PRs, commit SHAs or fix setup. Use source_status and resolve_github_source to distinguish the selected platform branch from the saved historical app baseline. A source-recovery or synthetic-fixture validation error means perform that Builder work; it is not a user answer or approval. Outward effects use their specific approval tools. For product choices offer 2-3 mutually exclusive options, recommended first with (Recommended) in its label; omit Other because free text is available. Questions about which already connected provider account to use remain ordinary choices.",
  inputSchema: productQuestionInputSchema,
});
