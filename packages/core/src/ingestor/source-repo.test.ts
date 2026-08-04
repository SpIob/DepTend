/**
 * source-repo.ts unit tests
 *
 * Pure functions, no mocking needed. Covers every input shape actually
 * seen across npm's `repository` field, PyPI's project_urls values, and a
 * raw Go module path, plus the "doesn't resolve" cases that must stay
 * null rather than guess.
 */

import { describe, expect, it } from "vitest";
import { parseNpmRepositoryField, parseSourceRepo } from "./source-repo.js";

describe("parseSourceRepo", () => {
  describe("null / empty input", () => {
    it("returns null for null", () => {
      expect(parseSourceRepo(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(parseSourceRepo(undefined)).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(parseSourceRepo("")).toBeNull();
    });

    it("returns null for a whitespace-only string", () => {
      expect(parseSourceRepo("   ")).toBeNull();
    });
  });

  describe("github: shorthand", () => {
    it("parses github:owner/repo", () => {
      expect(parseSourceRepo("github:facebook/react")).toEqual({
        owner: "facebook",
        name: "react",
      });
    });

    it("parses github:owner/repo with a trailing slash", () => {
      expect(parseSourceRepo("github:facebook/react/")).toEqual({
        owner: "facebook",
        name: "react",
      });
    });
  });

  describe("full URL forms", () => {
    it("parses git+https:// with a .git suffix", () => {
      expect(parseSourceRepo("git+https://github.com/lodash/lodash.git")).toEqual({
        owner: "lodash",
        name: "lodash",
      });
    });

    it("parses git:// without a .git suffix", () => {
      expect(parseSourceRepo("git://github.com/facebook/react.git")).toEqual({
        owner: "facebook",
        name: "react",
      });
    });

    it("parses a plain https:// URL with no .git suffix", () => {
      expect(parseSourceRepo("https://github.com/vuejs/vue")).toEqual({
        owner: "vuejs",
        name: "vue",
      });
    });

    it("parses a plain https:// URL with a trailing slash", () => {
      expect(parseSourceRepo("https://github.com/vuejs/vue/")).toEqual({
        owner: "vuejs",
        name: "vue",
      });
    });

    it("parses git+ssh:// with a user@host authority", () => {
      expect(parseSourceRepo("git+ssh://git@github.com/owner/repo.git")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("is case-insensitive on the host", () => {
      expect(parseSourceRepo("https://WWW.GITHUB.COM/owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });
  });

  describe("raw Go module paths (no scheme)", () => {
    it("parses a bare github.com module path", () => {
      expect(parseSourceRepo("github.com/gorilla/mux")).toEqual({
        owner: "gorilla",
        name: "mux",
      });
    });

    it("drops extra path segments (major-version suffix)", () => {
      expect(parseSourceRepo("github.com/owner/repo/v2")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("drops extra path segments (subpackage path)", () => {
      expect(parseSourceRepo("github.com/Azure/azure-sdk-for-go/sdk/storage")).toEqual({
        owner: "Azure",
        name: "azure-sdk-for-go",
      });
    });
  });

  describe("fragment / query stripping", () => {
    it("strips a ?query on a full URL", () => {
      expect(parseSourceRepo("https://github.com/owner/repo?tab=readme")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });
  });

  describe("non-GitHub / unresolvable — must return null, not guess", () => {
    it("returns null for a GitLab URL", () => {
      expect(parseSourceRepo("https://gitlab.com/owner/repo.git")).toBeNull();
    });

    it("returns null for a Bitbucket URL", () => {
      expect(parseSourceRepo("https://bitbucket.org/owner/repo")).toBeNull();
    });

    it("returns null for a non-GitHub Go module path", () => {
      expect(parseSourceRepo("golang.org/x/mod")).toBeNull();
    });

    it("returns null for a gopkg.in module path", () => {
      // Regression case: this has the identical one-slash shape as npm's
      // "owner/repo" bare shorthand ("gopkg.in" / "yaml.v3") — must not
      // be misparsed as {owner: "gopkg.in", name: "yaml.v3"}.
      expect(parseSourceRepo("gopkg.in/yaml.v3")).toBeNull();
    });

    it("does not support bare owner/repo shorthand directly (npm-field-only)", () => {
      expect(parseSourceRepo("lodash/lodash")).toBeNull();
    });

    it("returns null for a homepage with no repo path at all", () => {
      expect(parseSourceRepo("https://github.com")).toBeNull();
    });

    it("returns null for SSH shorthand (unsupported form)", () => {
      expect(parseSourceRepo("git@github.com:owner/repo.git")).toBeNull();
    });

    it("returns null for a malformed URL", () => {
      expect(parseSourceRepo("https://[not-a-valid-host")).toBeNull();
    });
  });
});

describe("parseNpmRepositoryField", () => {
  it("parses a bare owner/repo shorthand string", () => {
    expect(parseNpmRepositoryField("lodash/lodash")).toEqual({ owner: "lodash", name: "lodash" });
  });

  it("parses a bare shorthand repo name containing a dot", () => {
    expect(parseNpmRepositoryField("socketio/socket.io")).toEqual({
      owner: "socketio",
      name: "socket.io",
    });
  });

  it("strips a #branch fragment off a bare shorthand string", () => {
    expect(parseNpmRepositoryField("owner/repo#some-branch")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses a plain string field", () => {
    expect(parseNpmRepositoryField("lodash/lodash")).toEqual({ owner: "lodash", name: "lodash" });
  });

  it("parses a {type, url} object field", () => {
    expect(
      parseNpmRepositoryField({ type: "git", url: "git+https://github.com/facebook/react.git" }),
    ).toEqual({ owner: "facebook", name: "react" });
  });

  it("returns null when the object has no url property", () => {
    expect(parseNpmRepositoryField({ type: "git" })).toBeNull();
  });

  it("returns null when url is not a string", () => {
    expect(parseNpmRepositoryField({ type: "git", url: 123 })).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseNpmRepositoryField(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseNpmRepositoryField(null)).toBeNull();
  });

  it("returns null for an unrelated type (number)", () => {
    expect(parseNpmRepositoryField(42)).toBeNull();
  });
});
