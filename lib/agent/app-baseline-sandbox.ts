import type { SelectedAppBaseline } from "./app-baseline-state";
import { assertAppBaselineAuthority } from "../repository/app-baseline";
import type { AppBaselineSelection } from "../repository/app-baseline";

export interface AppBaselineSourceOpening<Sandbox> {
  baseline: SelectedAppBaseline | undefined;
  repository: { name: string; owner: string; repositoryId: string } | undefined;
  sessionId: string;
  bindSource: () => void;
  openSandbox: () => Promise<Sandbox>;
  isPrepared: (sandbox: Sandbox, selection: AppBaselineSelection) => Promise<boolean>;
  restore: (sandbox: Sandbox, baseline: Required<SelectedAppBaseline>) => Promise<void>;
}

/** No source consumer receives replacement compute before its selected app has been restored. */
export const openAppBaselineSource = async <Sandbox>(
  input: AppBaselineSourceOpening<Sandbox>,
): Promise<Sandbox> => {
  const { baseline } = input;
  if (baseline !== undefined) {
    if (input.repository === undefined || baseline.receipt === undefined) {
      throw new Error(
        "The selected app baseline is not prepared. Retry resolve_github_source before app inspection.",
      );
    }
    assertAppBaselineAuthority({
      repository: input.repository,
      selection: baseline.selection,
      sessionId: input.sessionId,
    });
  }
  input.bindSource();
  const sandbox = await input.openSandbox();
  if (baseline?.receipt !== undefined && !(await input.isPrepared(sandbox, baseline.selection))) {
    await input.restore(sandbox, { receipt: baseline.receipt, selection: baseline.selection });
  }
  return sandbox;
};
