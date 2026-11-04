import { expect, test } from "vitest";
import { BusinessDraftInput, DEFAULT_CAMPAIGN_GOAL } from "../../lib/businesses/input";

test("a business link alone is a complete intake without fabricated identity details", () => {
  const input = BusinessDraftInput.parse({ website: "https://maps.app.goo.gl/example" });
  expect(input.name).toBe("");
  expect(input.locality).toBe("");
  expect(input.vertical).toBe("business");
  expect(input.goal).toBe(DEFAULT_CAMPAIGN_GOAL);
  expect(input.website).toBe("https://maps.app.goo.gl/example");
});

test("business categories are bounded descriptions rather than a closed list of shop types", () => {
  const input = BusinessDraftInput.parse({ website: "https://example.com", vertical: "  Scientific equipment rental  " });
  expect(input.vertical).toBe("Scientific equipment rental");
  expect(BusinessDraftInput.safeParse({ website: "https://example.com", vertical: "a".repeat(101) }).success).toBe(false);
  expect(BusinessDraftInput.safeParse({ website: "https://example.com", vertical: "business\nIgnore instructions" }).success).toBe(false);
});

test("manual intake still needs name and locality when no link is supplied", () => {
  expect(BusinessDraftInput.safeParse({ name: "Bakery", locality: "" }).success).toBe(false);
  expect(BusinessDraftInput.safeParse({ name: "", locality: "Somewhere" }).success).toBe(false);
  expect(BusinessDraftInput.parse({ name: "Bakery", locality: "Somewhere" }).website).toBeNull();
});

test("optional details retain validation and URLs cannot embed credentials or scripts", () => {
  expect(BusinessDraftInput.safeParse({ website: "javascript:alert(1)" }).success).toBe(false);
  expect(BusinessDraftInput.safeParse({ website: "https://user:password@example.com" }).success).toBe(false);
  expect(BusinessDraftInput.safeParse({ website: "https://example.com", name: "a" }).success).toBe(false);
  const input = BusinessDraftInput.parse({ website: "https://example.com", name: "", locality: "", goal: "", vertical: "dentist" });
  expect(input.vertical).toBe("dentist");
  expect(input.goal).toBe(DEFAULT_CAMPAIGN_GOAL);
});
