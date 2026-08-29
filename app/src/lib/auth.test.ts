import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Unit tests for app/src/lib/auth.ts.
 *
 * H2: jwt() validates user.login against GitHub's account-name spec.
 * H3: authOptions.secret is process.env.NEXTAUTH_SECRET, not a
 *     next-auth-internal default.
 *
 * next-auth v4's callback parameter types are wide and structural
 * (User | AdapterUser) and not safe to import for test construction.
 * Cast to a minimal structural type at the call site instead.
 */

interface MinimalUser {
  login?: unknown;
}

interface MinimalToken {
  login?: string;
}

// next-auth v4's actual jwt() callback uses exactOptionalPropertyTypes
// (User | AdapterUser is not optional - callers pass undefined
// explicitly). Mirror that here.
type JwtCallback = (args: {
  token: MinimalToken;
  user: MinimalUser | undefined;
}) => MinimalToken | Promise<MinimalToken>;
type SessionCallback = (args: {
  session: { user?: Record<string, unknown> };
  token: MinimalToken;
}) => { user: Record<string, unknown> } | Promise<{ user: Record<string, unknown> }>;

function asJwt(cb: unknown): JwtCallback {
  return cb as JwtCallback;
}

function asSession(cb: unknown): SessionCallback {
  return cb as SessionCallback;
}

describe("authOptions (H2 + H3)", () => {
  const originalSecret = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.NEXTAUTH_SECRET;
    } else {
      process.env.NEXTAUTH_SECRET = originalSecret;
    }
  });

  it("H3: passes NEXTAUTH_SECRET explicitly to next-auth", async () => {
    const { authOptions } = await import("./auth");
    expect(authOptions.secret).toBe("test-secret-do-not-use-in-prod");
  });

  it("H2: jwt() stamps a valid login onto the token", async () => {
    const { authOptions } = await import("./auth");
    const jwt = asJwt(authOptions.callbacks?.jwt);
    const token = await jwt({ token: {}, user: { login: "Mico" } });
    expect(token.login).toBe("Mico");
  });

  it("H2: jwt() leaves token.login undefined for a non-conforming login", async () => {
    const { authOptions } = await import("./auth");
    const jwt = asJwt(authOptions.callbacks?.jwt);
    const token = await jwt({ token: {}, user: { login: "has space" } });
    expect(token.login).toBeUndefined();
  });

  it("H2: jwt() leaves token.login undefined when login is null", async () => {
    const { authOptions } = await import("./auth");
    const jwt = asJwt(authOptions.callbacks?.jwt);
    const token = await jwt({ token: {}, user: { login: null } });
    expect(token.login).toBeUndefined();
  });

  it("H2: jwt() leaves token.login undefined when login is undefined", async () => {
    const { authOptions } = await import("./auth");
    const jwt = asJwt(authOptions.callbacks?.jwt);
    const token = await jwt({ token: {}, user: {} });
    expect(token.login).toBeUndefined();
  });

  it("H2: jwt() leaves an existing token.login untouched when user is absent", async () => {
    const { authOptions } = await import("./auth");
    const jwt = asJwt(authOptions.callbacks?.jwt);
    const token = await jwt({ token: { login: "Mico" }, user: undefined });
    expect(token.login).toBe("Mico");
  });

  it("H2: session() copies a valid token.login into session.user.login", async () => {
    const { authOptions } = await import("./auth");
    const sessionCallback = asSession(authOptions.callbacks?.session);
    const result = await sessionCallback({
      session: { user: {} },
      token: { login: "Mico" },
    });
    expect(result.user.login).toBe("Mico");
  });

  it("H2: session() leaves session.user.login undefined when token.login is absent", async () => {
    const { authOptions } = await import("./auth");
    const sessionCallback = asSession(authOptions.callbacks?.session);
    const result = await sessionCallback({
      session: { user: {} },
      token: {},
    });
    expect(result.user.login).toBeUndefined();
  });
});
