import { describe, expect, it } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { builderValidationModelId } from "../integrations/active-model";
import { matchesSourceReviewPolicy, recordSourceReviewRequest, sanitizeSourceJudgment, sourceReviewPolicy, sourceReviewProviderOptions, unavailableSourceAssessment } from "./product-source-review";
import type { SourceReviewRequest } from "./product-source-review-batches";
import { serializeSourceReviewRecord } from "./product-source-review-journal";

const input={appSpec:"spec",appSpecDigest:"spec",clarifications:[],files:[],omissions:[],originalRequest:"request",sourceDigest:"source"};
describe("source review policy contract", () => {
  it("routes source review independently without changing design-quality Sol", () => {
    const policy=sourceReviewPolicy();
    expect(builderValidationModelId).toBe("openai/gpt-6.1-sol");
    expect(policy).toEqual({fallback:{modelId:"openai/gpt-6.1-sol",reasoningEffort:null},id:"terra-low-sol-fallback-v1",primary:{modelId:"openai/gpt-6.1-terra",reasoningEffort:"low"}});
    expect(sourceReviewProviderOptions(policy.primary)).toEqual({gateway:{only:["openai"]},openai:{reasoningEffort:"low"}});
    expect(sourceReviewProviderOptions(policy.fallback)).toEqual({gateway:{only:["openai"]}});
  });
  it("binds actual reviewer and effort to the full policy identity", () => {
    const policy=sourceReviewPolicy();
    const actual={...unavailableSourceAssessment(input,"test","blocked",policy.primary),reviewPolicyId:policy.id};
    expect(matchesSourceReviewPolicy(actual,policy)).toBe(true);
    expect(matchesSourceReviewPolicy({...actual,modelId:policy.fallback.modelId,reasoningEffort:null},policy)).toBe(true);
    expect(matchesSourceReviewPolicy({...actual,reviewPolicyId:"other"},policy)).toBe(false);
    expect(matchesSourceReviewPolicy({...actual,reasoningEffort:"medium"},policy)).toBe(false);
    expect(matchesSourceReviewPolicy({...actual,modelId:policy.fallback.modelId},policy)).toBe(false);
  });
  it("preserves legacy Sol attribution unless an actual reviewer is explicitly provided", () => {
    expect(unavailableSourceAssessment(input,"test").modelId).toBe(builderValidationModelId);
    expect(sanitizeSourceJudgment(input,{findings:[],remainingRuntimeChecks:[]}).modelId).toBe(builderValidationModelId);
    expect(sanitizeSourceJudgment(input,{findings:[],remainingRuntimeChecks:[]},[],sourceReviewPolicy().primary)).toMatchObject({modelId:"openai/gpt-6.1-terra",reasoningEffort:"low"});
  });
  it("accepts complete new metadata and legacy journal records", () => {
    const policy=sourceReviewPolicy();
    const completed={...unavailableSourceAssessment(input,"test","unassessed",policy.primary),reviewCompleted:true as const,reviewPolicyId:policy.id,reviewRubricDigest:"a".repeat(64),status:"unassessed" as const};
    expect(serializeSourceReviewRecord({assessment:completed,kind:"application-completed"})).toContain(policy.id);
    const legacy={...unavailableSourceAssessment(input,"test"),reviewCompleted:true as const,status:"unassessed" as const};
    expect(serializeSourceReviewRecord({assessment:legacy,kind:"application-completed"})).toContain(builderValidationModelId);
  });
});

it("attributes each SDK call to its actual reviewer without exposing content", async () => {
  const policy=sourceReviewPolicy(); const records:SourceReviewRequest[]=[];
  const model = new MockLanguageModelV4({ async doGenerate() { return await Promise.resolve({content:[{text:"private test content",type:"text" as const}],finishReason:{raw:"stop",unified:"stop" as const},usage:{inputTokens:{cacheRead:0,cacheWrite:0,noCache:5,total:5},outputTokens:{reasoning:0,text:2,total:2}},warnings:[]}); }, modelId: "fixture" });
  for(const reviewer of [policy.primary,policy.fallback]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Keep attribution records ordered for the two distinct reviewers.
    await generateText({model,onLanguageModelCallEnd(event) {recordSourceReviewRequest({onRequest:(record)=>{records.push(record);}},event,reviewer);},prompt:"fixture"});
  }
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({modelId:policy.primary.modelId,reasoningEffort:"low"});
  expect(records[1]).toMatchObject({modelId:policy.fallback.modelId,reasoningEffort:null});
  expect(JSON.stringify(records)).not.toContain("private test content");
});
