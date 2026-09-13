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
  getPreviewOAuthDeploymentOrigin: () => "https://builder.example",
  getPreviewOAuthDeploymentSession: dependencies.session,
}));

it("waits for a real request before starting shared auth initialization", async () => {
  const connection = Promise.withResolvers<null>();
  dependencies.connection.mockImplementation(() => connection.promise);
  const page = SignUpPage({ searchParams: Promise.resolve({}) });
  const boundary = page.props.children[1] as ReactElement<{ children: ReactElement }>;
  const child = boundary.props.children;
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
