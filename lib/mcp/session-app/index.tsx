import { App } from "@modelcontextprotocol/ext-apps";
import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import {
  ChoiceCard,
  SectionShell,
} from "../../../components/create-app/choice-card";
import packageManifest from "../../../package.json";
import type { EveSessionResult, PublicInputRequest } from "../contracts";
import "./styles.css";

type Answer =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "answer"; value: string; optionId?: string };

const app = new App(
  { name: "Autograph App Builder", version: packageManifest.version },
  {},
  { autoResize: true, strict: true },
);
let latestResult: EveSessionResult | undefined;
const resultListeners = new Set<() => void>();
app.ontoolresult = ({ structuredContent }) => {
  latestResult = structuredContent as EveSessionResult | undefined;
  resultListeners.forEach((listener) => listener());
};

function subscribeToResult(listener: () => void) {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
}

function currentResult() {
  return latestResult;
}

function InputControl({
  answer,
  onAnswer,
  request,
}: {
  answer?: Answer;
  onAnswer: (answer: Answer) => void;
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
              <span className="choice-icon">
                {kind === "approve" ? "✓" : "×"}
              </span>
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
        {request.options.map((option) => (
          <ChoiceCard
            key={option.id}
            checked={answer?.kind === "answer" && answer.optionId === option.id}
            inputType="radio"
            name={request.requestId}
            value={option.id}
            icon={<span className="choice-icon">✓</span>}
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
        ))}
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

function AuthorizationControl({
  onRefresh,
  request,
}: {
  onRefresh: () => Promise<void>;
  request: PublicInputRequest;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const challenge = request.authorization;
  const provider = challenge?.displayName || request.title;
  const canOpen = Boolean(
    challenge?.url && app.getHostCapabilities()?.openLinks,
  );
  const canRefresh = Boolean(app.getHostCapabilities()?.serverTools);

  async function connect() {
    if (!challenge?.url || !canOpen) return;
    setError("");
    try {
      await app.openLink({ url: challenge.url });
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

function SessionApp() {
  const result = useSyncExternalStore(
    subscribeToResult,
    currentResult,
    currentResult,
  );
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
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
  const canCallTools = Boolean(app.getHostCapabilities()?.serverTools);

  async function refresh() {
    if (!result || !canCallTools) return;
    setError("");
    try {
      const response = await app.callServerTool({
        name: "autograph_get",
        arguments: {
          sessionId: result.sessionId,
          cursor: result.cursor,
          limit: 100,
        },
      });
      if (response.structuredContent)
        latestResult = response.structuredContent as EveSessionResult;
      resultListeners.forEach((listener) => listener());
    } catch {
      setError("Could not check the connection. Continue in chat.");
    }
  }

  async function submit() {
    if (!result || !complete || !canCallTools || state === "submitting") return;
    setState("submitting");
    setError("");
    try {
      const response = await app.callServerTool({
        name: "autograph_respond",
        arguments: {
          sessionId: result.sessionId,
          responses: respondable.map((request) => ({
            requestId: request.requestId,
            response: answers[request.requestId],
          })),
          clientRequestId: crypto.randomUUID(),
        },
      });
      if (response.isError) throw new Error("response rejected");
      setState("submitted");
      if (response.structuredContent)
        latestResult = response.structuredContent as EveSessionResult;
      resultListeners.forEach((listener) => listener());
    } catch {
      setState("idle");
      setError("Your answers could not be submitted. Continue in chat.");
    }
  }

  if (!result)
    return (
      <main className="shell">
        <p>Loading requested controls…</p>
      </main>
    );
  if (state === "submitted" || result.status !== "input_required")
    return (
      <main className="shell success" role="status">
        <span>✓</span>
        <div>
          <strong>Response received</strong>
          <p>Autograph App Builder will continue in chat.</p>
        </div>
      </main>
    );

  return (
    <main className="shell">
      <header>
        <div>
          <strong>Autograph App Builder</strong>
          <p>Complete the requested details</p>
        </div>
        <span>{requests.length} requested</span>
      </header>
      <div className="request-list">
        {requests.map((request) =>
          request.kind === "authorization" ? (
            <SectionShell
              key={request.requestId}
              section={request.presentation?.section || "connections"}
              title={request.title}
              description={request.description || "Connect to continue."}
            >
              <AuthorizationControl request={request} onRefresh={refresh} />
            </SectionShell>
          ) : (
            <SectionShell
              key={request.requestId}
              section={request.presentation?.section || "connections"}
              title={request.title}
              description={
                request.description || "Choose an option to continue."
              }
            >
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
            </SectionShell>
          ),
        )}
      </div>
      {respondable.length ? (
        <footer>
          <button
            type="button"
            className="primary"
            disabled={!complete || !canCallTools || state === "submitting"}
            onClick={submit}
          >
            {state === "submitting" ? "Submitting…" : "Continue"}
          </button>
          {!canCallTools ? (
            <p className="fallback">Answer in chat to continue.</p>
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

const root = document.getElementById("root");
if (!root) throw new Error("Missing MCP App root.");
createRoot(root).render(<SessionApp />);
void app.connect();
