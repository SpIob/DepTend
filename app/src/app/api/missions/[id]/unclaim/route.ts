import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isValidMissionId, unclaimMission } from "@deptend/core/db/missions.js";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getServerSession(authOptions);
  const login = session?.user?.login;
  if (login === undefined) {
    return NextResponse.json(
      { error: "Sign in with GitHub to unclaim a mission." },
      { status: 401 },
    );
  }

  const { id } = await params;
  if (!isValidMissionId(id)) {
    return NextResponse.json({ error: "Invalid mission id." }, { status: 400 });
  }

  const outcome = await unclaimMission(getDb(), id, login);

  if (outcome === "not_found") {
    return NextResponse.json({ error: "Mission not found." }, { status: 404 });
  }

  if (outcome === "not_claimed_by_you") {
    return NextResponse.json(
      { error: "This mission isn't currently claimed by you." },
      { status: 409 },
    );
  }

  return NextResponse.json({ message: "Unclaimed.", status: "open" }, { status: 200 });
}
