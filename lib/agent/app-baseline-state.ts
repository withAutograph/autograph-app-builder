import { defineState } from "eve/context";
import { appBaselineSelectionSchema } from "../repository/app-baseline";
import type {
  AppBaselineInput,
  AppBaselineReceipt,
  AppBaselineSelection,
} from "../repository/app-baseline";

export interface SelectedAppBaseline {
  selection: AppBaselineSelection;
  receipt?: AppBaselineReceipt;
}
export const appBaselineState = defineState<SelectedAppBaseline | undefined>(
  "autograph-app-builder.app-baseline.v1",
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Unselected durable state is explicitly absent.
  () => undefined,
);

/** A baseline is selected once, before the model can inspect or edit app source. */
export const assertInitialAppBaseline = (input: {
  occupied: boolean;
  repository: string;
  requested: AppBaselineInput | undefined;
  saved: SelectedAppBaseline | undefined;
}): void => {
  if (input.saved !== undefined) {
    const saved = appBaselineSelectionSchema.parse(input.saved.selection);
    if (
      `${saved.historical.owner}/${saved.historical.name}` !== input.repository ||
      (input.requested !== undefined &&
        JSON.stringify(input.requested) !==
          JSON.stringify({ appId: saved.appId, source: saved.source }))
    ) {
      throw new Error(
        "This Builder session already owns a different app baseline. Continue its original selection or start a new Builder session.",
      );
    }
    return;
  }
  if (input.occupied && input.requested !== undefined) {
    throw new Error(
      "Select an app baseline before app source preparation or inspection. This occupied source will not be replaced; start a new Builder session.",
    );
  }
};
