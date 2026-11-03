// Review-completed automation: save, queue, schedule, notify.
// Idempotent: Netlify retries background functions on failure, so every step checks whether it already ran.
import { holdNextSlot } from "./scheduling.mts";
import { notify, staffEmail } from "./notify.mts";
import { getReview, saveReview, queueStore, now, type QueueItem, type ReviewRecord } from "./store.mts";

/** Which reviews go to the attorney queue: every high-risk lease, plus any lease the triage agent sent for review. */
export function queueDecision(r: ReviewRecord): { queue: boolean; reason: string | null; priority: 1 | 2 | 3 } {
  const risk = r.risk!.overall_risk;
  const t = r.triage!;
  if (risk === "high") return { queue: true, reason: "High-risk lease", priority: t.urgency === "urgent" ? 1 : 2 };
  if (t.attorney_review_needed) return { queue: true, reason: "Triage agent recommended attorney review", priority: t.urgency === "urgent" ? 1 : 3 };
  return { queue: false, reason: null, priority: 3 };
}

export async function runReviewCompletedAutomation(reviewId: string, baseUrl: string) {
  const r = await getReview(reviewId);
  if (!r) throw new Error(`Review ${reviewId} not found`);
  if (!r.triage || !r.risk || !r.extraction) throw new Error(`Review ${reviewId} is not finished`);
  if (r.automation?.completedAt) return r; // already done

  r.steps.automation = { status: "running", startedAt: now() };

  // 1. Save the record (persist the finished review and mark the save time).
  const savedAt = now();
  await saveReview(r);

  // 2. Add the lease to the attorney queue when needed.
  const decision = queueDecision(r);
  const queue = queueStore();
  let item = (await queue.get(r.id, { type: "json" })) as QueueItem | null;

  // 3. Suggest an appointment slot (held until staff confirm).
  if (decision.queue && !item) {
    const slot = await holdNextSlot(r.id, r.triage.urgency === "urgent");
    item = {
      id: r.id,
      createdAt: now(),
      updatedAt: now(),
      priority: decision.priority,
      risk: r.risk.overall_risk,
      riskScore: r.risk.risk_score,
      urgency: r.triage.urgency,
      reason: `${decision.reason}. ${r.triage.triage_reason}`,
      studentName: r.input.studentName,
      studentEmail: r.input.studentEmail,
      address: r.extraction.property_address,
      monthlyRent: r.extraction.monthly_rent_total,
      topFlags: r.risk.flags.slice(0, 4).map((f) => ({ severity: f.severity, title: f.title })),
      suggestedSlot: slot,
      status: "new",
      staffNotes: "",
    };
    await queue.setJSON(r.id, item, { onlyIfNew: true });
  }

  // 4. Send notifications.
  const notifications: { kind: string; to: string; result: string }[] = [];
  const reviewUrl = new URL(`/?review=${r.id}`, baseUrl).toString();
  const staffUrl = new URL(`/staff`, baseUrl).toString();

  if (item) {
    const n = await notify({
      reviewId: r.id,
      kind: "staff_attorney_queue",
      to: staffEmail(),
      webhook: true,
      subject: `LeaseCheck: ${item.risk.toUpperCase()} risk lease added to attorney queue (${item.urgency})`,
      body: [
        `Student: ${item.studentName || "Anonymous"}${item.studentEmail ? ` <${item.studentEmail}>` : ""}`,
        `Property: ${item.address || "Not stated"}`,
        `Risk: ${item.risk} (${item.riskScore}/100) · Urgency: ${item.urgency}`,
        `Top issues: ${item.topFlags.map((f) => f.title).join("; ") || "n/a"}`,
        `Suggested slot: ${item.suggestedSlot?.label || "No open slot in the next 4 weeks"}`,
        `Dashboard: ${staffUrl}`,
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
      subject: `Your LeaseCheck review is ready (${r.risk.overall_risk} risk)`,
      body: [
        `Hi${r.input.studentName ? ` ${r.input.studentName}` : ""},`,
        ``,
        `Your lease review is ready: ${reviewUrl}`,
        item
          ? `Because of what we found, we've flagged your lease for a CU Boulder Student Legal Services attorney. Suggested appointment: ${item.suggestedSlot?.label || "staff will contact you"}. Off-Campus Housing staff will confirm by email.`
          : `No attorney review appears necessary, but read the questions for your landlord before you sign.`,
        ``,
        `LeaseCheck is educational guidance, not legal advice.`,
      ].join("\n"),
    });
    notifications.push({ kind: n.kind, to: n.to, result: `email ${n.delivery.email}` });
  }

  r.automation = {
    savedAt,
    queued: !!item,
    queueReason: decision.reason,
    suggestedSlot: item?.suggestedSlot ?? null,
    notifications,
    completedAt: now(),
  };
  r.steps.automation = { ...r.steps.automation, status: "done", finishedAt: now() };
  r.status = "complete";
  return saveReview(r);
}
