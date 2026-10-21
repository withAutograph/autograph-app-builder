import { describe, expect, it } from "vitest";
import { appDescriptionSchema } from "./app-description";
import { generatedAppRoleSchema } from "./generated-app-role";
import { hostedOperatorSourceConfigurationSchema } from "../provisioning/hosted-operator-source-configuration";
import { hostedOperatorPlanSchema } from "../provisioning/hosted-operator-contract";
import {
  normalActorProgramSchema,
  normalActorIdentityManifestSchema,
} from "../provisioning/hosted-operator-normal-actor-program";

describe("generated app product roles", () => {
  it("uses the AppDescription role contract throughout configuration, grants and identity projection", () => {
    const role = `review_${"custom_scope_".repeat(8)}`;
    expect(generatedAppRoleSchema.parse(role)).toBe(role);
    const description = appDescriptionSchema.shape.backend.options[1];
    expect(description.shape.roles.parse([role])).toEqual([role]);
    const application = hostedOperatorSourceConfigurationSchema.shape.applications.valueType;
    expect(application.shape.accessRoles.parse([role])).toEqual([role]);
    expect(
      hostedOperatorPlanSchema.shape.access.parse([
        { actorId: "actor", organizationId: "organization", roles: [role] },
      ]),
    ).toMatchObject([{ roles: [role] }]);
    expect(
      normalActorProgramSchema.shape.appAccess.parse([
        { actorKey: "actor", organizationId: "organization", roles: [role] },
      ]),
    ).toMatchObject([{ roles: [role] }]);
    expect(
      normalActorIdentityManifestSchema.shape.actors.parse([
        {
          actorKey: "actor",
          actorId: "actor-id",
          organizationId: "organization",
          roles: [role],
          storageState: "private-reference",
        },
      ]),
    ).toMatchObject([{ roles: [role] }]);
  });

  it("keeps SQL identifiers constrained separately and allows zero product roles", () => {
    expect(
      hostedOperatorPlanSchema.shape.appDatabase.shape.database.safeParse("a".repeat(64)).success,
    ).toBe(false);
    const application = hostedOperatorSourceConfigurationSchema.shape.applications.valueType;
    expect(application.shape.accessRoles.parse([])).toEqual([]);
    expect(hostedOperatorPlanSchema.shape.access.parse([])).toEqual([]);
  });
});
