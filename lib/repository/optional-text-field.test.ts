import { describe, expect, it } from "vitest";
import { addOptionalTextField, optionalTextFieldSchema } from "./optional-text-field";

const schema = `package schema

manifest: #AppManifest & {
  app_id: "draft-tool"
  version: "2026-11-16.v7"
  models: [{id: "entry", kind: "entity", label: "Entry", fields: [
    {id: "owner_id", label: "Owner id", type: "text", required: true}, // preserve my casing
  ]}, {id: "other", kind: "entity", fields: [{id: "owner_id", label: "Different   label"}]}]
  change_types: [
    {id: "save", model: "entry", touches: ["owner_id"], required: ["owner_id"]},
    {id: "edit", model: "entry", touches: ["owner_id",], required: []},
    {id: "another", model: "other", touches: ["owner_id"]},
  ]
}
`;

const field = optionalTextFieldSchema.parse({
  modelId: "entry",
  fieldId: "reference",
  label: 'Ref "number"',
  changeTypeIds: ["save", "edit"],
});

describe("planning a generated optional text field", () => {
  it("preserves source bytes and changes only the new field, selected writes and release cut", () => {
    const { content, releaseId } = addOptionalTextField(schema, field);
    expect(releaseId).toBe("2026-11-16.v8");
    const inserted = '{id: "reference", label: "Ref \\"number\\"", type: "text", required: false},';
    expect(content).toContain(inserted);
    const unmodified = content
      .replace(inserted, "")
      .replace('["owner_id", "reference"]', '["owner_id"]')
      .replace('["owner_id","reference",]', '["owner_id",]')
      .replace("2026-11-16.v8", "2026-11-16.v7");
    expect(unmodified).toBe(schema);
  });

  it("handles the compact generated literal layout", () => {
    const source = schema.replaceAll(/\s*\/\/[^\n]*/gu, "").replaceAll(/\n\s*/gu, " ");
    const { content } = addOptionalTextField(source, field);
    expect(content).toContain('label: "Owner id"');
    expect(content).toContain("required: false");
    expect(content).toContain('["owner_id", "reference"]');
  });

  it("confines writes to selected change types on the selected model", () => {
    expect(() => addOptionalTextField(schema, { ...field, changeTypeIds: ["another"] })).toThrow(
      /safely add/u,
    );
    expect(() =>
      addOptionalTextField(schema, { ...field, changeTypeIds: ["save", "save"] }),
    ).toThrow(/safely add/u);
  });

  it("refuses collisions, unsupported layouts, and ambiguous declarations", () => {
    expect(() => addOptionalTextField(schema, { ...field, fieldId: "owner_id" })).toThrow(
      /already exists/u,
    );
    expect(() =>
      addOptionalTextField(schema.replace('kind: "entity"', 'kind: "lookup"'), field),
    ).toThrow(/safely add/u);
    expect(() => addOptionalTextField(schema.replace('id: "other"', 'id: "entry"'), field)).toThrow(
      /safely add/u,
    );
    expect(() =>
      addOptionalTextField(schema.replace('version: "2026-11-16.v7"', "version: unbound"), field),
    ).toThrow(/safely add/u);
    const escapedField = schema.replace('"owner_id"', String.raw`"owner_\u0069d"`);
    expect(() => addOptionalTextField(escapedField, { ...field, fieldId: "owner_id" })).toThrow(
      /already exists/u,
    );
  });
});
