// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
