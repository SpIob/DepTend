import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { claimMission, isValidMissionId } from "@deptend/core/db/missions.js";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getServerSession(authOptions);
  const login = session?.user?.login;
  if (login === undefined) {
    return NextResponse.json({ error: "Sign in with GitHub to claim a mission." }, { status: 401 });
  }

  const { id } = await params;
  if (!isValidMissionId(id)) {
    return NextResponse.json({ error: "Invalid mission id." }, { status: 400 });
  }

  const outcome = await claimMission(getDb(), id, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "already_claimed") {
    return NextResponse.json({ error: "This mission has already been claimed." }, { status: 409 });
  }

  return NextResponse.json(
    { message: "Claimed.", status: "claimed", claimedBy: login },
    { status: 200 },
  );
}
