/** Keep recovery details in structured results while avoiding a diagnostic dump in chat. */
export const userFacingErrorSummary = (code: string) => {
  if (code === "submission_unknown") {
    return "We couldn’t confirm whether your last action went through. Don’t repeat it yet; check this saved conversation first.";
  }
  if (code === "repository_access_missing") {
    return "GitHub didn’t grant access. Connect GitHub again and choose the requested repository.";
  }
  if (code === "provider_unavailable") {
    return "A connected service is temporarily unavailable. Continue in this conversation when it’s available.";
  }
  if (code === "authentication_required") return "Sign in to Autograph App Builder to continue.";
  if (code === "forbidden") return "Sign in with the account that owns this app to continue.";
  if (code === "session_read_delayed")
    return "The latest progress is taking longer to load. This doesn’t mean work stopped. Wait for the conversation to refresh before approving or reviewing changes.";
  if (code === "cancellation_unsettled")
    return "Your stop request was received and is still in progress. Check this conversation for the outcome.";
  if (code === "send_preflight_unavailable")
    return "Your message was not sent because the conversation could not be checked. Wait for it to refresh before sending your message again.";
  if (code === "session_recovery_unavailable")
    return "We couldn’t recover this session. Keep this conversation and contact support before trying again.";
  if (code === "request_conflict")
    return "This action conflicts with an earlier request. Check this conversation before continuing.";
  if (code === "not_found")
    return "We couldn’t find this app session. Open the right conversation and try again.";
  if (code === "operation_rejected")
    return "We couldn’t complete this action. Check this conversation before trying it again.";
  return "Autograph couldn’t finish this step. Check this conversation before trying again, or contact support for help.";
};
