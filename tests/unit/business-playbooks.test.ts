import { expect, test } from "vitest";
import { getBusinessPlaybook } from "../../lib/verticals";

test("an unseen business category receives evidence and customer-action guidance without inheriting another industry's products", () => {
  const playbook = getBusinessPlaybook("Scientific equipment rental");
  expect(playbook.id).toBe("Scientific equipment rental");
  expect(playbook.label).toBe("Scientific equipment rental");
  expect(playbook.researchQuestions.join(" ")).toContain("actually provide");
  expect(playbook.qualityRules.join(" ")).toContain("branch");
  expect(JSON.stringify(playbook)).not.toMatch(/sourdough|dentistry|haircut/i);
  expect(getBusinessPlaybook("toString").id).toBe("toString");
});

test("optional legacy guidance retains the generic evidence boundaries", () => {
  const playbook = getBusinessPlaybook("bakery");
  expect(playbook.researchQuestions.length).toBeGreaterThan(getBusinessPlaybook("business").researchQuestions.length);
  expect(playbook.qualityRules.join(" ")).toContain("branch");
});
