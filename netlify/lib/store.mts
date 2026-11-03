// Persistence on Netlify Blobs. Site-wide stores with strong consistency so polling sees fresh state.
// Note: site-wide stores are shared by deploy previews and production. Avoid test submissions on previews.
import { getStore } from "@netlify/blobs";
import type { Extraction, RiskAssessment, Triage, Risk } from "./schemas.mts";

const store = (name: string) => getStore({ name, consistency: "strong" });

export const reviewsStore = () => store("reviews");
export const inputsStore = () => store("lease-inputs");
export const queueStore = () => store("attorney-queue");
export const appointmentsStore = () => store("appointments");
export const notificationsStore = () => store("notifications");

export type StepName = "extraction" | "risk" | "triage" | "automation";
export type StepStatus = "pending" | "running" | "done" | "failed";

export interface ReviewRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "queued" | "running" | "reviewed" | "complete" | "failed";
  steps: Record<StepName, { status: StepStatus; startedAt?: string; finishedAt?: string }>;
  input: {
    source: "text" | "pdf";
    fileName: string | null;
    sizeChars: number | null;
    studentName: string | null;
    studentEmail: string | null;
    bedrooms: number | null;
    notes: string | null;
  };
  extraction?: Extraction;
  risk?: RiskAssessment;
  triage?: Triage;
  automation?: {
    savedAt: string;
    queued: boolean;
    queueReason: string | null;
    suggestedSlot: Slot | null;
    notifications: { kind: string; to: string; result: string }[];
    completedAt: string;
  };
  error?: string;
}

export interface Slot {
  id: string; // e.g. 2026-11-05T13:00 (America/Denver local time)
  label: string; // e.g. Thu, Nov 5 · 1:00 PM MT
  durationMinutes: number;
  location: string;
}

export interface QueueItem {
  id: string; // same as review id
  createdAt: string;
  updatedAt: string;
  priority: 1 | 2 | 3; // 1 = most urgent
  risk: Risk;
  riskScore: number;
  urgency: Triage["urgency"];
  reason: string;
  studentName: string | null;
  studentEmail: string | null;
  address: string | null;
  monthlyRent: number | null;
  topFlags: { severity: Risk; title: string }[];
  suggestedSlot: Slot | null;
  status: "new" | "scheduled" | "in_review" | "resolved";
  staffNotes: string;
}

export interface NotificationRecord {
  id: string;
  createdAt: string;
  reviewId: string;
  kind: "staff_attorney_queue" | "student_review_ready";
  to: string;
  subject: string;
  body: string;
  delivery: { email: string; webhook: string };
}

export const now = () => new Date().toISOString();

export async function getReview(id: string) {
  return (await reviewsStore().get(id, { type: "json" })) as ReviewRecord | null;
}

export async function saveReview(r: ReviewRecord) {
  r.updatedAt = now();
  await reviewsStore().setJSON(r.id, r);
  return r;
}

export async function listJSON<T>(name: string, limit = 200): Promise<T[]> {
  const s = store(name);
  const { blobs } = await s.list();
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  const items = await Promise.all(keys.map((k) => s.get(k, { type: "json" })));
  return items.filter(Boolean) as T[];
}
