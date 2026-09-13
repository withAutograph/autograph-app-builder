export interface CompensationFixture {
  proposal: {
    baseSalary: number;
    targetBonus: number;
    annualBenefits: number;
    employerTaxRate: number;
  };
  comparison: {
    bandMidpoint: number;
    plannedIncrease: number;
  };
}

export interface CompensationAssumptions {
  baseSalary: number;
  targetBonus: number;
  annualBenefits: number;
  employerTaxRate: number;
  bandMidpoint: number;
  plannedIncrease: number;
}

export interface CompensationState {
  assumptions: CompensationAssumptions;
  assumptionsApplied: boolean;
  decision: "none" | "recommended" | "held";
}

export type CompensationAction =
  | {
      type: "assumption-changed";
      field: keyof CompensationAssumptions;
      value: number;
    }
  | { type: "assumptions-applied" }
  | { type: "recommend" }
  | { type: "hold" }
  | { type: "clear-decision" }
  | { type: "reset"; fixture: CompensationFixture };

export const compensationAssumptions = (fixture: CompensationFixture): CompensationAssumptions => ({
  ...fixture.proposal,
  ...fixture.comparison,
});

export const initialCompensationState = (fixture: CompensationFixture): CompensationState => ({
  assumptions: compensationAssumptions(fixture),
  assumptionsApplied: true,
  decision: "none",
});

export const validateCompensation = (input: CompensationAssumptions) => {
  const errors: Partial<Record<keyof CompensationAssumptions, string>> = {};
  for (const field of ["baseSalary", "targetBonus", "annualBenefits", "bandMidpoint"] as const) {
    if (!Number.isFinite(input[field]) || input[field] < 0)
      errors[field] = "Enter a non-negative amount.";
  }
  if (!Number.isFinite(input.bandMidpoint) || input.bandMidpoint <= 0)
    errors.bandMidpoint = "Enter a midpoint greater than zero.";
  if (
    !Number.isFinite(input.employerTaxRate) ||
    input.employerTaxRate < 0 ||
    input.employerTaxRate > 1
  )
    errors.employerTaxRate = "Enter a percentage from 0 to 100.";
  if (
    !Number.isFinite(input.plannedIncrease) ||
    input.plannedIncrease < -1 ||
    input.plannedIncrease > 1
  )
    errors.plannedIncrease = "Enter a percentage from -100 to 100.";
  return errors;
};

export const calculateCompensation = (input: CompensationAssumptions) => {
  if (Object.keys(validateCompensation(input)).length > 0) return;
  const currentTax = Math.round(input.baseSalary * input.employerTaxRate);
  const proposedBase = Math.round(input.baseSalary * (1 + input.plannedIncrease));
  const proposedTax = Math.round(proposedBase * input.employerTaxRate);
  const currentTotal = input.baseSalary + input.targetBonus + input.annualBenefits + currentTax;
  const proposedTotal = proposedBase + input.targetBonus + input.annualBenefits + proposedTax;
  return {
    currentTax,
    currentTotal,
    proposedBase,
    proposedMidpointDelta: proposedBase - input.bandMidpoint,
    proposedTax,
    proposedTotal,
  };
};

export const reduceCompensationState = (
  state: CompensationState,
  action: CompensationAction,
): CompensationState => {
  if (action.type === "assumption-changed")
    return {
      assumptions: { ...state.assumptions, [action.field]: action.value },
      assumptionsApplied: false,
      decision: "none",
    };
  if (action.type === "assumptions-applied")
    return Object.keys(validateCompensation(state.assumptions)).length === 0
      ? { ...state, assumptionsApplied: true }
      : state;
  if (action.type === "recommend")
    return state.assumptionsApplied ? { ...state, decision: "recommended" } : state;
  if (action.type === "hold")
    return state.assumptionsApplied ? { ...state, decision: "held" } : state;
  if (action.type === "clear-decision") return { ...state, decision: "none" };
  return initialCompensationState(action.fixture);
};

export const compensationDecisionModel = (state: CompensationState) => {
  let status: string | undefined;
  if (state.decision === "recommended") status = "Planning recommendation recorded in this preview";
  else if (state.decision === "held") status = "Draft kept for further review";

  return {
    primaryLabel:
      state.decision === "recommended" ? "Recommended in preview" : "Recommend for planning",
    status,
  };
};
