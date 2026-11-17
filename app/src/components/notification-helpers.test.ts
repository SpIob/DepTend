import { describe, it, expect } from "vitest";
import {
  ALLOWED_EVENT_TYPES,
  eventTypeLabel,
  defaultEventTypes,
  isDefaultEventTypes,
  validateEventTypes,
} from "./notification-helpers";

describe("notification-helpers", () => {
  describe("ALLOWED_EVENT_TYPES", () => {
    it("contains exactly four event types in the expected order", () => {
      expect(ALLOWED_EVENT_TYPES).toEqual(["new_mission", "claimed", "resolved", "reopened"]);
    });
  });

  describe("eventTypeLabel", () => {
    it("maps each enum value to its plain-language label exhaustively", () => {
      expect(eventTypeLabel("new_mission")).toBe("New missions found");
      expect(eventTypeLabel("claimed")).toBe("Someone claimed a mission");
      expect(eventTypeLabel("resolved")).toBe("Mission resolved");
      expect(eventTypeLabel("reopened")).toBe("Mission reopened");
    });

    it("has no silent default — TypeScript would error on missing cases", () => {
      // This test exists to document the exhaustive-switch guarantee.
      // If a new value is added to ALLOWED_EVENT_TYPES without a case here,
      // TypeScript will fail to compile.
      const allLabels = ALLOWED_EVENT_TYPES.map(eventTypeLabel);
      expect(allLabels).toHaveLength(4);
      expect(new Set(allLabels).size).toBe(4); // all unique
    });
  });

  describe("defaultEventTypes", () => {
    it("returns all four event types", () => {
      expect(defaultEventTypes()).toEqual(ALLOWED_EVENT_TYPES);
    });

    it("returns a new array each call (not the same reference)", () => {
      expect(defaultEventTypes()).not.toBe(defaultEventTypes());
    });
  });

  describe("isDefaultEventTypes", () => {
    it("returns true for the default set in any order", () => {
      expect(isDefaultEventTypes(["new_mission", "claimed", "resolved", "reopened"])).toBe(true);
      expect(isDefaultEventTypes(["reopened", "resolved", "claimed", "new_mission"])).toBe(true);
    });

    it("returns false for a subset", () => {
      expect(isDefaultEventTypes(["new_mission", "claimed"])).toBe(false);
    });

    it("returns false for an empty array", () => {
      expect(isDefaultEventTypes([])).toBe(false);
    });

    it("returns false when extra types are included", () => {
      expect(isDefaultEventTypes(["new_mission", "claimed", "resolved", "reopened", "extra"])).toBe(
        false,
      );
    });

    it("returns false when a non-allowed type replaces one", () => {
      expect(isDefaultEventTypes(["new_mission", "claimed", "resolved", "custom"])).toBe(false);
    });
  });

  describe("validateEventTypes", () => {
    it("accepts a valid array of allowed types", () => {
      const result = validateEventTypes(["new_mission", "resolved"]);
      expect(result).toEqual(["new_mission", "resolved"]);
    });

    it("accepts all four types", () => {
      const result = validateEventTypes(ALLOWED_EVENT_TYPES);
      expect(result).toEqual(ALLOWED_EVENT_TYPES);
    });

    it("rejects a non-array", () => {
      expect(validateEventTypes("new_mission")).toBeNull();
      expect(validateEventTypes(null)).toBeNull();
      expect(validateEventTypes(undefined)).toBeNull();
      expect(validateEventTypes({})).toBeNull();
    });

    it("rejects an empty array", () => {
      expect(validateEventTypes([])).toBeNull();
    });

    it("rejects an array exceeding the max length", () => {
      expect(
        validateEventTypes(["new_mission", "claimed", "resolved", "reopened", "extra"]),
      ).toBeNull();
    });

    it("rejects an array with non-string entries", () => {
      expect(validateEventTypes(["new_mission", 42])).toBeNull();
      expect(validateEventTypes([null, "claimed"])).toBeNull();
    });

    it("rejects an array with disallowed string values", () => {
      expect(validateEventTypes(["new_mission", "xss-payload"])).toBeNull();
      expect(validateEventTypes(["custom_event"])).toBeNull();
    });
  });
});
