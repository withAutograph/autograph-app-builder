import { askQuestion } from "eve/tools/ask_question";
import { defineWorkflowTool } from "eve/tools";

import { productQuestionInputSchema } from "@/lib/agent/product-question-policy";

const nativeQuestion = askQuestion();

export default defineWorkflowTool({
  ...nativeQuestion,
  description:
    "Ask one material product question whose answer changes the app's users, behavior, data meaning, roles, retention or intended outcome. Infer ordinary defaults. Repository refs, source lookup, checkout preparation and recovery belong to Builder; never ask the user to find branches, PRs, commit SHAs or fix setup. Use source_status and resolve_github_source to distinguish the selected platform branch from the saved historical app baseline. A repository-recovery validation error means perform that Builder work; it is not a user answer or approval. Outward effects use their specific approval tools. For product choices offer 2-3 mutually exclusive options, recommended first with (Recommended) in its label; omit Other because free text is available. Questions about which already connected provider account to use remain ordinary choices.",
  inputSchema: productQuestionInputSchema,
});
