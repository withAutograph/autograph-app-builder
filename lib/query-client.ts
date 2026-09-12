import { environmentManager, QueryClient } from "@tanstack/react-query";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5000 },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getQueryClient() {
  if (environmentManager.isServer()) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
