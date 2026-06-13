// functions/game-room.ts — one Durable Object instance per Phone Snatcher room.
//
// The room is authoritative for: lobby membership + host, secret role
// assignment, the round timer, strikes, the shared phone-heist score, who has
// been apprehended, world entities (supply crates, bear traps, decoys), and
// the win/lose decision. Clients only ever learn their OWN role; the deception
// is preserved by never broadcasting roles. Reveal/track power-ups send
// targeted "intel" messages to the single player who used them.

import { DurableObject } from "cloudflare:workers";

type Env = {
  DO: Fetcher;
};

type Role = "cop" | "snatcher";
type Status = "lobby" | "playing" | "gameover";
type Winner = "cop" | "snatchers" | null;
type PowerKind = "track_cop" | "speed" | "invisible" | "decoy" | "reveal" | "trap";

const ROUND_TIME = 240;
const PHONE_TARGET = 5;
const MAX_STRIKES = 3;
const HALF_X = 44;
const HALF_Z = 80;
const COP_CATCH_RANGE = 3.2;
const SNATCH_MS = 3000; // hold-E duration for a successful snatch
const TRAP_RANGE = 1.5;
const TICK_MS = 66; // ~15 Hz authoritative broadcast
const MAX_PLAYERS = 6;
const CROWD_COUNT = 18;

const SNATCHER_POWERS: PowerKind[] = ["track_cop", "speed", "invisible", "decoy"];
const COP_POWERS: PowerKind[] = ["reveal", "speed", "trap"];

interface Player {
  id: string;
  name: string;
  role: Role | null;
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
  phones: number;
  invisibleUntil: number;
  frozenUntil: number;
  snatching: boolean;
  snatchUntil: number;
}

interface Crate {
  id: string;
  x: number;
  z: number;
}

interface Trap {
  id: string;
  x: number;
  z: number;
}

interface Decoy {
  id: string;
  x: number;
  z: number;
  until: number;
}

interface Attachment {
  playerId: string;
  name: string;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function spawnPoint(): { x: number; z: number } {
  return { x: rand(-HALF_X + 6, HALF_X - 6), z: rand(-HALF_Z + 6, HALF_Z - 6) };
}

export class GameRoom extends DurableObject<Env> {
  private players = new Map<string, Player>();
  private hostId: string | null = null;
  private status: Status = "lobby";
  private timeLeft = ROUND_TIME;
  private strikes = 0;
  private teamPhones = 0;
  private winner: Winner = null;
  private crowdSeed = Math.floor(Math.random() * 1e9);
  private crates: Crate[] = [];
  private traps: Trap[] = [];
  private decoys: Decoy[] = [];
  private spawnAt = 0;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private lastReport = 0;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId");
    if (!playerId) return new Response("missing playerId", { status: 400 });
    const name = (url.searchParams.get("name") ?? "Player").slice(0, 16);

    if (this.players.size >= MAX_PLAYERS && !this.players.has(playerId)) {
      return new Response("room full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId, name } satisfies Attachment);

    // (Re)register the player. Joining mid-match makes you a spectator until
    // the next round.
    const existing = this.players.get(playerId);
    if (existing) {
      existing.name = name;
    } else {
      const sp = spawnPoint();
      this.players.set(playerId, {
        id: playerId,
        name,
        role: null,
        x: sp.x,
        z: sp.z,
        yaw: 0,
        alive: true,
        phones: 0,
        invisibleUntil: 0,
        frozenUntil: 0,
        snatching: false,
        snatchUntil: 0,
      });
    }
    if (!this.hostId) this.hostId = playerId;

    server.send(
      JSON.stringify({
        t: "welcome",
        you: playerId,
        crowdSeed: this.crowdSeed,
        phoneTarget: PHONE_TARGET,
        maxStrikes: MAX_STRIKES,
      }),
    );
    // If a round is in progress, immediately tell the (re)joining player their
    // role so a reconnect doesn't desync.
    const me = this.players.get(playerId);
    if (this.status !== "lobby" && me?.role) {
      server.send(JSON.stringify({ t: "role", role: me.role }));
    }

    this.broadcastLobby();
    this.ensureTick();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const me = this.players.get(att.playerId);
    if (!me) return;

    let msg: { t?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case "pos": {
        if (this.status !== "playing" || !me.alive) return;
        if (Date.now() < me.frozenUntil) return;
        if (typeof msg.x === "number") me.x = clamp(msg.x, -HALF_X, HALF_X);
        if (typeof msg.z === "number") me.z = clamp(msg.z, -HALF_Z, HALF_Z);
        if (typeof msg.yaw === "number") me.yaw = msg.yaw;
        return;
      }
      case "start": {
        if (att.playerId !== this.hostId) return;
        if (this.players.size < 2) return;
        this.startRound();
        return;
      }
      case "snatchStart": {
        if (this.status !== "playing" || me.role !== "snatcher" || !me.alive) return;
        if (Date.now() < me.frozenUntil) return;
        me.snatching = true;
        me.snatchUntil = Date.now() + SNATCH_MS;
        return;
      }
      case "snatchStop": {
        me.snatching = false;
        return;
      }
      case "apprehend": {
        if (this.status !== "playing" || me.role !== "cop" || !me.alive) return;
        this.handleApprehend(me, typeof msg.targetId === "string" ? msg.targetId : null);
        return;
      }
      case "pickup": {
        if (this.status !== "playing" || !me.alive) return;
        this.handlePickup(ws, me, typeof msg.crateId === "string" ? msg.crateId : "");
        return;
      }
      case "use": {
        if (this.status !== "playing" || !me.alive) return;
        this.handleUse(ws, me, msg.kind as PowerKind);
        return;
      }
      default:
        return;
    }
  }

  override webSocketClose(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att) {
      this.players.delete(att.playerId);
      if (this.hostId === att.playerId) {
        this.hostId = this.players.keys().next().value ?? null;
      }
    }
    this.broadcastLobby();
    if (this.ctx.getWebSockets().length === 0) {
      this.stopTick();
      // reset so an emptied room starts clean if reused
      this.status = "lobby";
      this.players.clear();
      this.hostId = null;
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  /* ----------------------------- round flow ----------------------------- */

  private startRound(): void {
    const ids = [...this.players.keys()];
    const copId = ids[Math.floor(Math.random() * ids.length)]!;
    for (const [id, p] of this.players) {
      p.role = id === copId ? "cop" : "snatcher";
      p.alive = true;
      p.phones = 0;
      p.invisibleUntil = 0;
      p.frozenUntil = 0;
      p.snatching = false;
      p.snatchUntil = 0;
      const sp = spawnPoint();
      p.x = sp.x;
      p.z = sp.z;
      p.yaw = 0;
    }
    this.status = "playing";
    this.timeLeft = ROUND_TIME;
    this.strikes = 0;
    this.teamPhones = 0;
    this.winner = null;
    this.crates = [];
    this.traps = [];
    this.decoys = [];
    this.spawnAt = Date.now() + 5000;

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      const role = att ? this.players.get(att.playerId)?.role : null;
      if (role) ws.send(JSON.stringify({ t: "role", role }));
    }
    this.ensureTick();
  }

  private snatchersTotal(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.role === "snatcher") n += 1;
    return n;
  }

  private snatchersLeft(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.role === "snatcher" && p.alive) n += 1;
    return n;
  }

  private handleApprehend(cop: Player, targetId: string | null): void {
    if (targetId) {
      const target = this.players.get(targetId);
      const dist =
        target && Math.hypot(target.x - cop.x, target.z - cop.z) <= COP_CATCH_RANGE;
      if (target && target.role === "snatcher" && target.alive && dist) {
        target.alive = false;
        this.event(`${cop.name} apprehended ${target.name}!`);
        this.broadcastSfx("apprehend");
        this.sendTo(targetId, { t: "caught" });
        return;
      }
    }
    // wrong call — civilian or out of range
    this.strikes += 1;
    this.event(`${cop.name} grabbed an innocent! ${MAX_STRIKES - this.strikes} left`);
  }

  private handlePickup(ws: WebSocket, me: Player, crateId: string): void {
    const idx = this.crates.findIndex((c) => c.id === crateId);
    if (idx < 0) return;
    const crate = this.crates[idx]!;
    if (Math.hypot(crate.x - me.x, crate.z - me.z) > 2.5) return;
    this.crates.splice(idx, 1);
    const pool = me.role === "cop" ? COP_POWERS : SNATCHER_POWERS;
    const kind = pool[Math.floor(Math.random() * pool.length)]!;
    ws.send(JSON.stringify({ t: "grant", kind }));
  }

  private handleUse(ws: WebSocket, me: Player, kind: PowerKind): void {
    // Synced power-up sound so every player hears it, not just the user.
    this.broadcastSfx("powerup_use");
    switch (kind) {
      case "invisible":
        me.invisibleUntil = Date.now() + 5000;
        break;
      case "reveal": {
        if (me.role !== "cop") return;
        const now = Date.now();
        const ids = [...this.players.values()]
          .filter((p) => p.role === "snatcher" && p.alive && p.invisibleUntil < now)
          .map((p) => p.id);
        ws.send(JSON.stringify({ t: "intel", kind: "reveal", ids, until: now + 3000 }));
        break;
      }
      case "track_cop": {
        if (me.role !== "snatcher") return;
        const cop = [...this.players.values()].find((p) => p.role === "cop");
        if (cop) {
          ws.send(
            JSON.stringify({ t: "intel", kind: "track", id: cop.id, until: Date.now() + 30000 }),
          );
        }
        break;
      }
      case "trap": {
        if (me.role !== "cop") return;
        this.traps.push({ id: crypto.randomUUID(), x: me.x, z: me.z });
        break;
      }
      case "decoy": {
        const fx = me.x - Math.sin(me.yaw) * 8;
        const fz = me.z - Math.cos(me.yaw) * 8;
        this.decoys.push({
          id: crypto.randomUUID(),
          x: clamp(fx, -HALF_X, HALF_X),
          z: clamp(fz, -HALF_Z, HALF_Z),
          until: Date.now() + 8000,
        });
        break;
      }
      case "speed":
        // purely local effect
        break;
    }
  }

  /* ----------------------------- tick loop ----------------------------- */

  private ensureTick(): void {
    if (this.tickHandle !== null) return;
    if (this.ctx.getWebSockets().length === 0) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private tick(): void {
    if (this.ctx.getWebSockets().length === 0) {
      this.stopTick();
      return;
    }

    if (this.status === "playing") {
      const now = Date.now();
      this.timeLeft -= TICK_MS / 1000;

      // supply drops
      if (now >= this.spawnAt && this.crates.length < 3) {
        const sp = spawnPoint();
        this.crates.push({ id: crypto.randomUUID(), x: sp.x, z: sp.z });
        this.spawnAt = now + rand(11000, 17000) * 1;
      }

      // expire decoys
      this.decoys = this.decoys.filter((d) => d.until > now);

      // complete held snatches (credit one phone per 3s hold)
      for (const p of this.players.values()) {
        if (!p.snatching) continue;
        if (!p.alive || p.role !== "snatcher") {
          p.snatching = false;
          continue;
        }
        if (now >= p.snatchUntil) {
          p.phones += 1;
          this.teamPhones += 1;
          p.snatching = false;
          this.event(`${p.name} snatched a phone`);
          // Synced scream so every client (cop included) hears the victim.
          this.broadcastSfx(Math.random() < 0.5 ? "scream_male" : "scream_female");
        }
      }

      // bear traps freeze snatchers
      for (const trap of [...this.traps]) {
        for (const p of this.players.values()) {
          if (p.role !== "snatcher" || !p.alive) continue;
          if (Math.hypot(trap.x - p.x, trap.z - p.z) <= TRAP_RANGE) {
            p.frozenUntil = now + 3000;
            this.traps = this.traps.filter((t) => t.id !== trap.id);
            this.sendTo(p.id, { t: "frozen", until: p.frozenUntil });
            this.event(`${p.name} stepped in a bear trap!`);
            break;
          }
        }
      }

      this.evaluateWin();
    }

    this.broadcastState();

    // periodic directory refresh while alive
    const now = Date.now();
    if (now - this.lastReport > 20000) {
      this.lastReport = now;
      this.reportToDirectory();
    }
  }

  private evaluateWin(): void {
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.endGame(this.snatchersLeft() > 0 ? "snatchers" : "cop");
      return;
    }
    if (this.strikes >= MAX_STRIKES) return this.endGame("snatchers");
    if (this.teamPhones >= PHONE_TARGET) return this.endGame("snatchers");
    if (this.snatchersTotal() > 0 && this.snatchersLeft() === 0) return this.endGame("cop");
  }

  private endGame(winner: Winner): void {
    this.winner = winner;
    this.status = "gameover";
    this.reportToDirectory();
  }

  /* ----------------------------- broadcast ----------------------------- */

  private broadcastState(): void {
    const now = Date.now();
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      x: round(p.x),
      z: round(p.z),
      yaw: round(p.yaw),
      alive: p.alive,
      // The cop is meant to be identifiable; only the cop's role is revealed.
      // Snatchers stay hidden among civilians, preserving the deception.
      isCop: p.role === "cop",
      // Broadcast so every client can play the snatch animation and the cop can
      // see an arrow hint pointing at the in-progress theft.
      snatching: p.snatching,
      // Vanish power-up: while active, every other client hides this avatar.
      invisible: now < p.invisibleUntil,
    }));
    const msg = JSON.stringify({
      t: "state",
      status: this.status,
      timeLeft: Math.ceil(this.timeLeft),
      strikes: this.strikes,
      teamPhones: this.teamPhones,
      phoneTarget: PHONE_TARGET,
      snatchersTotal: this.snatchersTotal(),
      snatchersLeft: this.snatchersLeft(),
      winner: this.winner,
      players,
      crates: this.crates,
      traps: this.traps,
      decoys: this.decoys.map((d) => ({ id: d.id, x: d.x, z: d.z })),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // socket mid-close
      }
    }
    void now;
  }

  private broadcastLobby(): void {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === this.hostId,
    }));
    const msg = JSON.stringify({
      t: "lobby",
      hostId: this.hostId,
      status: this.status,
      players,
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
    this.reportToDirectory();
  }

  /** Broadcast a one-shot sound effect to every client so events are heard
   *  identically by the cop and all snatchers. */
  private broadcastSfx(name: string): void {
    const msg = JSON.stringify({ t: "sfx", name });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }

  private event(message: string): void {
    const msg = JSON.stringify({ t: "event", message });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }

  private sendTo(playerId: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.playerId === playerId) {
        try {
          ws.send(data);
        } catch {
          // ignore
        }
        return;
      }
    }
  }

  private reportToDirectory(): void {
    const report = {
      roomId: this.ctx.id.name ?? "unknown",
      status: this.status === "lobby" ? "open" : "live",
      playerNames: [...this.players.values()].map((p) => p.name),
      playerCount: this.players.size,
      maxPlayers: MAX_PLAYERS,
    };
    const req = new Request("https://internal/report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rork-DO-Class": "RoomDirectory",
        "X-Rork-DO-Id": "global",
      },
      body: JSON.stringify(report),
    });
    this.ctx.waitUntil(
      this.env.DO.fetch(req).then(
        () => undefined,
        (err: unknown) => console.warn("directory report failed", err),
      ),
    );
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
