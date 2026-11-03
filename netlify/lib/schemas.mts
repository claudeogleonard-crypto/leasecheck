// JSON Schemas for the three agents' structured outputs.
// Every object lists all properties as required and sets additionalProperties: false,
// as structured outputs require. Optional values are expressed as nullable.

const str = { type: "string" } as const;
const nullableStr = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const nullableNum = { anyOf: [{ type: "number" }, { type: "null" }] } as const;
const nullableInt = { anyOf: [{ type: "integer" }, { type: "null" }] } as const;
const nullableBool = { anyOf: [{ type: "boolean" }, { type: "null" }] } as const;

function obj(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const CLAUSE_CATEGORIES = [
  "rent_payment",
  "late_fees",
  "security_deposit",
  "utilities",
  "maintenance_repairs",
  "entry_access",
  "subletting_assignment",
  "occupancy_guests",
  "early_termination",
  "renewal",
  "joint_liability",
  "pets",
  "parking",
  "move_out_cleaning",
  "attorney_fees",
  "habitability",
  "other",
] as const;

export const extractionSchema = obj({
  property_address: nullableStr,
  landlord_or_manager: nullableStr,
  tenant_names: { type: "array", items: str },
  number_of_tenants: nullableInt,
  bedrooms: nullableInt,
  monthly_rent_total: nullableNum,
  rent_per_tenant: nullableNum,
  rent_due: nullableStr,
  security_deposit: nullableNum,
  deposit_refundable: nullableBool,
  fees: {
    type: "array",
    items: obj({
      name: str,
      amount: nullableNum,
      frequency: { type: "string", enum: ["one_time", "monthly", "per_incident", "annual", "other"] },
      refundable: nullableBool,
      quote: str,
    }),
  },
  lease_start: nullableStr,
  lease_end: nullableStr,
  lease_length_months: nullableNum,
  liability_type: { type: "string", enum: ["joint_and_several", "individual", "unclear"] },
  key_clauses: {
    type: "array",
    items: obj({
      category: { type: "string", enum: [...CLAUSE_CATEGORIES] },
      title: str,
      summary: str,
      quote: str,
    }),
  },
  missing_or_unclear: { type: "array", items: str },
});

export const riskSchema = obj({
  overall_risk: { type: "string", enum: ["low", "medium", "high"] },
  risk_score: { type: "integer" },
  flags: {
    type: "array",
    items: obj({
      severity: { type: "string", enum: ["low", "medium", "high"] },
      category: { type: "string", enum: [...CLAUSE_CATEGORIES, "occupancy_boulder"] },
      title: str,
      explanation: str,
      quote: str,
      legal_note: str,
    }),
  },
  occupancy: obj({
    tenants_on_lease: nullableInt,
    bedrooms: nullableInt,
    concern_level: { type: "string", enum: ["none", "low", "medium", "high"] },
    notes: str,
  }),
  rationale: str,
});

export const triageSchema = obj({
  attorney_review_needed: { type: "boolean" },
  urgency: { type: "string", enum: ["routine", "soon", "urgent"] },
  triage_reason: str,
  plain_language_summary: str,
  key_numbers: { type: "array", items: obj({ label: str, value: str }) },
  questions_for_landlord: { type: "array", items: str },
  next_steps: { type: "array", items: str },
});

// TypeScript shapes matching the schemas above.
export type Risk = "low" | "medium" | "high";

export interface Extraction {
  property_address: string | null;
  landlord_or_manager: string | null;
  tenant_names: string[];
  number_of_tenants: number | null;
  bedrooms: number | null;
  monthly_rent_total: number | null;
  rent_per_tenant: number | null;
  rent_due: string | null;
  security_deposit: number | null;
  deposit_refundable: boolean | null;
  fees: { name: string; amount: number | null; frequency: string; refundable: boolean | null; quote: string }[];
  lease_start: string | null;
  lease_end: string | null;
  lease_length_months: number | null;
  liability_type: "joint_and_several" | "individual" | "unclear";
  key_clauses: { category: string; title: string; summary: string; quote: string }[];
  missing_or_unclear: string[];
}

export interface RiskAssessment {
  overall_risk: Risk;
  risk_score: number;
  flags: { severity: Risk; category: string; title: string; explanation: string; quote: string; legal_note: string }[];
  occupancy: { tenants_on_lease: number | null; bedrooms: number | null; concern_level: "none" | Risk; notes: string };
  rationale: string;
}

export interface Triage {
  attorney_review_needed: boolean;
  urgency: "routine" | "soon" | "urgent";
  triage_reason: string;
  plain_language_summary: string;
  key_numbers: { label: string; value: string }[];
  questions_for_landlord: string[];
  next_steps: string[];
}
