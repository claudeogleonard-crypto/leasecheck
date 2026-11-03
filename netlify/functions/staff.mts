// Staff API (password-protected via STAFF_PASSWORD):
//   GET   /api/staff/overview          queue, recent reviews, notifications, stats
//   GET   /api/staff/reviews/:id       full review record
//   PATCH /api/staff/queue/:id         update queue status, notes, or confirm the slot
import type { Config, Context } from "@netlify/functions";
import { error, json, staffAuth } from "../lib/http.mts";
import {
  appointmentsStore,
  getReview,
  listJSON,
  now,
  queueStore,
  type NotificationRecord,
  type QueueItem,
  type ReviewRecord,
} from "../lib/store.mts";

const STATUSES: QueueItem["status"][] = ["new", "scheduled", "in_review", "resolved"];

export default async (req: Request, context: Context) => {
  const denied = staffAuth(req);
  if (denied) return denied;
  const { resource, id } = context.params;

  if (req.method === "GET" && resource === "overview") {
    const [queue, reviews, notifications] = await Promise.all([
      listJSON<QueueItem>("attorney-queue", 500),
      listJSON<ReviewRecord>("reviews", 100),
      listJSON<NotificationRecord>("notifications", 50),
    ]);
    queue.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const done = reviews.filter((r) => r.risk);
    const stats = {
      totalReviews: reviews.length,
      openQueue: queue.filter((q) => q.status !== "resolved").length,
      byRisk: {
        low: done.filter((r) => r.risk!.overall_risk === "low").length,
        medium: done.filter((r) => r.risk!.overall_risk === "medium").length,
        high: done.filter((r) => r.risk!.overall_risk === "high").length,
      },
      failed: reviews.filter((r) => r.status === "failed").length,
    };
    const reviewSummaries = reviews.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      studentName: r.input.studentName,
      address: r.extraction?.property_address ?? null,
      risk: r.risk?.overall_risk ?? null,
      riskScore: r.risk?.risk_score ?? null,
      attorney: r.triage?.attorney_review_needed ?? null,
      queued: r.automation?.queued ?? null,
      error: r.error ?? null,
    }));
    return json({ stats, queue, reviews: reviewSummaries, notifications });
  }

  if (req.method === "GET" && resource === "reviews" && id) {
    const r = await getReview(id);
    return r ? json(r) : error("Not found", 404);
  }

  if (req.method === "PATCH" && resource === "queue" && id) {
    const store = queueStore();
    const item = (await store.get(id, { type: "json" })) as QueueItem | null;
    if (!item) return error("Not found", 404);
    const body = await req.json().catch(() => ({}));
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return error("Invalid status");
      item.status = body.status;
    }
    if (typeof body.staffNotes === "string") item.staffNotes = body.staffNotes.slice(0, 5000);
    if (body.confirmSlot && item.suggestedSlot) {
      await appointmentsStore().setJSON(item.suggestedSlot.id, {
        reviewId: id, status: "confirmed", confirmedAt: now(), slot: item.suggestedSlot,
      });
      item.status = "scheduled";
    }
    if (item.status === "resolved" && item.suggestedSlot && body.releaseSlot) {
      await appointmentsStore().delete(item.suggestedSlot.id);
      item.suggestedSlot = null;
    }
    item.updatedAt = now();
    await store.setJSON(id, item);
    return json(item);
  }

  return error("Not found", 404);
};

export const config: Config = {
  path: ["/api/staff/:resource", "/api/staff/:resource/:id"],
  method: ["GET", "PATCH"],
};
