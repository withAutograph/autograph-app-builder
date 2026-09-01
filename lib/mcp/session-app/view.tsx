import { useMemo, useState } from "react";

import {
  ChoiceCard,
  SectionShell,
} from "../../../components/create-app/choice-card";
import type { EveSessionResult, PublicInputRequest } from "../contracts";
import "./styles.css";

export type SessionAnswer =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "answer"; value: string; optionId?: string };

export type SessionResponse = {
  requestId: string;
  response: SessionAnswer;
};

export function InputControl({
  answer,
  onAnswer,
  request,
}: {
  answer?: SessionAnswer;
  onAnswer: (answer: SessionAnswer) => void;
  request: PublicInputRequest;
}) {
  if (request.kind === "approval")
    return (
      <div className="choices" role="group" aria-label={request.title}>
        {(["approve", "deny"] as const).map((kind) => (
          <ChoiceCard
            key={kind}
            checked={answer?.kind === kind}
            name={request.requestId}
            value={kind}
            icon={
              answer?.kind === kind ? (
                <span className="choice-icon" aria-hidden="true">
                  {kind === "approve" ? "✓" : "×"}
                </span>
              ) : undefined
            }
            onChange={() => onAnswer({ kind })}
          >
            {kind === "approve" ? "Approve" : "Deny"}
          </ChoiceCard>
        ))}
      </div>
    );

  if (request.options?.length)
    return (
      <div className="choices" role="radiogroup" aria-label={request.title}>
        {request.options.map((option) => {
          const selected =
            answer?.kind === "answer" && answer.optionId === option.id;
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

  if (request.allowFreeform)
    return (
      <textarea
        aria-label={request.title}
        value={answer?.kind === "answer" ? answer.value : ""}
        placeholder="Enter your answer…"
        onChange={(event) =>
          onAnswer({ kind: "answer", value: event.target.value })
        }
      />
    );

  return <p className="fallback">Answer this request in chat to continue.</p>;
}

export function AuthorizationControl({
  canOpen,
  canRefresh,
  onOpenLink,
  onRefresh,
  request,
}: {
  canOpen: boolean;
  canRefresh: boolean;
  onOpenLink: (url: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  request: PublicInputRequest;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const challenge = request.authorization;
  const provider = challenge?.displayName || request.title;

  async function connect() {
    if (!challenge?.url || !canOpen) return;
    setError("");
    try {
      await onOpenLink(challenge.url);
      setOpened(true);
    } catch {
      setError("The authorization page could not be opened. Continue in chat.");
    }
  }

  return (
    <div className="authorization-card">
      <span className="provider-icon" aria-hidden="true">
        {provider.trim().slice(0, 1).toUpperCase() || "A"}
      </span>
      <div>
        <strong>{provider}</strong>
        <p>{challenge?.instructions || request.description}</p>
        {challenge?.userCode ? (
          <code aria-label="Authorization code">{challenge.userCode}</code>
        ) : null}
      </div>
      {challenge?.url ? (
        <button type="button" onClick={connect} disabled={!canOpen}>
          Connect
        </button>
      ) : null}
      {opened ? (
        <button
          type="button"
          className="secondary"
          onClick={onRefresh}
          disabled={!canRefresh}
        >
          Check connection
        </button>
      ) : null}
      {!canOpen && challenge?.url ? (
        <p className="fallback">Open the authorization link from chat.</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export function SessionAppView({
  canCallTools,
  canOpenLinks,
  onOpenLink,
  onRefresh,
  onRespond,
  result,
}: {
  canCallTools: boolean;
  canOpenLinks: boolean;
  onOpenLink: (url: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRespond: (responses: SessionResponse[]) => Promise<void>;
  result?: EveSessionResult;
}) {
  const [answers, setAnswers] = useState<Record<string, SessionAnswer>>({});
  const [state, setState] = useState<"idle" | "submitting" | "submitted">(
    "idle",
  );
  const [error, setError] = useState("");
  const requests = result?.inputRequests ?? [];
  const respondable = requests.filter(
    (request) => request.kind !== "authorization",
  );
  const complete = useMemo(
    () =>
      respondable.length > 0 &&
      respondable.every((request) => {
        const answer = answers[request.requestId];
        return (
          answer !== undefined &&
          (answer.kind !== "answer" || answer.value.trim().length > 0)
        );
      }),
    [answers, respondable],
  );
  const unansweredCount = respondable.filter((request) => {
    const answer = answers[request.requestId];
    return (
      answer === undefined ||
      (answer.kind === "answer" && answer.value.trim().length === 0)
    );
  }).length;
  const continueGuidance = !canCallTools
    ? "Answer in chat to continue."
    : unansweredCount > 0
      ? `Answer ${unansweredCount === 1 ? "the remaining request" : `all ${unansweredCount} remaining requests`} to continue.`
      : undefined;

  async function submit() {
    if (!result || !complete || !canCallTools || state === "submitting") return;
    setState("submitting");
    setError("");
    try {
      await onRespond(
        respondable.map((request) => ({
          requestId: request.requestId,
          response: answers[request.requestId]!,
        })),
      );
      setState("submitted");
    } catch {
      setState("idle");
      setError("Your answers could not be submitted. Continue in chat.");
    }
  }

  if (!result)
    return (
      <main className="mcpApp shell">
        <p>Loading requested controls…</p>
      </main>
    );
  if (state === "submitted" || result.status !== "input_required")
    return (
      <main className="mcpApp shell success" role="status">
        <span>✓</span>
        <div>
          <strong>Response received</strong>
          <p>Autograph App Builder will continue in chat.</p>
        </div>
      </main>
    );

  return (
    <main className="mcpApp shell">
      <header>
        <div>
          <strong>Autograph App Builder</strong>
          <p>Complete the requested details</p>
        </div>
        <span>{requests.length} requested</span>
      </header>
      <div className="request-list">
        {requests.map((request) => (
          <SectionShell
            key={request.requestId}
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
                canRefresh={canCallTools}
                onOpenLink={onOpenLink}
                onRefresh={onRefresh}
              />
            ) : (
              <InputControl
                request={request}
                answer={answers[request.requestId]}
                onAnswer={(answer) =>
                  setAnswers((current) => ({
                    ...current,
                    [request.requestId]: answer,
                  }))
                }
              />
            )}
          </SectionShell>
        ))}
      </div>
      {respondable.length ? (
        <footer>
          <button
            type="button"
            className="primary"
            disabled={!complete || !canCallTools || state === "submitting"}
            aria-describedby={
              continueGuidance ? "continue-guidance" : undefined
            }
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
