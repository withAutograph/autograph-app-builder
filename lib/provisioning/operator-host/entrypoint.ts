import { Hono } from "hono";
import operator from "../hosted-operator-function";

const app = new Hono();
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
app.all("*", async (context) => await operator.fetch(context.req.raw));

export default app;
