import type { ReactNode } from "react";

import { RouteProviders } from "@/components/route-providers";

import Loading from "./loading";

export default function Layout({ children }: { children: ReactNode }) {
  return <RouteProviders fallback={<Loading />}>{children}</RouteProviders>;
}
