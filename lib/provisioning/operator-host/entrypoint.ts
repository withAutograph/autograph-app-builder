import { Hono } from "hono";
import operator from "../hosted-operator-function";

const app = new Hono();
app.all("*", async (context) => await operator.fetch(context.req.raw));

export default app;
