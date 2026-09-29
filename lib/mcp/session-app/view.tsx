import { useMemo, useState } from "react";
import { FaGithub } from "react-icons/fa";

import { ChoiceCard, SectionShell } from "../../../components/create-app/choice-card";
import {
  githubConnectionPrompt,
  githubRepositoryAccessViewModel,
} from "../../integrations/store-in-view-model";
import type { EveSessionResult, PublicInputRequest } from "../contracts";
import { ApprovalRequest } from "./approval-request";
import "./styles.css";

export type SessionAnswer =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "answer"; value: string; optionId?: string };

export interface SessionResponse {
  requestId: string;
  response: SessionAnswer;
}

interface DecisionOutcome {
  request: PublicInputRequest;
  response: SessionAnswer;
  status: "failed" | "submitting" | "submitted";
}

// A binary confirmation is an action choice. Keep ordinary two-option
// questions (such as account selection) in the standard choice control.
const binaryDecisionOptions = (request: PublicInputRequest) => {
  if (request.kind !== "question" || request.options?.length !== 2) {
    return null;
  }
  const positive = /^(?:accept|approve|confirm|publish|update|yes)\b/iu;
  const negative = /^(?:cancel|decline|deny|no|do not|don't)\b/iu;
  const [first, second] = request.options;
  if (!first || !second) {
    return null;
  }
  if (positive.test(first.label) && negative.test(second.label)) {
    return [first, second] as const;
  }
  if (positive.test(second.label) && negative.test(first.label)) {
    return [second, first] as const;
  }
  return null;
};

const answerForOption = (option: { id: string; label: string }): SessionAnswer => ({
  kind: "answer",
  optionId: option.id,
  value: option.label,
});

const draftPullRequestNumber = (title: string) =>
  /\bdraft PR (?<number>#\d+)/iu.exec(title)?.groups?.number;

const isDecisionRequest = (request?: PublicInputRequest) =>
  request !== undefined && (request.kind === "approval" || binaryDecisionOptions(request) !== null);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function InputControl({
  answer,
  isSubmitting = false,
  onAnswer,
  request,
}: {
  answer?: SessionAnswer;
  isSubmitting?: boolean;
  onAnswer: (answer: SessionAnswer) => void;
  request: PublicInputRequest;
}) {
  if (request.kind === "approval") {
    return (
      <ApprovalRequest
        description={request.description}
        isSubmitting={isSubmitting}
        onAnswer={onAnswer}
        title={request.title}
      />
    );
  }

  if (request.options?.length) {
    return (
      <div className="choices" role="radiogroup" aria-label={request.title}>
        {request.options.map((option) => {
          const selected = answer?.kind === "answer" && answer.optionId === option.id;
          return (
            <ChoiceCard
              key={option.id}
              checked={selected}
              inputType="radio"
              name={request.requestId}
              value={option.id}
              icon={
                selected ? (
                  <span className="choice-icon" aria-hidden="true">
                    ✓
                  </span>
                ) : undefined
              }
              onChange={() =>
                onAnswer({
                  kind: "answer",
                  optionId: option.id,
                  value: option.label,
                })
              }
            >
              {option.label}
            </ChoiceCard>
          );
        })}
      </div>
    );
  }

  if (request.allowFreeform) {
    return (
      <textarea
        aria-label={request.title}
        value={answer?.kind === "answer" ? answer.value : ""}
        placeholder="Enter your answer…"
        onChange={(event) => onAnswer({ kind: "answer", value: event.target.value })}
      />
    );
  }

  return <p className="fallback">Answer this request in chat to continue.</p>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function AuthorizationControl({
  canOpen,
  onOpenLink,
  request,
}: {
  canOpen: boolean;
  onOpenLink: (url: string) => Promise<void>;
  request: PublicInputRequest;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const challenge = request.authorization;
  const storeIn = challenge?.repositoryAccess
    ? githubRepositoryAccessViewModel(challenge.repositoryAccess)
    : undefined;
  const isGitHub = storeIn !== undefined;
  const provider = isGitHub ? "Connect GitHub" : challenge?.displayName || request.title;

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function connect() {
    if (!challenge?.url || !canOpen) {
      return;
    }
    setError("");
    try {
      await onOpenLink(challenge.url);
      setOpened(true);
    } catch {
      setError("The GitHub page could not be opened. Try again.");
    }
  }

  return (
    <div className="authorization-card">
      <span className="provider-icon" aria-hidden="true">
        {isGitHub ? <FaGithub size={23} /> : provider.trim().slice(0, 1).toUpperCase() || "A"}
      </span>
      <div className="authorization-content">
        <strong>{provider}</strong>
        <p>
          {isGitHub
            ? githubConnectionPrompt(storeIn.desiredRepository)
            : challenge?.instructions || request.description}
        </p>
        {challenge?.userCode ? (
          <code aria-label="Authorization code">{challenge.userCode}</code>
        ) : null}
      </div>
      {challenge?.url ? (
        <button
          type="button"
          className="authorization-action"
          onClick={connect}
          disabled={!canOpen}
        >
          {isGitHub ? "Continue with GitHub" : "Continue"}
        </button>
      ) : null}
      {opened && isGitHub ? (
        <p className="authorization-status" role="status">
          Complete the GitHub step, then return here. Autograph will show whether access was
          confirmed.
        </p>
      ) : null}
      {!canOpen && challenge?.url ? (
        <p className="fallback">Open the authorization link from chat.</p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function SessionRequestControl({
  answer,
  canOpenLinks,
  isSubmitting,
  onlyDecision,
  onAnswer,
  onDecision,
  onOpenLink,
  request,
}: {
  answer?: SessionAnswer;
  canOpenLinks: boolean;
  isSubmitting: boolean;
  onlyDecision: boolean;
  onAnswer: (answer: SessionAnswer) => void;
  onDecision: (response: SessionAnswer) => void;
  onOpenLink: (url: string) => Promise<void>;
  request: PublicInputRequest;
}) {
  if (request.kind === "approval") {
    return (
      <InputControl
        request={request}
        answer={answer}
        isSubmitting={isSubmitting}
        onAnswer={(response) => {
          if (onlyDecision) {
            onDecision(response);
          } else {
            onAnswer(response);
          }
        }}
      />
    );
  }
  const decisionOptions = binaryDecisionOptions(request);
  if (decisionOptions !== null) {
    const [acceptOption, cancelOption] = decisionOptions;
    return (
      <ApprovalRequest
        title={request.title}
        description={request.description}
        isSubmitting={isSubmitting}
        primaryLabel="Accept"
        secondaryLabel="Cancel"
        onAnswer={(response) => {
          const responseAnswer = answerForOption(
            response.kind === "approve" ? acceptOption : cancelOption,
          );
          if (onlyDecision) {
            onDecision(responseAnswer);
          } else {
            onAnswer(responseAnswer);
          }
        }}
      />
    );
  }
  return (
    <SectionShell
      section={request.presentation?.section || "connections"}
      title={request.title}
      description={
        request.description ||
        (request.kind === "authorization"
          ? "Connect to continue."
          : "Choose an option to continue.")
      }
    >
      {request.kind === "authorization" ? (
        <AuthorizationControl
          request={request}
          canOpen={canOpenLinks && Boolean(request.authorization?.url)}
          onOpenLink={onOpenLink}
        />
      ) : (
        <InputControl request={request} answer={answer} onAnswer={onAnswer} />
      )}
    </SectionShell>
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function answerIsComplete(answer?: SessionAnswer) {
  return answer !== undefined && (answer.kind !== "answer" || answer.value.trim().length > 0);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function remainingAnswers(requests: PublicInputRequest[], answers: Record<string, SessionAnswer>) {
  return requests.filter((request) => !answerIsComplete(answers[request.requestId])).length;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function guidanceForAnswers(canCallTools: boolean, unansweredCount: number) {
  let guidance: string | undefined;
  if (!canCallTools) {
    guidance = "Answer in chat to continue.";
  } else if (unansweredCount > 0) {
    guidance = `Answer ${unansweredCount === 1 ? "the remaining request" : `all ${unansweredCount} remaining requests`} to continue.`;
  }
  return guidance;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function SessionOutcome({
  authorizationOpened,
  decisionOutcome,
  result,
  submitted,
}: {
  authorizationOpened: boolean;
  decisionOutcome?: DecisionOutcome;
  result: EveSessionResult;
  submitted: boolean;
}) {
  if (decisionOutcome?.status === "failed") {
    const pullRequestNumber = draftPullRequestNumber(decisionOutcome.request.title);
    const heading = pullRequestNumber
      ? `Draft PR ${pullRequestNumber} could not be updated`
      : "Your response could not be submitted";
    return (
      <main className="mcpApp shell outcome outcome--failure" role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <strong>{heading}</strong>
          <p>The update could not be completed. Continuing in chat…</p>
        </div>
      </main>
    );
  }

  if (result.status === "failed") {
    return (
      <main className="mcpApp shell outcome outcome--failure" role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <strong>{authorizationOpened ? "GitHub connection failed" : "Request failed"}</strong>
          <p>
            {result.error?.message || "Autograph could not confirm repository access. Try again."}
          </p>
        </div>
      </main>
    );
  }

  if (
    decisionOutcome?.status === "submitted" ||
    (decisionOutcome?.status === "submitting" && result.status !== "input_required")
  ) {
    const decisionOptions = binaryDecisionOptions(decisionOutcome.request);
    const canceled =
      decisionOutcome.response.kind === "deny" ||
      (decisionOutcome.response.kind === "answer" &&
        decisionOptions?.[1]?.id === decisionOutcome.response.optionId);
    if (canceled) {
      return (
        <main className="mcpApp shell outcome outcome--neutral" role="status">
          <strong>Continuing in chat…</strong>
        </main>
      );
    }

    const pullRequestNumber = draftPullRequestNumber(decisionOutcome.request.title);
    if (pullRequestNumber) {
      return (
        <main className="mcpApp shell outcome outcome--success" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>Draft PR {pullRequestNumber} updated</strong>
            <p>
              The reviewed changes are in the draft PR. It remains a draft and will not merge or
              deploy.
            </p>
          </div>
        </main>
      );
    }
  }

  if (submitted || result.status !== "input_required") {
    return (
      <main className="mcpApp shell outcome outcome--success" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <strong>{authorizationOpened ? "GitHub response received" : "Response received"}</strong>
          <p>
            {authorizationOpened
              ? "Autograph App Builder is verifying repository access and will continue in chat."
              : "Autograph App Builder will continue in chat."}
          </p>
        </div>
      </main>
    );
  }
  return null;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function SessionAppView({
  canCallTools,
  canOpenLinks,
  onOpenLink,
  onRespond,
  result,
}: {
  canCallTools: boolean;
  canOpenLinks: boolean;
  onOpenLink: (url: string) => Promise<void>;
  onRespond: (responses: SessionResponse[]) => Promise<void>;
  result?: EveSessionResult;
}) {
  const [answers, setAnswers] = useState<Record<string, SessionAnswer>>({});
  const [state, setState] = useState<"idle" | "submitting" | "submitted">("idle");
  const [authorizationOpened, setAuthorizationOpened] = useState(false);
  const [error, setError] = useState("");
  const [decisionOutcome, setDecisionOutcome] = useState<DecisionOutcome>();
  const requests = result?.inputRequests ?? [];
  const respondable = requests.filter((request) => request.kind !== "authorization");
  const complete = useMemo(
    () => respondable.length > 0 && remainingAnswers(respondable, answers) === 0,
    [answers, respondable],
  );
  const unansweredCount = remainingAnswers(respondable, answers);
  const continueGuidance = guidanceForAnswers(canCallTools, unansweredCount);

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function submitDecision(request: PublicInputRequest, response: SessionAnswer) {
    if (!result || !canCallTools || state === "submitting") {
      return;
    }
    setState("submitting");
    setError("");
    setDecisionOutcome({ request, response, status: "submitting" });
    try {
      await onRespond([{ requestId: request.requestId, response }]);
      setState("submitted");
      setDecisionOutcome({ request, response, status: "submitted" });
    } catch {
      setState("idle");
      setDecisionOutcome({ request, response, status: "failed" });
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function submit() {
    if (!result || !complete || !canCallTools || state === "submitting") {
      return;
    }
    setState("submitting");
    setError("");
    try {
      await onRespond(
        respondable.flatMap((request) => {
          const response = answers[request.requestId];
          return response === undefined ? [] : [{ requestId: request.requestId, response }];
        }),
      );
      setState("submitted");
    } catch {
      setState("idle");
      setError("Your answers could not be submitted. Continue in chat.");
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function openAuthorization(url: string) {
    await onOpenLink(url);
    setAuthorizationOpened(true);
  }

  if (!result) {
    return (
      <main className="mcpApp shell">
        <p>Loading requested controls…</p>
      </main>
    );
  }
  const outcome = (
    <SessionOutcome
      authorizationOpened={authorizationOpened}
      decisionOutcome={decisionOutcome}
      result={result}
      submitted={state === "submitted"}
    />
  );
  if (
    result.status === "failed" ||
    decisionOutcome?.status === "failed" ||
    state === "submitted" ||
    result.status !== "input_required"
  ) {
    return outcome;
  }

  const onlyRequest = requests.length === 1 ? requests[0] : undefined;
  const onlyDecision = isDecisionRequest(onlyRequest);
  const singleAuthorization =
    requests.length === 1 && requests[0]?.kind === "authorization" ? requests[0] : undefined;
  if (singleAuthorization) {
    return (
      <main className="mcpApp shell authorization-shell">
        <div className="request-list">
          <AuthorizationControl
            request={singleAuthorization}
            canOpen={canOpenLinks && Boolean(singleAuthorization.authorization?.url)}
            onOpenLink={openAuthorization}
          />
        </div>
      </main>
    );
  }

  return (
    <main className={`mcpApp shell${onlyDecision ? " approval-shell" : ""}`}>
      {onlyDecision ? null : (
        <header>
          <div>
            <strong>Autograph App Builder</strong>
            <p>Review the request and choose how to proceed.</p>
          </div>
          <span>
            {requests.length} {requests.length === 1 ? "request" : "requests"}
          </span>
        </header>
      )}
      <div className="request-list">
        {requests.map((request) => (
          <SessionRequestControl
            key={request.requestId}
            request={request}
            answer={answers[request.requestId]}
            canOpenLinks={canOpenLinks}
            isSubmitting={state === "submitting"}
            onlyDecision={onlyDecision}
            onAnswer={(answer) => {
              setAnswers((current) => ({ ...current, [request.requestId]: answer }));
            }}
            onDecision={(answer) => {
              void submitDecision(request, answer);
            }}
            onOpenLink={openAuthorization}
          />
        ))}
      </div>
      {respondable.length && !onlyDecision ? (
        <footer>
          <button
            type="button"
            className="primary"
            disabled={!complete || !canCallTools || state === "submitting"}
            aria-describedby={continueGuidance ? "continue-guidance" : undefined}
            onClick={submit}
          >
            {state === "submitting" ? "Submitting…" : "Continue"}
          </button>
          {continueGuidance ? (
            <p className="continue-guidance" id="continue-guidance">
              {continueGuidance}
            </p>
          ) : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </footer>
      ) : null}
    </main>
  );
}
