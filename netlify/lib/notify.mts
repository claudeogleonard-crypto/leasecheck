// Notifications: every notification is recorded in Blobs (and shown on the staff dashboard).
// Delivery uses whichever providers are configured: Resend for email, and/or a Slack-compatible webhook.
import { notificationsStore, now, type NotificationRecord } from "./store.mts";

const env = (k: string) => Netlify.env.get(k) || "";

async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const key = env("RESEND_API_KEY");
  const from = env("NOTIFY_FROM_EMAIL");
  if (!key || !from) return "skipped (email not configured)";
  if (!to) return "skipped (no recipient)";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    return res.ok ? "sent" : `error (HTTP ${res.status})`;
  } catch (e) {
    return `error (${(e as Error).message})`;
  }
}

async function sendWebhook(text: string): Promise<string> {
  const url = env("NOTIFY_WEBHOOK_URL");
  if (!url) return "skipped (webhook not configured)";
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return res.ok ? "sent" : `error (HTTP ${res.status})`;
  } catch (e) {
    return `error (${(e as Error).message})`;
  }
}

export async function notify(opts: {
  reviewId: string;
  kind: NotificationRecord["kind"];
  to: string;
  subject: string;
  body: string;
  webhook: boolean;
}): Promise<NotificationRecord> {
  const [email, webhook] = await Promise.all([
    sendEmail(opts.to, opts.subject, opts.body),
    opts.webhook ? sendWebhook(`*${opts.subject}*\n${opts.body}`) : Promise.resolve("n/a"),
  ]);
  const rec: NotificationRecord = {
    id: `${now()}_${opts.reviewId}_${opts.kind}`,
    createdAt: now(),
    reviewId: opts.reviewId,
    kind: opts.kind,
    to: opts.to || "(not provided)",
    subject: opts.subject,
    body: opts.body,
    delivery: { email, webhook },
  };
  await notificationsStore().setJSON(rec.id, rec);
  return rec;
}

export const staffEmail = () => env("STAFF_NOTIFY_EMAIL");
