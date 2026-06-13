// functions/room-directory.ts — singleton directory (id "global") that tracks
// open Phone Snatcher rooms so the join screen can show a server browser.

import { DurableObject } from "cloudflare:workers";

type RoomReport = {
  roomId: string;
  status: "open" | "live";
  playerNames: string[];
  playerCount: number;
  maxPlayers: number;
};

export class RoomDirectory extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        player_names TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        max_players INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/report") {
      const report = (await request.json()) as RoomReport;
      if (report.playerCount === 0) {
        this.ctx.storage.sql.exec("DELETE FROM rooms WHERE room_id = ?", report.roomId);
      } else {
        this.ctx.storage.sql.exec(
          `INSERT INTO rooms (room_id, status, player_names, player_count, max_players, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id) DO UPDATE SET
             status = excluded.status,
             player_names = excluded.player_names,
             player_count = excluded.player_count,
             max_players = excluded.max_players,
             last_seen_at = excluded.last_seen_at`,
          report.roomId,
          report.status,
          JSON.stringify(report.playerNames),
          report.playerCount,
          report.maxPlayers,
          Date.now(),
        );
      }
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/rooms") {
      this.ctx.storage.sql.exec("DELETE FROM rooms WHERE last_seen_at < ?", Date.now() - 60_000);
      const rows = this.ctx.storage.sql
        .exec<{
          room_id: string;
          status: string;
          player_names: string;
          player_count: number;
          max_players: number;
        }>(
          "SELECT room_id, status, player_names, player_count, max_players FROM rooms ORDER BY last_seen_at DESC LIMIT 40",
        )
        .toArray();
      const rooms = rows.map((r) => ({
        roomId: r.room_id,
        status: r.status,
        playerNames: safeParse(r.player_names),
        playerCount: r.player_count,
        maxPlayers: r.max_players,
      }));
      return Response.json({ rooms });
    }

    return new Response("not found", { status: 404 });
  }
}

function safeParse(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
