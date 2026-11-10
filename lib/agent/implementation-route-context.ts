import type { TargetProposal } from "../repository/target-planning";

/** Authoring context only; the saved plan owns the declared public routes. */
export const implementationRouteContext = (plan?: TargetProposal["plan"]) =>
  plan === undefined
    ? {}
    : {
        implementationRouting: {
          routes: [...plan.topology.routes],
          instruction:
            "Catalog ownership preserves these public paths; the app router must serve them, including navigation and redirect destinations.",
        },
      };
