export const GET = () =>
  Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
