"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {
  // The snapshot changes only when React moves from server rendering to the client.
};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export const useHydrated = () => useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
