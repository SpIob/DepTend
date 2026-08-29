import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInOptions } from "next-auth/react";

const signInMock = vi.fn((_provider: string, _options?: SignInOptions): unknown => undefined);

vi.mock("next-auth/react", () => ({
  signIn: (provider: string, options?: SignInOptions): unknown => signInMock(provider, options),
}));

/**
 * signInWithGitHub reads `window.location.origin` and
 * `window.location.pathname`. vitest runs in node environment
 * (vitest.config.ts), so we install a minimal window.location
 * stub before each test and restore it after. Using
 * vi.stubGlobal keeps the type-checker honest without resorting
 * to (window as ...).
 */
function setLocation({
  origin,
  pathname,
  href,
}: {
  origin: string;
  pathname: string;
  href: string;
}): void {
  vi.stubGlobal("window", {
    location: { origin, pathname, href },
  });
}

describe("signInWithGitHub", () => {
  beforeEach(() => {
    signInMock.mockReset();
    setLocation({
      origin: "https://deptend.vercel.app",
      pathname: "/missions",
      href: "https://deptend.vercel.app/missions",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls next-auth signIn with the github provider and a pinned callbackUrl", async () => {
    const { signInWithGitHub } = await import("./sign-in");
    await signInWithGitHub();
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith("github", {
      callbackUrl: "https://deptend.vercel.app/missions",
    });
  });
  it("pins to origin + pathname (not the full href) so query state is dropped", async () => {
    setLocation({
      origin: "https://deptend.vercel.app",
      pathname: "/repo/owner/name",
      href: "https://deptend.vercel.app/repo/owner/name?severity=critical",
    });
    const { signInWithGitHub } = await import("./sign-in");
    await signInWithGitHub();
    expect(signInMock).toHaveBeenCalledWith("github", {
      callbackUrl: "https://deptend.vercel.app/repo/owner/name",
    });
  });

  it("pins to a deep path on the same origin", async () => {
    setLocation({
      origin: "https://deptend.vercel.app",
      pathname: "/repo/owner/repo-with-dashes",
      href: "https://deptend.vercel.app/repo/owner/repo-with-dashes",
    });
    const { signInWithGitHub } = await import("./sign-in");
    await signInWithGitHub();
    expect(signInMock).toHaveBeenCalledWith("github", {
      callbackUrl: "https://deptend.vercel.app/repo/owner/repo-with-dashes",
    });
  });
});
