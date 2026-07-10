import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";

// NextAuth's own type declarations return `any` for every overload of this
// call (next-auth/next/index.d.ts) — v4 predates the App Router and was
// never given a typed signature for it. Asserting the real shape here
// instead of letting `any` propagate into GET/POST.
type RouteHandler = (
  req: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> },
) => Promise<Response>;

const handler = NextAuth(authOptions) as RouteHandler;

export { handler as GET, handler as POST };
