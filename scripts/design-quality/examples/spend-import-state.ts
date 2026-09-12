export type SpendTarget =
  | "vendor_name"
  | "amount"
  | "currency"
  | "transaction_date"
  | "source_record_ref"
  | "ignore";

export interface SpendFixture {
  import: { batchId: string; rows: number };
  fieldMapping: Record<string, string>;
  preview: { creates: number; needsReview: number };
  representativeRows: {
    id: string;
    source: Record<string, string | number>;
    issue?: string;
  }[];
  uncertainMatches: {
    id: string;
    vendorRaw: string;
    amount: number;
    currency: string;
    transactionDate: string;
    sourceRef: string;
    candidates: { id: string; label: string }[];
  }[];
}

export type SpendMapping = Record<string, SpendTarget>;
export type SpendStage = "mapping" | "preview" | "saved" | "review";
export interface SpendState {
  stage: SpendStage;
  mapping: SpendMapping;
  selectedMatchId?: string;
  decision?: "resolved" | "deferred";
  saved?: SpendSaveOutcome;
}

export interface SpendPreviewRow {
  id: string;
  vendor: string;
  amount: string;
  date: string;
  sourceRef: string;
  result: "Ready" | "Needs review";
}

export interface SpendPreview {
  rows: SpendPreviewRow[];
  ready: number;
  needsReview: number;
  mappingSummary: string;
}

export interface SpendSaveOutcome {
  imported: number;
  reviewQueue: number;
  message: string;
  mapping: SpendMapping;
}

export type SpendAction =
  | { type: "mapping-changed"; source: string; target: SpendTarget }
  | { type: "preview-requested" }
  | { type: "save-requested"; fixture: SpendFixture }
  | { type: "review-requested" }
  | { type: "match-selected"; id: string }
  | { type: "decision-applied" }
  | { type: "decision-deferred" };

const requiredTargets: SpendTarget[] = ["vendor_name", "amount", "transaction_date"];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function initialSpendState(fixture: SpendFixture): SpendState {
  return {
    stage: "mapping",
    mapping: Object.fromEntries(
      Object.entries(fixture.fieldMapping).map(([target, source]) => [source, target]),
    ) as SpendMapping,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sourceFor(mapping: SpendMapping, target: SpendTarget) {
  return Object.entries(mapping).find(([, value]) => value === target)?.[0];
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function mappedValue(
  source: Record<string, string | number>,
  mapping: SpendMapping,
  target: SpendTarget,
) {
  const key = sourceFor(mapping, target);
  return key === undefined ? undefined : source[key];
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function deriveSpendPreview(fixture: SpendFixture, mapping: SpendMapping): SpendPreview {
  const complete = requiredTargets.every((target) => sourceFor(mapping, target));
  const representativeBaselineReady = fixture.representativeRows.filter(
    ({ issue }) => !issue,
  ).length;
  const unshownReady = Math.max(0, fixture.preview.creates - representativeBaselineReady);
  const rows = fixture.representativeRows.map((row) => {
    const vendor = mappedValue(row.source, mapping, "vendor_name");
    const amount = mappedValue(row.source, mapping, "amount");
    const currency = mappedValue(row.source, mapping, "currency") ?? "USD";
    const date = mappedValue(row.source, mapping, "transaction_date");
    const sourceRef = mappedValue(row.source, mapping, "source_record_ref");
    return {
      id: row.id,
      vendor: vendor === undefined ? "Not mapped" : String(vendor),
      amount:
        typeof amount === "number"
          ? new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: String(currency),
            }).format(amount)
          : "Not mapped",
      date: date === undefined ? "Not mapped" : String(date),
      sourceRef: sourceRef === undefined ? "Not imported" : String(sourceRef),
      result: complete && !row.issue ? "Ready" : "Needs review",
    } satisfies SpendPreviewRow;
  });
  const ready = complete
    ? unshownReady + rows.filter(({ result }) => result === "Ready").length
    : 0;
  const needsReview = fixture.import.rows - ready;
  const ignored = Object.values(mapping).filter((value) => value === "ignore").length;
  return {
    rows,
    ready,
    needsReview,
    mappingSummary:
      ignored === 0
        ? "All source columns are included."
        : `${ignored} source ${ignored === 1 ? "column is" : "columns are"} excluded.`,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function reduceSpendState(state: SpendState, action: SpendAction): SpendState {
  if (action.type === "mapping-changed") {
    const mapping = { ...state.mapping };
    for (const [source, target] of Object.entries(mapping))
      if (source !== action.source && target === action.target && target !== "ignore")
        mapping[source] = "ignore";
    mapping[action.source] = action.target;
    return { stage: "mapping", mapping };
  }
  if (action.type === "preview-requested") return { ...state, stage: "preview", saved: undefined };
  if (action.type === "save-requested") {
    const preview = deriveSpendPreview(action.fixture, state.mapping);
    const saved = {
      imported: preview.ready,
      reviewQueue: preview.needsReview,
      message: `${preview.ready} rows imported into the simulated spend register. ${preview.needsReview} rows remain in human review.`,
      mapping: { ...state.mapping },
    };
    return { ...state, stage: "saved", saved };
  }
  if (action.type === "review-requested") return { ...state, stage: "review" };
  if (action.type === "match-selected")
    return { ...state, selectedMatchId: action.id, decision: undefined };
  if (action.type === "decision-deferred") return { ...state, decision: "deferred" };
  if (action.type === "decision-applied" && state.selectedMatchId)
    return {
      ...state,
      decision: "resolved",
      saved: state.saved
        ? {
            ...state.saved,
            imported: state.saved.imported + 1,
            reviewQueue: Math.max(0, state.saved.reviewQueue - 1),
            message: `${state.saved.imported + 1} rows are now included in the simulated spend register. ${Math.max(0, state.saved.reviewQueue - 1)} rows remain in human review.`,
          }
        : undefined,
    };
  return state;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function spendActionModel(state: SpendState) {
  return {
    saveEnabled: state.stage === "preview",
    applyEnabled:
      state.stage === "review" && Boolean(state.selectedMatchId) && state.decision === undefined,
    result:
      state.decision === "resolved"
        ? "Simulated decision recorded."
        : state.decision === "deferred"
          ? "Left unresolved for follow-up."
          : undefined,
  };
}
