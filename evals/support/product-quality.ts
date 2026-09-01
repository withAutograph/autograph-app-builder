import { validateBuildReadyAppSpec } from "../../lib/agent/app-spec-validation";
import {
  isProductFacing,
  forbiddenPublicVocabulary,
} from "./public-conversation";

export type ProductQualityScenario = {
  id:
    | "vendor-onboarding"
    | "material-product-ambiguity"
    | "explicit-preference"
    | "unavailable-product-alternative";
  brief: string;
  expected: {
    replyIncludes: readonly string[];
    inferredChoices?: readonly string[];
    question: "forbidden" | "one-recommended";
    prototype?: {
      appId: string;
      requiredText: readonly string[];
      requiredSelectors: readonly string[];
    };
  };
};

export const PRODUCT_QUALITY_SCENARIOS: readonly ProductQualityScenario[] = [
  {
    id: "vendor-onboarding",
    brief:
      "Build an internal vendor-onboarding workflow for operations to review new vendor submissions, resolve missing information, and involve Finance when tax verification is actually required.",
    expected: {
      replyIncludes: [
        "Vendor Onboarding",
        "operations review queue",
        "vendor detail panel",
        "conditional Finance verification step",
      ],
      inferredChoices: [
        "vendor-onboarding",
        "operations review queue",
        "vendor detail panel",
      ],
      question: "forbidden",
      prototype: {
        appId: "vendor-onboarding",
        requiredText: [
          "Operations review queue",
          "Finance: verify tax information",
          "Northstar Logistics",
        ],
        requiredSelectors: ["#detail-title", "#tax-step", ".queue button"],
      },
    },
  },
  {
    id: "material-product-ambiguity",
    brief:
      "We need an internal vendor product, but we do not know whether it should focus on initial onboarding or ongoing compliance monitoring.",
    expected: {
      replyIncludes: [
        "meaningfully different products",
        "recommended",
        "continuously monitoring vendors",
      ],
      question: "one-recommended",
    },
  },
  {
    id: "explicit-preference",
    brief:
      "Build a vendor-onboarding workflow. Use a full-page step-by-step form for a single requester rather than a review queue, and keep Finance review conditional on tax information.",
    expected: {
      replyIncludes: [
        "Vendor Onboarding",
        "step-by-step form",
        "single requester",
        "conditional Finance review",
      ],
      inferredChoices: ["step-by-step form", "single requester"],
      question: "forbidden",
    },
  },
  {
    id: "unavailable-product-alternative",
    brief:
      "Build an anonymous public vendor portal where anyone can upload tax and banking documents without signing in.",
    expected: {
      replyIncludes: [
        "anonymous public vendor portal is unavailable",
        "recommended alternative",
        "Vendor Intake",
      ],
      question: "forbidden",
    },
  },
];

export type ConversationQualityReport = {
  hardFailures: readonly string[];
  score: {
    productFacing: boolean;
    structured: boolean;
    productive: boolean;
  };
};

export function evaluateConversationQuality(input: {
  scenario: ProductQualityScenario;
  reply: string;
  assistantMessages?: readonly string[];
}): ConversationQualityReport {
  const messages = input.assistantMessages ?? [input.reply];
  const hardFailures: string[] = [];
  if (!messages.every(isProductFacing))
    hardFailures.push(
      "Conversation exposed internal orchestration vocabulary.",
    );
  if (messages.some((message) => forbiddenPublicVocabulary.test(message)))
    hardFailures.push("Conversation used forbidden public vocabulary.");
  for (const expected of input.scenario.expected.replyIncludes)
    if (!input.reply.includes(expected))
      hardFailures.push(`Reply omitted required product outcome: ${expected}.`);
  const questionCount = (input.reply.match(/\?/gu) ?? []).length;
  if (input.scenario.expected.question === "forbidden" && questionCount !== 0)
    hardFailures.push("Conversation asked an unnecessary product question.");
  if (
    input.scenario.expected.question === "one-recommended" &&
    (questionCount !== 1 || !/\brecommended\b/iu.test(input.reply))
  )
    hardFailures.push(
      "Material ambiguity must ask one product question with a recommended default.",
    );
  return {
    hardFailures,
    score: {
      productFacing: messages.every(isProductFacing),
      structured: hardFailures.every(
        (failure) => !failure.includes("unnecessary product question"),
      ),
      productive: input.scenario.expected.replyIncludes.every((expected) =>
        input.reply.includes(expected),
      ),
    },
  };
}

export type PrototypeQualityReport = {
  hardFailures: readonly string[];
  score: {
    semanticStructure: boolean;
    responsive: boolean;
    interactive: boolean;
    contentComplete: boolean;
  };
};

export function evaluatePrototypeQuality(input: {
  scenario: ProductQualityScenario;
  html: string;
  appSpec: string;
}): PrototypeQualityReport {
  const prototype = input.scenario.expected.prototype;
  if (prototype === undefined)
    throw new Error("This product-quality scenario has no prototype contract.");
  const hardFailures: string[] = [];
  const require = (condition: boolean, message: string) => {
    if (!condition) hardFailures.push(message);
  };
  require(/<html\s+lang=["']en["']/iu.test(
    input.html,
  ), "Prototype lacks a language.");
  require(/<meta\s+name=["']viewport["']/iu.test(
    input.html,
  ), "Prototype lacks a responsive viewport.");
  require(/<main[\s>]/iu.test(input.html), "Prototype lacks a main landmark.");
  require(/<section\s+aria-labelledby=/iu.test(
    input.html,
  ), "Prototype lacks labelled workflow regions.");
  require(/@media\s*\(/iu.test(input.html), "Prototype lacks a narrow layout.");
  require(/addEventListener\s*\(\s*["']click["']/iu.test(
    input.html,
  ), "Prototype does not expose an interactive control.");
  require(!/lorem ipsum|todo:|placeholder text/iu.test(
    input.html,
  ), "Prototype contains unfinished placeholder content.");
  for (const text of prototype.requiredText)
    require(input.html.includes(text), `Prototype omitted ${text}.`);
  for (const selector of prototype.requiredSelectors) {
    const fragment = selector.startsWith("#")
      ? `id="${selector.slice(1)}"`
      : selector.startsWith(".")
        ? `class="${selector.slice(1).split(/\s/u)[0]}`
        : selector;
    require(input.html.includes(fragment), `Prototype omitted ${selector}.`);
  }
  const appSpecResult = validateBuildReadyAppSpec(input.appSpec);
  require(appSpecResult.valid, "Prototype AppSpec is not build-ready.");
  require(input.appSpec.includes(
    `prototype/${prototype.appId}/index.html`,
  ), "AppSpec does not bind the evaluated prototype path.");
  return {
    hardFailures,
    score: {
      semanticStructure:
        /<main[\s>]/iu.test(input.html) &&
        /<section\s+aria-labelledby=/iu.test(input.html),
      responsive: /@media\s*\(/iu.test(input.html),
      interactive: /addEventListener\s*\(\s*["']click["']/iu.test(input.html),
      contentComplete: !/lorem ipsum|todo:|placeholder text/iu.test(input.html),
    },
  };
}

export function productQualityScenario(
  id: ProductQualityScenario["id"],
): ProductQualityScenario {
  const scenario = PRODUCT_QUALITY_SCENARIOS.find(
    (candidate) => candidate.id === id,
  );
  if (scenario === undefined) throw new Error(`Unknown product eval ${id}.`);
  return scenario;
}
