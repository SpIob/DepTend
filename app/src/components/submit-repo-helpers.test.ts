import { describe, it, expect } from "vitest";
import {
  SUBMITTER_OPTIN_EVENT_TYPES,
  SUCCESS_MESSAGE_UNCHECKED_SUFFIX,
  SUCCESS_MESSAGE_CHECKED_SUBSCRIBED,
  SUCCESS_MESSAGE_CHECKED_SUBSCRIBE_FAILED,
  decideNotificationAction,
  buildSubmitSuccessMessage,
  buildLocalScanCommand,
} from "./submit-repo-helpers";

describe("submit-repo-helpers", () => {
  describe("SUBMITTER_OPTIN_EVENT_TYPES", () => {
    it("contains only new_mission as specified in issue #44", () => {
      expect(SUBMITTER_OPTIN_EVENT_TYPES).toEqual(["new_mission"]);
    });
  });

  describe("message constants", () => {
    it("has the expected unchecked suffix", () => {
      expect(SUCCESS_MESSAGE_UNCHECKED_SUFFIX).toBe(
        " You can turn on new-mission notifications from the repo page.",
      );
    });

    it("has the expected checked-subscribed suffix", () => {
      expect(SUCCESS_MESSAGE_CHECKED_SUBSCRIBED).toBe(" Subscribed to new-mission notifications.");
    });

    it("has the expected checked-subscribe-failed suffix", () => {
      expect(SUCCESS_MESSAGE_CHECKED_SUBSCRIBE_FAILED).toBe(
        " Submission succeeded; notification signup failed (try again from the repo page).",
      );
    });
  });

  describe("decideNotificationAction", () => {
    it("returns 'subscribe' when opt-in is true", () => {
      expect(decideNotificationAction(true)).toBe("subscribe");
    });

    it("returns 'none' when opt-in is false", () => {
      expect(decideNotificationAction(false)).toBe("none");
    });
  });

  describe("buildSubmitSuccessMessage", () => {
    const baseMessage = "Submitted — ingestion has been triggered.";

    it("appends unchecked suffix when opt-in is false", () => {
      const result = buildSubmitSuccessMessage(baseMessage, false, "success");
      expect(result).toBe(
        "Submitted — ingestion has been triggered. You can turn on new-mission notifications from the repo page.",
      );
    });

    it("appends checked-subscribed suffix when opt-in is true and subscribe succeeds", () => {
      const result = buildSubmitSuccessMessage(baseMessage, true, "success");
      expect(result).toBe(
        "Submitted — ingestion has been triggered. Subscribed to new-mission notifications.",
      );
    });

    it("appends checked-subscribe-failed suffix when opt-in is true and subscribe fails", () => {
      const result = buildSubmitSuccessMessage(baseMessage, true, "failed");
      expect(result).toBe(
        "Submitted — ingestion has been triggered. Submission succeeded; notification signup failed (try again from the repo page).",
      );
    });

    it("appends checked-subscribe-failed suffix when opt-in is true and subscribe returns unauthorized", () => {
      const result = buildSubmitSuccessMessage(baseMessage, true, "unauthorized");
      expect(result).toBe(
        "Submitted — ingestion has been triggered. Submission succeeded; notification signup failed (try again from the repo page).",
      );
    });

    it("never makes the submission report as failed regardless of subscribe result", () => {
      // The key requirement: subscribe failure must never make submission report as failed
      const failedResult = buildSubmitSuccessMessage(baseMessage, true, "failed");
      const unauthorizedResult = buildSubmitSuccessMessage(baseMessage, true, "unauthorized");

      // Both should contain the base success message
      expect(failedResult).toContain(baseMessage);
      expect(unauthorizedResult).toContain(baseMessage);

      // Neither should say the submission failed (only that the signup failed)
      expect(failedResult).not.toContain("submission failed");
      expect(unauthorizedResult).not.toContain("submission failed");
      // Note: "failed" appears in "signup failed" but not as "submission failed"
    });
  });

  describe("buildLocalScanCommand (issue #45 interim)", () => {
    it("returns the prefilled CLI command for a plain repo URL", () => {
      expect(buildLocalScanCommand("https://github.com/owner/repo")).toBe(
        "npx @deptend/cli <local-path> --github-url https://github.com/owner/repo",
      );
    });

    it("strips a trailing slash", () => {
      expect(buildLocalScanCommand("https://github.com/owner/repo/")).toBe(
        "npx @deptend/cli <local-path> --github-url https://github.com/owner/repo",
      );
    });

    it("trims surrounding whitespace", () => {
      expect(buildLocalScanCommand("  https://github.com/owner/repo  ")).toBe(
        "npx @deptend/cli <local-path> --github-url https://github.com/owner/repo",
      );
    });

    it("returns null for partial or non-repo input", () => {
      expect(buildLocalScanCommand("https://github.com/owner")).toBeNull();
      expect(buildLocalScanCommand("https://gitlab.com/owner/repo")).toBeNull();
      expect(buildLocalScanCommand("not a url")).toBeNull();
      expect(buildLocalScanCommand("")).toBeNull();
    });
  });
});
