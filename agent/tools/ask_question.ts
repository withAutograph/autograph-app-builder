import { askQuestion } from "eve/tools/ask_question";
import { defineWorkflowTool } from "eve/tools";

import { productQuestionInputSchema } from "@/lib/agent/product-question-policy";

const nativeQuestion = askQuestion();

export default defineWorkflowTool({
  ...nativeQuestion,
  description:
    "Ask one concise product question only when the answer would materially change the app's users, behavior, data meaning, roles, retention or intended outcome. Explain the decision in familiar words and offer 2-3 clear, mutually exclusive options, with the recommended choice first and marked (Recommended); omit an Other option because free text remains available. Infer ordinary defaults. Synthetic verification actors and tenant/role fixture layout belong to Builder: derive them from accepted permissions and required coverage, never ask users to design that mapping. Empty app roles mean no app assignment. Preserve the real owner's existing tenant and membership; account creation and access changes need exact effect review. Product roles and tenant meaning for real people remain ordinary choices. Keep repository references, source lookup, checkout setup and recovery internal; never ask users to find branches, PRs, commit IDs or fix Builder setup. Use source_status and resolve_github_source to distinguish the selected platform branch from the saved historical app baseline. A recovery or synthetic-fixture validation error is Builder work, not a user decision. Outward effects use their specific approval tools. Questions about which connected provider account to use remain ordinary choices.",
  inputSchema: productQuestionInputSchema,
});
