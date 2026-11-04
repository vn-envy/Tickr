import type { Vertical } from "../schemas/common";

export interface VerticalPlaybook {
  id: Vertical;
  label: string;
  researchQuestions: readonly string[];
  ownerConfirmations: readonly string[];
  creativeGuidance: readonly string[];
  qualityRules: readonly string[];
  suggestedAction: string;
}

export const GENERIC_BUSINESS_PLAYBOOK: VerticalPlaybook = {
  id: "business",
  label: "Business",
  researchQuestions: [
    "Which products, services or experiences does this specific business actually provide, and for which customer needs?",
    "Which credible, recent business or customer signals explain an opportunity worth testing?",
    "Which claims apply to this exact branch, location or service area rather than another business or outlet?",
    "What evidence distinguishes this business in the inspected comparison set, and what remains unknown?",
  ],
  ownerConfirmations: ["Confirm current availability, commercial terms and operating capacity before publication", "Confirm the intended branch, destination and rights to use imagery"],
  creativeGuidance: ["Connect one evidenced customer need to a specific supported offering or business story", "Use authentic business assets when available and label proposed visual interpretations"],
  qualityRules: ["Do not invent products, guarantees, comparative superiority or customer results", "Keep branch-specific and time-sensitive claims within their evidenced scope", "Identify relevant professional, health, financial or other category-specific advertising constraints before distribution"],
  suggestedAction: "Ask about the evidenced offering through a confirmed business contact or destination",
};

/** Shared workflow inputs, not prewritten opportunities or jurisdictional approval. */
export const VERTICAL_PLAYBOOKS = {
  bakery: {
    id: "bakery",
    label: "Café / bakery",
    researchQuestions: ["Which actual products do customers mention?", "What ordering, pickup or occasion needs are supported by evidence?"],
    ownerConfirmations: ["Confirm featured products, prices and availability", "Approve any proposed offer or discount"],
    creativeGuidance: ["Preserve the real product photo", "Use a clear product → offer → action sequence"],
    qualityRules: ["Do not invent ingredients or allergen guarantees", "Check exact prices and offer terms"],
    suggestedAction: "Inquire about a featured product or pickup",
  },
  dentist: {
    id: "dentist",
    label: "Dentist",
    researchQuestions: ["Which service or appointment questions remain unanswered?", "Which credentials and services have attributable support?"],
    ownerConfirmations: ["Confirm services, credentials and appointment process", "Identify jurisdiction-specific review before distribution"],
    creativeGuidance: ["Use authentic clinic imagery and informational layouts", "Do not fabricate patients or treatment results"],
    qualityRules: ["No unsupported outcome guarantees or testimonials", "Respect patient privacy and require appropriate photo permission"],
    suggestedAction: "Ask about a consultation",
  },
  gym: {
    id: "gym",
    label: "Gym",
    researchQuestions: ["What coaching, classes and beginner support are evidenced?", "Which membership or trial terms need clarification?"],
    ownerConfirmations: ["Confirm programs, staff and trial capacity", "Approve membership prices and trial conditions"],
    creativeGuidance: ["Show the actual facilities and coaching", "Explain the program without inventing body transformations"],
    qualityRules: ["No unrealistic health or weight-loss promises", "Do not imply knowledge of a viewer's health or appearance"],
    suggestedAction: "Inquire about a trial session",
  },
  salon: {
    id: "salon",
    label: "Salon",
    researchQuestions: ["Which signature services have genuine portfolio evidence?", "What booking questions or occasion needs are supported?"],
    ownerConfirmations: ["Confirm services, prices and availability", "Confirm permission to use client and portfolio imagery"],
    creativeGuidance: ["Preserve real client appearance and completed work", "Use a portfolio → service → booking sequence"],
    qualityRules: ["Do not invent a haircut or treatment result", "Do not label synthetic imagery as authentic client work"],
    suggestedAction: "Inquire about an appointment",
  },
} as const satisfies Record<Vertical, VerticalPlaybook>;

/** Legacy packs add optional domain prompts; every other category uses the same general engine. */
export function getBusinessPlaybook(category: Vertical): VerticalPlaybook {
  const key = category.trim().toLowerCase();
  if (Object.hasOwn(VERTICAL_PLAYBOOKS, key)) {
    const legacy = VERTICAL_PLAYBOOKS[key as keyof typeof VERTICAL_PLAYBOOKS];
    return {
      ...legacy,
      researchQuestions: [...GENERIC_BUSINESS_PLAYBOOK.researchQuestions, ...legacy.researchQuestions],
      qualityRules: [...GENERIC_BUSINESS_PLAYBOOK.qualityRules, ...legacy.qualityRules],
    };
  }
  return { ...GENERIC_BUSINESS_PLAYBOOK, id: category.trim() || "business", label: category.trim() || "Business" };
}

export const getVerticalPlaybook = getBusinessPlaybook;
