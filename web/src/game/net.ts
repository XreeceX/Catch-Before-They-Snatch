/**
 * Phone Snatcher netcode client.
 *
 * Wraps the WebSocket connection to a GameRoom Durable Object plus the HTTP
 * call to the RoomDirectory server browser. The engine and UI subscribe to
 * decoded server messages through a single `onMessage` callback.
 */

import type { PowerKind, Role, Winner } from "@/game/engine";
import type { SfxName } from "@/game/audio";

const BASE = (import.meta.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL as string | undefined) ?? "";

export interface RoomSummary {
  roomId: string;
  status: "open" | "live";
  playerNames: string[];
  playerCount: number;
  maxPlayers: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
}

export interface NetPlayer {
  id: string;
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
  isCop: boolean;
  snatching: boolean;
  invisible: boolean;
}

export type ServerMessage =
  | { t: "welcome"; you: string; crowdSeed: number; phoneTarget: number; maxStrikes: number }
  | { t: "lobby"; hostId: string | null; status: "lobby" | "playing" | "gameover"; players: LobbyPlayer[] }
  | { t: "role"; role: Role; x: number; z: number; yaw: number }
  | {
      t: "state";
      status: "lobby" | "playing" | "gameover";
      timeLeft: number;
      strikes: number;
      teamPhones: number;
      phoneTarget: number;
      snatchersTotal: number;
      snatchersLeft: number;
      winner: Winner;
      players: NetPlayer[];
      crates: { id: string; x: number; z: number }[];
      traps: { id: string; x: number; z: number }[];
      smokes: { id: string; x: number; z: number }[];
    }
  | { t: "intel"; kind: "reveal"; ids: string[]; until: number }
  | { t: "intel"; kind: "track"; id: string; until: number }
  | { t: "event"; message: string }
  | { t: "sfx"; name: SfxName }
  | { t: "grant"; kind: PowerKind }
  | { t: "frozen"; until: number }
  | { t: "caught" };

function httpBase(): string {
  return BASE.replace(/\/$/, "");
}

function wsBase(): string {
  return httpBase().replace(/^http/, "ws");
}

// Unambiguous alphabet (no 0/O/1/I) for human-shareable codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

/**
 * Generate a short, friendly, uppercase room code that is easy to read aloud
 * and type. The same canonical (uppercase) form is used everywhere — as the
 * Durable Object id, the displayed code, and the value typed by joiners — so
 * there is never a casing mismatch between host and joiner.
 */
export function makeRoomId(): string {
  const bytes = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/** Canonicalise a typed/pasted room code: strip junk, uppercase, clamp length. */
export function normalizeRoomId(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

/** Stable per-browser player id so reconnects keep their slot. */
export function getPlayerId(): string {
  const key = "ps_player_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export async function fetchRooms(): Promise<RoomSummary[]> {
  try {
    const res = await fetch(`${httpBase()}/rooms`, { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as { rooms?: RoomSummary[] };
    return data.rooms ?? [];
  } catch {
    return [];
  }
}

export type ConnState = "connecting" | "open" | "closed";

export class NetClient {
  private ws: WebSocket | null = null;
  private readonly roomId: string;
  private readonly playerId: string;
  private readonly name: string;
  private onMessage: (msg: ServerMessage) => void;
  private onState: (s: ConnState) => void;
  private closedByUs = false;

  constructor(
    roomId: string,
    name: string,
    onMessage: (msg: ServerMessage) => void,
    onState: (s: ConnState) => void,
  ) {
    this.roomId = roomId;
    this.name = name;
    this.playerId = getPlayerId();
    this.onMessage = onMessage;
    this.onState = onState;
  }

  get id(): string {
    return this.playerId;
  }

  connect(): void {
    this.closedByUs = false;
    this.onState("connecting");
    const url = `${wsBase()}/room/${encodeURIComponent(this.roomId)}?playerId=${encodeURIComponent(
      this.playerId,
    )}&name=${encodeURIComponent(this.name)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = (): void => this.onState("open");
    ws.onclose = (): void => {
      this.onState("closed");
      if (!this.closedByUs) {
        // brief auto-reconnect to ride out transient drops
        setTimeout(() => {
          if (!this.closedByUs) this.connect();
        }, 1500);
      }
    };
    ws.onerror = (): void => this.onState("closed");
    ws.onmessage = (ev: MessageEvent): void => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        this.onMessage(msg);
      } catch {
        // ignore malformed frames
      }
    };
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendPos(x: number, z: number, yaw: number): void {
    this.send({ t: "pos", x, z, yaw });
  }

  start(): void {
    this.send({ t: "start" });
  }

  snatchStart(): void {
    this.send({ t: "snatchStart" });
  }

  snatchStop(): void {
    this.send({ t: "snatchStop" });
  }

  apprehend(targetId: string | null): void {
    this.send({ t: "apprehend", targetId });
  }

  pickup(crateId: string): void {
    this.send({ t: "pickup", crateId });
  }

  use(kind: PowerKind): void {
    this.send({ t: "use", kind });
  }

  disconnect(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}
