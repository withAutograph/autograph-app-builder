import SignUpPage from "../(product)/auth/sign-up/page";
import { Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";

it("keeps authenticated visitor lookup behind the request boundary", () => {
  const page = SignUpPage({ searchParams: Promise.resolve({}) });
  const pageChildren: ReactNode = page.props.children;
  const children = Children.toArray(pageChildren);
  const lookupBoundary = children.at(-1);

  expect(isValidElement(lookupBoundary)).toBe(true);
  if (!isValidElement(lookupBoundary)) {
    return;
  }
  expect(lookupBoundary.type).toBeDefined();
  expect(lookupBoundary.props.fallback).toBeNull();
  expect(lookupBoundary.props.children).toBeDefined();
});
