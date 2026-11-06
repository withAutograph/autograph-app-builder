const getHealth = () =>
  Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
export { getHealth as GET };
