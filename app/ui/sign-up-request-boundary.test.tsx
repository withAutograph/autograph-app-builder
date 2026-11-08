import SignUpPage from "../(product)/auth/sign-up/page";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  connection: vi.fn(),
  headers: vi.fn(() => Promise.resolve(new Headers())),
  session: vi.fn(() => Promise.resolve(null)),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled next/server dependency used by this test.
vi.mock("next/server", () => ({ connection: dependencies.connection }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled next/headers dependency used by this test.
vi.mock("next/headers", () => ({ headers: dependencies.headers }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled next/navigation dependency used by this test.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking, sonarjs/function-name -- Keep the controlled framework seam and its real React component export name.
vi.mock("@/components/auth/sign-up", () => ({ SignUp: () => null }));
// oxlint-disable-next-line anti-slop/no-module-mocking, sonarjs/function-name -- Keep the controlled framework seam and its real React component export name.
vi.mock("@/components/auth/auth-continuity", () => ({ AuthContinuity: () => null }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/auth/preview-oauth-deployment dependency used by this test.
vi.mock("@/lib/auth/preview-oauth-deployment", () => ({
  getPreviewOAuthDeploymentOrigin: () => "https://builder.example",
  getPreviewOAuthDeploymentSession: dependencies.session,
}));

it("waits for a real request before starting shared auth initialization", async () => {
  const connection = Promise.withResolvers<null>();
  dependencies.connection.mockImplementation(() => connection.promise);
  const page = SignUpPage({ searchParams: Promise.resolve({}) });
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Inspect the rendered test boundary's children.
  const boundary = page.props.children[1] as ReactElement<{ children: ReactElement }>;
  const child = boundary.props.children;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The test invokes the rendered boundary with untrusted props.
  const check = child.type as (props: unknown) => Promise<unknown>;
  const pending = check(child.props);
  await Promise.resolve();
  expect(dependencies.connection).toHaveBeenCalledOnce();
  expect(dependencies.headers).not.toHaveBeenCalled();
  expect(dependencies.session).not.toHaveBeenCalled();
  connection.resolve(null);
  await expect(pending).resolves.toBeNull();
  expect(dependencies.session).toHaveBeenCalledOnce();
});
