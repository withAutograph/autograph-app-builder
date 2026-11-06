import { validateBuildReadyAppSpec } from "../../lib/agent/app-spec-validation";
import { isProductFacing, forbiddenPublicVocabulary } from "./public-conversation";

const VENDOR_ONBOARDING = "vendor-onboarding";
const REVIEW_QUEUE = "operations review queue";

const containsAll = (text: string, required: readonly string[]): boolean => {
  const escaped = required.map((value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = escaped.map((value) => `(?=.*${value})`).join("");
  return new RegExp(pattern, "su").test(text);
};

export interface ProductQualityScenario {
  id: string;
  brief: string;
  expected: {
    replyIncludes: readonly string[];
    inferredChoices?: readonly string[];
    question: string;
    prototype?: {
      appId: string;
      requiredText: readonly string[];
    };
  };
}

export const PRODUCT_QUALITY_SCENARIOS: readonly ProductQualityScenario[] = [
  {
    brief:
      "Build an internal vendor-onboarding workflow for operations to review new vendor submissions, resolve missing information, and involve Finance when tax verification is actually required.",
    expected: {
      inferredChoices: [VENDOR_ONBOARDING, REVIEW_QUEUE, "vendor detail panel"],
      prototype: {
        appId: VENDOR_ONBOARDING,
        requiredText: [
          "Operations review queue",
          "Finance: verify tax information",
          "Northstar Logistics",
        ],
      },
      question: "forbidden",
      replyIncludes: [
        "Vendor Onboarding",
        REVIEW_QUEUE,
        "vendor detail panel",
        "conditional Finance verification step",
      ],
    },
    id: "vendor-onboarding",
  },
  {
    brief:
      "We need an internal vendor product, but we do not know whether it should focus on initial onboarding or ongoing compliance monitoring.",
    expected: {
      question: "one-recommended",
      replyIncludes: [
        "meaningfully different products",
        "recommended",
        "continuously monitoring vendors",
      ],
    },
    id: "material-product-ambiguity",
  },
  {
    brief:
      "Build a vendor-onboarding workflow. Use a full-page step-by-step form for a single requester rather than a review queue, and keep Finance review conditional on tax information.",
    expected: {
      inferredChoices: ["step-by-step form", "single requester"],
      question: "forbidden",
      replyIncludes: [
        "Vendor Onboarding",
        "step-by-step form",
        "single requester",
        "conditional Finance review",
      ],
    },
    id: "explicit-preference",
  },
  {
    brief:
      "Build an anonymous public vendor portal where anyone can upload tax and banking documents without signing in.",
    expected: {
      question: "forbidden",
      replyIncludes: [
        "anonymous public vendor portal is unavailable",
        "recommended alternative",
        "Vendor Intake",
      ],
    },
    id: "unavailable-product-alternative",
  },
];

export interface ConversationQualityReport {
  hardFailures: readonly string[];
  score: {
    productFacing: boolean;
    structured: boolean;
    productive: boolean;
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function evaluateConversationQuality(input: {
  scenario: ProductQualityScenario;
  reply: string;
  assistantMessages?: readonly string[];
}): ConversationQualityReport {
  const messages = input.assistantMessages ?? [input.reply];
  const hardFailures: string[] = [];
  if (!messages.every(isProductFacing)) {
    hardFailures.push("Conversation exposed internal orchestration vocabulary.");
  }
  if (messages.some((message) => forbiddenPublicVocabulary.test(message))) {
    hardFailures.push("Conversation used forbidden public vocabulary.");
  }
  for (const expected of input.scenario.expected.replyIncludes) {
    if (!containsAll(input.reply, [expected])) {
      hardFailures.push(`Reply omitted required product outcome: ${expected}.`);
    }
  }
  const questionCount = (input.reply.match(/\?/gu) ?? []).length;
  if (input.scenario.expected.question === "forbidden" && questionCount !== 0) {
    hardFailures.push("Conversation asked an unnecessary product question.");
  }
  if (
    input.scenario.expected.question === "one-recommended" &&
    (questionCount !== 1 || !/\brecommended\b/iu.test(input.reply))
  ) {
    hardFailures.push(
      "Material ambiguity must ask one product question with a recommended default.",
    );
  }
  return {
    hardFailures,
    score: {
      productFacing: messages.every(isProductFacing),
      productive: containsAll(input.reply, input.scenario.expected.replyIncludes),
      structured: hardFailures.every(
        (failure) => !failure.includes("unnecessary product question"),
      ),
    },
  };
}

export interface PrototypeQualityReport {
  hardFailures: readonly string[];
  score: {
    semanticStructure: boolean;
    contentComplete: boolean;
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function evaluatePrototypeQuality(input: {
  scenario: ProductQualityScenario;
  html: string;
  appSpec: string;
}): PrototypeQualityReport {
  const { prototype } = input.scenario.expected;
  if (prototype === undefined) {
    throw new Error("This product-quality scenario has no prototype contract.");
  }
  const hardFailures: string[] = [];
  const recordFailure = (condition: boolean, message: string) => {
    if (!condition) {
      hardFailures.push(message);
    }
  };
  const { html } = input;
  recordFailure(/<html\s+lang=["']en["']/iu.test(html), "Prototype lacks a language.");
  recordFailure(
    /<meta\s+name=["']viewport["']/iu.test(html),
    "Prototype lacks a responsive viewport.",
  );
  recordFailure(/<main[\s>]/iu.test(html), "Prototype lacks a main landmark.");
  recordFailure(
    /<section\s+aria-labelledby=/iu.test(html),
    "Prototype lacks labelled workflow regions.",
  );
  recordFailure(
    !/lorem ipsum|todo:|placeholder text/iu.test(html),
    "Prototype contains unfinished placeholder content.",
  );
  if (!containsAll(html, prototype.requiredText)) {
    for (const text of prototype.requiredText) {
      if (!containsAll(html, [text])) {
        hardFailures.push(`Prototype omitted ${text}.`);
      }
    }
  }
  const appSpecResult = validateBuildReadyAppSpec(input.appSpec);
  recordFailure(appSpecResult.valid, "Prototype AppSpec is not build-ready.");
  const prototypePath = `prototype/${prototype.appId}/index.html`;
  recordFailure(
    input.appSpec.includes(prototypePath),
    "AppSpec does not bind the evaluated prototype path.",
  );
  return {
    hardFailures,
    score: {
      contentComplete: !/lorem ipsum|todo:|placeholder text/iu.test(input.html),
      semanticStructure:
        /<main[\s>]/iu.test(input.html) && /<section\s+aria-labelledby=/iu.test(input.html),
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function productQualityScenario(id: ProductQualityScenario["id"]): ProductQualityScenario {
  const scenario = PRODUCT_QUALITY_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown product eval ${id}.`);
  }
  return scenario;
}
