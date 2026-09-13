import SignUpPage from "../(product)/auth/sign-up/page";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  connection: vi.fn(),
  headers: vi.fn(() => Promise.resolve(new Headers())),
  session: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("next/server", () => ({ connection: dependencies.connection }));
vi.mock("next/headers", () => ({ headers: dependencies.headers }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/components/auth/sign-up", () => ({ SignUp: () => null }));
vi.mock("@/components/auth/auth-continuity", () => ({ AuthContinuity: () => null }));
vi.mock("@/lib/auth/preview-oauth-deployment", () => ({
  getPreviewOAuthDeploymentSession: dependencies.session,
  getPreviewOAuthDeploymentOrigin: () => "https://builder.example",
}));


it("waits for a real request before starting shared auth initialization", async () => {
  let release: (() => void) | undefined;
  dependencies.connection.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const page = SignUpPage({ searchParams: Promise.resolve({}) });
  const boundary = page.props.children[1] as ReactElement<{ children: ReactElement }>;
  const child = boundary.props.children;
  const check = child.type as (props: unknown) => Promise<unknown>;
  const pending = check(child.props);
  await Promise.resolve();
  expect(dependencies.connection).toHaveBeenCalledOnce();
  expect(dependencies.headers).not.toHaveBeenCalled();
  expect(dependencies.session).not.toHaveBeenCalled();
  release?.();
  await expect(pending).resolves.toBeNull();
  expect(dependencies.session).toHaveBeenCalledOnce();
});
