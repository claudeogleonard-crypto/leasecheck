// Review-completed automation (separate from the agents): save, queue, attach slot, notify.
// Idempotent: each step checks whether it already ran, so a retry is safe.
import { holdNextSlot } from "./scheduling.mts";
import { notify, staffEmail } from "./notify.mts";
import { getReview, saveReview, queueStore, now, type QueueItem, type ReviewRecord } from "./store.mts";

export function queuePriority(r: ReviewRecord): 1 | 2 | 3 {
  const rating = r.risk?.rating;
  if (rating === "high") return 1;
  if (rating === "medium" || rating == null) return 2;
  return 3;
}

export async function runReviewCompletedAutomation(reviewId: string, baseUrl: string) {
  const r = await getReview(reviewId);
  if (!r) throw new Error(`Review ${reviewId} not found`);
  if (!r.triage || !r.risk || !r.extraction) throw new Error(`Review ${reviewId} is not finished`);
  if (r.automation?.completedAt) return r;

  r.steps.automation = { status: "running", startedAt: now() };

  // 1. Save the record.
  const savedAt = now();
  await saveReview(r);

  // 2. Queue attorney_review leases, and 3. attach a suggested slot.
  const toQueue = r.triage.route === "attorney_review";
  const queue = queueStore();
  let item = (await queue.get(r.id, { type: "json" })) as QueueItem | null;
  if (toQueue && !item) {
    const priority = queuePriority(r);
    const slot = await holdNextSlot(r.id, priority === 1);
    const f = r.extraction.fields;
    item = {
      id: r.id,
      createdAt: now(),
      updatedAt: now(),
      priority,
      risk: r.risk.rating ?? "needs_review",
      reason: [r.triage.route_reason, r.triage.policy_override].filter(Boolean).join(" "),
      studentName: r.input.studentName,
      studentEmail: r.input.studentEmail,
      address: f.property_address?.value ?? null,
      monthlyRent: f.monthly_rent?.value ?? null,
      topFlags: [...r.risk.flags]
        .sort((a, b) => ["high", "medium", "low"].indexOf(a.severity) - ["high", "medium", "low"].indexOf(b.severity))
        .slice(0, 4)
        .map((fl) => ({ severity: fl.severity, title: fl.reason.length > 90 ? `${fl.reason.slice(0, 89)}…` : fl.reason })),
      suggestedSlot: slot,
      status: "new",
      staffNotes: "",
    };
    await queue.setJSON(r.id, item, { onlyIfNew: true });
  }

  // 4. Send notifications.
  const notifications: { kind: string; to: string; result: string }[] = [];
  const reviewUrl = new URL(`/?review=${r.id}`, baseUrl).toString();
  if (item) {
    const n = await notify({
      reviewId: r.id,
      kind: "staff_attorney_queue",
      to: staffEmail(),
      webhook: true,
      subject: `LeaseCheck: ${item.risk === "needs_review" ? "lease needing review" : `${item.risk.toUpperCase()} risk lease`} added to attorney queue`,
      body: [
        `Student: ${item.studentName || "Anonymous"}${item.studentEmail ? ` <${item.studentEmail}>` : ""}`,
        `Property: ${item.address || "Not stated"}`,
        `Rating: ${item.risk} · Priority ${item.priority}`,
        `Why: ${item.reason}`,
        `Top issues: ${item.topFlags.map((t) => t.title).join(" | ") || "n/a"}`,
        `Suggested slot: ${item.suggestedSlot?.label || "No open slot in the sample calendar"}`,
        `Dashboard: ${new URL("/staff", baseUrl)}`,
      ].join("\n"),
    });
    notifications.push({ kind: n.kind, to: n.to, result: `email ${n.delivery.email}; webhook ${n.delivery.webhook}` });
  }
  if (r.input.studentEmail) {
    const n = await notify({
      reviewId: r.id,
      kind: "student_review_ready",
      to: r.input.studentEmail,
      webhook: false,
      subject: `Your LeaseCheck review is ready`,
      body: [
        `Hi${r.input.studentName ? ` ${r.input.studentName}` : ""},`,
        ``,
        `Your lease review is ready: ${reviewUrl}`,
        item
          ? `We've flagged your lease for a CU Boulder Student Legal Services attorney. Suggested appointment: ${item.suggestedSlot?.label || "staff will contact you"}. Off-Campus Housing staff will confirm by email.`
          : `No attorney review appears necessary, but read the questions for your landlord before you sign.`,
        ``,
        `LeaseCheck is educational guidance, not legal advice.`,
      ].join("\n"),
    });
    notifications.push({ kind: n.kind, to: n.to, result: `email ${n.delivery.email}` });
  }

  r.automation = { savedAt, queued: !!item, queueReason: item ? item.reason : null, suggestedSlot: item?.suggestedSlot ?? null, notifications, completedAt: now() };
  r.steps.automation = { ...r.steps.automation, status: "done", finishedAt: now() };
  r.status = "complete";
  return saveReview(r);
}
