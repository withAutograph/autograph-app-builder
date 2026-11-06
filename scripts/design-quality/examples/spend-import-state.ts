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
const notMapped = "Not mapped";
const spendTargets = new Map<string, SpendTarget>([
  ["vendor_name", "vendor_name"],
  ["amount", "amount"],
  ["currency", "currency"],
  ["transaction_date", "transaction_date"],
  ["source_record_ref", "source_record_ref"],
  ["ignore", "ignore"],
]);

const parseSpendTarget = (value: string): SpendTarget | null => spendTargets.get(value) ?? null;

export function initialSpendState(fixture: SpendFixture): SpendState {
  const mapping: SpendMapping = {};
  for (const [target, source] of Object.entries(fixture.fieldMapping)) {
    const parsedTarget = parseSpendTarget(target);
    if (parsedTarget !== null) {
      mapping[source] = parsedTarget;
    }
  }
  return {
    mapping,
    stage: "mapping",
  };
}

function sourceFor(mapping: SpendMapping, target: SpendTarget) {
  return Object.entries(mapping).find(([, value]) => value === target)?.[0];
}

function mappedValue(
  source: Record<string, string | number>,
  mapping: SpendMapping,
  target: SpendTarget,
) {
  const key = sourceFor(mapping, target);
  return key === undefined ? undefined : source[key];
}

export function deriveSpendPreview(fixture: SpendFixture, mapping: SpendMapping): SpendPreview {
  const complete = requiredTargets.every((target) => {
    const source = sourceFor(mapping, target);
    return source !== undefined && source !== "";
  });
  const representativeBaselineReady = fixture.representativeRows.filter(
    ({ issue }) => issue === undefined || issue === "",
  ).length;
  const unshownReady = Math.max(0, fixture.preview.creates - representativeBaselineReady);
  const rows = fixture.representativeRows.map((row) => {
    const vendor = mappedValue(row.source, mapping, "vendor_name");
    const amount = mappedValue(row.source, mapping, "amount");
    const currency = mappedValue(row.source, mapping, "currency") ?? "USD";
    const date = mappedValue(row.source, mapping, "transaction_date");
    const sourceRef = mappedValue(row.source, mapping, "source_record_ref");
    const parsedAmount = amount === undefined ? Number.NaN : Number(amount);
    const amountIsValid = amount !== undefined && amount !== "" && Number.isFinite(parsedAmount);
    const issueFree = row.issue === undefined || row.issue === "";
    return {
      amount: amountIsValid
        ? new Intl.NumberFormat("en-US", {
            currency: String(currency),
            style: "currency",
          }).format(parsedAmount)
        : notMapped,
      date: date === undefined ? notMapped : String(date),
      id: row.id,
      result: complete && issueFree ? "Ready" : "Needs review",
      sourceRef: sourceRef === undefined ? "Not imported" : String(sourceRef),
      vendor: vendor === undefined ? notMapped : String(vendor),
    } satisfies SpendPreviewRow;
  });
  const ready = complete
    ? unshownReady + rows.filter(({ result }) => result === "Ready").length
    : 0;
  const needsReview = fixture.import.rows - ready;
  const ignored = Object.values(mapping).filter((value) => value === "ignore").length;
  const ignoredColumns = ignored === 1 ? "column is" : "columns are";
  const mappingSummary =
    ignored === 0
      ? "All source columns are included."
      : `${ignored} source ${ignoredColumns} excluded.`;
  return {
    mappingSummary,
    needsReview,
    ready,
    rows,
  };
}

export function reduceSpendState(state: SpendState, action: SpendAction): SpendState {
  if (action.type === "mapping-changed") {
    const mapping = { ...state.mapping };
    for (const [source, target] of Object.entries(mapping)) {
      if (source !== action.source && target === action.target && target !== "ignore") {
        mapping[source] = "ignore";
      }
    }
    mapping[action.source] = action.target;
    return { mapping, stage: "mapping" };
  }
  if (action.type === "preview-requested") {
    return { ...state, saved: null, stage: "preview" };
  }
  if (action.type === "save-requested") {
    const preview = deriveSpendPreview(action.fixture, state.mapping);
    const saved = {
      imported: preview.ready,
      mapping: { ...state.mapping },
      message: `${preview.ready} rows imported into the simulated spend register. ${preview.needsReview} rows remain in human review.`,
      reviewQueue: preview.needsReview,
    };
    return { ...state, saved, stage: "saved" };
  }
  if (action.type === "review-requested") {
    return { ...state, stage: "review" };
  }
  if (action.type === "match-selected") {
    return { ...state, decision: null, selectedMatchId: action.id };
  }
  if (action.type === "decision-deferred") {
    return { ...state, decision: "deferred" };
  }
  if (
    action.type === "decision-applied" &&
    state.selectedMatchId !== undefined &&
    state.selectedMatchId !== ""
  ) {
    return {
      ...state,
      decision: "resolved",
      saved: state.saved
        ? {
            ...state.saved,
            imported: state.saved.imported + 1,
            message: `${state.saved.imported + 1} rows are now included in the simulated spend register. ${Math.max(0, state.saved.reviewQueue - 1)} rows remain in human review.`,
            reviewQueue: Math.max(0, state.saved.reviewQueue - 1),
          }
        : undefined,
    };
  }
  return state;
}

export function spendActionModel(state: SpendState) {
  let result: string | undefined;
  if (state.decision === "resolved") {
    result = "Simulated decision recorded.";
  } else if (state.decision === "deferred") {
    result = "Left unresolved for follow-up.";
  }

  return {
    applyEnabled:
      state.stage === "review" &&
      state.selectedMatchId !== undefined &&
      state.selectedMatchId !== "" &&
      state.decision === undefined,
    result,
    saveEnabled: state.stage === "preview",
  };
}
