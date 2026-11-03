// GET /api/reviews/:id: polled by the student page. Review IDs are random UUIDs.
import type { Config, Context } from "@netlify/functions";
import { error, json } from "../lib/http.mts";
import { getReview } from "../lib/store.mts";

export default async (_req: Request, context: Context) => {
  const id = context.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id || "")) return error("Invalid review id.", 400);
  const r = await getReview(id);
  if (!r) return error("Review not found.", 404);
  // The student view does not need the student's own contact details echoed back.
  const { input, ...rest } = r;
  return json({ ...rest, input: { source: input.source, fileName: input.fileName, bedrooms: input.bedrooms } });
};

export const config: Config = { path: "/api/reviews/:id", method: "GET" };
