import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getRepoByOwnerAndName } from "@deptend/core/db/repos.js";
import { getRepoBoardPage } from "@deptend/core/db/board-queries.js";
import { type BoardFilters } from "@deptend/core";

const EMPTY_FILTERS: BoardFilters = {
  q: "",
  severities: [],
  ecosystems: [],
  efforts: [],
  missionTypes: [],
  sort: "priority",
};

/**
 * Escapes a string for safe inclusion in XML/SVG content.
 */
function xmlEscape(str: string): string {
  return str
    .replace(/&/g, "\u0026#38;")
    .replace(/</g, "\u0026#60;")
    .replace(/>/g, "\u0026#62;")
    .replace(/"/g, "\u0026#34;")
    .replace(/'/g, "\u0026#39;");
}

/**
 * Generates a shields.io-style SVG badge.
 * Left cell: "depTend" (static label)
 * Right cell: "N missions · M high" or "clean" when zero open missions.
 */
function generateBadgeSvg(
  owner: string,
  name: string,
  totalMissions: number,
  highMissions: number,
): string {
  const label = "depTend";
  const escapedOwner = xmlEscape(owner);
  const escapedName = xmlEscape(name);

  let message: string;
  if (totalMissions === 0) {
    message = "clean";
  } else {
    const parts = [`${totalMissions} mission${totalMissions === 1 ? "" : "s"}`];
    if (highMissions > 0) {
      parts.push(`${highMissions} high`);
    }
    message = parts.join(" \u00B7 "); // middle dot
  }

  const escapedMessage = xmlEscape(message);

  // Shields.io-style dimensions and styling
  const labelWidth = 54; // "depTend" fits in ~54px
  const messageWidth = Math.max(80, escapedMessage.length * 6.5 + 10); // dynamic width based on message length
  const totalWidth = labelWidth + messageWidth;
  const height = 20;
  const radius = 3;

  // Colors matching shields.io convention
  const labelBg = "#555";
  const messageBg = totalMissions === 0 ? "#4c1" : highMissions > 0 ? "#e05d44" : "#dfb317";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="depTend: ${escapedMessage}">
  <title>depTend: ${escapedMessage} for ${escapedOwner}/${escapedName}</title>
  <rect width="${totalWidth}" height="${height}" rx="${radius}" fill="${labelBg}"/>
  <rect x="${labelWidth}" width="${messageWidth}" height="${height}" rx="${radius}" rx="0" ry="0" fill="${messageBg}"/>
  <rect x="${labelWidth}" width="${messageWidth}" height="${height}" rx="${radius}" fill="${messageBg}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="13">${label}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${escapedMessage}</text>
    <text x="${labelWidth + messageWidth / 2}" y="13">${escapedMessage}</text>
  </g>
</svg>`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; name: string }> },
): Promise<Response> {
  const { owner, name } = await params;

  const repo = await getRepoByOwnerAndName(getDb(), owner, name);
  if (repo === null) {
    return NextResponse.json({ error: "Repo not found." }, { status: 404 });
  }

  // Use existing core read to get mission counts by severity
  const board = await getRepoBoardPage(getDb(), repo.id, EMPTY_FILTERS, { limit: 1000 });
  const totalMissions = board.total;
  const highMissions = board.facets.severity.high ?? 0;

  const svg = generateBadgeSvg(owner, name, totalMissions, highMissions);

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
