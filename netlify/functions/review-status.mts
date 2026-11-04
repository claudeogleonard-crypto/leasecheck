// GET /api/reviews/:id: polled by the student page. Review IDs are random UUIDs.
import type { Config, Context } from "@netlify/functions";
import { error, json } from "../lib/http.mts";
import { getReview } from "../lib/store.mts";
import { publicRecord } from "../lib/agent-endpoint.mts";

export default async (_req: Request, context: Context) => {
  const id = context.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id || "")) return error("Invalid review id.", 400);
  const r = await getReview(id);
  if (!r) return error("Review not found.", 404);
  return json(publicRecord(r));
};

export const config: Config = { path: "/api/reviews/:id", method: "GET" };
