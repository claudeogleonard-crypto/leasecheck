// Lease text utilities used by the agents' search_lease tool and quote checks.

export interface Passage {
  id: string;
  text: string;
}

/** Splits a lease into passages (paragraphs/sections), merging short headings into the next block. */
export function splitPassages(text: string): Passage[] {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const merged: string[] = [];
  let carry = "";
  for (const b of blocks) {
    if (b.length < 50 && !/[.!?]$/.test(b)) {
      carry = carry ? `${carry}\n${b}` : b;
      continue;
    }
    merged.push(carry ? `${carry}\n${b}` : b);
    carry = "";
  }
  if (carry) merged.push(carry);
  // Break very long blocks (e.g. PDF text without blank lines) into ~700-char chunks on sentence boundaries.
  const out: string[] = [];
  for (const m of merged) {
    if (m.length <= 900) { out.push(m); continue; }
    let buf = "";
    for (const s of m.split(/(?<=[.!?])\s+/)) {
      if (buf.length + s.length > 700 && buf) { out.push(buf); buf = ""; }
      buf = buf ? `${buf} ${s}` : s;
    }
    if (buf) out.push(buf);
  }
  return out.map((t, i) => ({ id: `P${i + 1}`, text: t }));
}

const STOP = new Set("a an and the of to in on for or is are be by with this that any all as at from it its will may shall per".split(" "));
const SYNONYMS: Record<string, string[]> = {
  deposit: ["security", "refund"],
  rent: ["rental", "monthly"],
  fee: ["charge", "cost"],
  terminat: ["break", "early", "end"],
  break: ["terminat", "early"],
  repair: ["maintenance", "fix", "condition"],
  maintenance: ["repair"],
  occupan: ["occupant", "resident", "reside", "person", "people"],
  tenant: ["resident", "occupant", "lessee"],
  resident: ["tenant"],
  guest: ["visitor", "overnight"],
  entry: ["enter", "access", "inspect"],
  enter: ["entry", "access"],
  renew: ["renewal", "extend"],
  utilit: ["water", "electric", "gas", "trash", "sewer"],
  late: ["past", "overdue"],
  sublet: ["sublease", "assign"],
  bedroom: ["room", "basement"],
  liab: ["jointly", "severally", "responsible"],
  license: ["licens"],
  term: ["begin", "end", "month"],
};

function stem(w: string) {
  return w.replace(/(ations?|ing|ed|es|s|ies|y)$/, "").slice(0, 8);
}

function terms(q: string): string[] {
  const words = q.toLowerCase().match(/[a-z0-9$]+/g) || [];
  const base = words.filter((w) => !STOP.has(w) && w.length > 1).map(stem);
  const expanded = new Set(base);
  for (const b of base) for (const [k, syns] of Object.entries(SYNONYMS)) if (b.startsWith(k) || k.startsWith(b)) syns.forEach((s) => expanded.add(stem(s)));
  return [...expanded];
}

/** Returns the best-matching passages for a free-text query. */
export function searchPassages(passages: Passage[], query: string, limit = 3) {
  const qTerms = terms(query);
  const phrase = query.toLowerCase().trim();
  const scored = passages.map((p) => {
    const lower = p.text.toLowerCase();
    const words = new Set((lower.match(/[a-z0-9$]+/g) || []).map(stem));
    let score = 0;
    for (const t of qTerms) if ([...words].some((w) => w.startsWith(t))) score += 1;
    if (phrase.length > 3 && lower.includes(phrase)) score += 3;
    return { p, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.p);
}

/** One-line outline of the lease so the agent knows what sections exist (it still has to search to read them). */
export function outline(passages: Passage[]) {
  return passages.map((p) => `${p.id}: ${p.text.split("\n")[0].slice(0, 70)}`).join("\n");
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[“”"]/g, '"').replace(/[‘’']/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/** True if the quote appears in the source text (whitespace/quote-style insensitive; "..." allowed between parts). */
export function quoteInText(quote: string, source: string) {
  const q = norm(quote).replace(/^"|"$/g, "");
  if (!q) return false;
  const src = norm(source);
  const parts = q.split(/\.\.\.|…/).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 && parts.every((part) => src.includes(part));
}
