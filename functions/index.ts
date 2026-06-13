// functions/index.ts — Phone Snatcher backend entrypoint.
//
// Routes:
//   GET  /rooms              -> list open rooms (server browser)
//   WS   /room/<roomId>      -> join a game room (lobby + match)
//
// All Durable Object dispatch goes through env.DO.fetch(...) with the
// X-Rork-DO-Class / X-Rork-DO-Id headers.

export { GameRoom } from "./game-room";
export { RoomDirectory } from "./room-directory";

type Env = { DO: Fetcher };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/rooms") {
      const res = await dispatchToDo(
        env,
        "RoomDirectory",
        "global",
        new Request("https://internal/rooms", { method: "GET" }),
      );
      return withCors(res);
    }

    const roomMatch = url.pathname.match(/^\/room\/([^/]+)$/);
    if (roomMatch && request.headers.get("Upgrade") === "websocket") {
      const playerId =
        url.searchParams.get("playerId") ??
        request.headers.get("X-Rork-User-Id") ??
        crypto.randomUUID();
      url.searchParams.set("playerId", playerId);
      return dispatchToDo(env, "GameRoom", roomMatch[1]!, new Request(url.toString(), request));
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function dispatchToDo(
  env: Env,
  className: string,
  id: string,
  request: Request,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("X-Rork-DO-Class", className);
  headers.set("X-Rork-DO-Id", id);
  return env.DO.fetch(
    new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: request.redirect,
    }),
  );
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(res.body, { status: res.status, headers });
}
