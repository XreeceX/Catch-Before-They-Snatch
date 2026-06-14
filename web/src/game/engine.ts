import * as THREE from "three";
import { CharacterModels, CharacterInstance, CharKind } from "./characters";
import { PropModels, type PropKind } from "./props";
import { AudioManager, type SfxName } from "./audio";

/* ------------------------------------------------------------------ *
 *  Phone Snatcher — 3D engine
 *  A single-device build of the social-deception street game. The
 *  player is randomly assigned Cop or Snatcher; AI fills every other
 *  role and a living crowd of civilians fills the London street.
 * ------------------------------------------------------------------ */

export type Role = "cop" | "snatcher";
export type GameStatus = "lobby" | "reveal" | "playing" | "gameover";
export type Winner = "cop" | "snatchers" | null;

export type PowerKind =
  | "track_cop"
  | "speed"
  | "invisible"
  | "smoke"
  | "reveal"
  | "trap";

export interface PowerMeta {
  kind: PowerKind;
  label: string;
  hint: string;
}

export interface ActiveEffect {
  kind: PowerKind;
  label: string;
  remaining: number;
  duration: number;
}

export interface HudState {
  status: GameStatus;
  role: Role;
  timeLeft: number;
  phonesStolen: number;
  phoneTarget: number;
  snatchersLeft: number;
  snatchersTotal: number;
  strikes: number;
  maxStrikes: number;
  inventory: PowerMeta | null;
  effects: ActiveEffect[];
  prompt: string;
  toast: string;
  toastKey: number;
  winner: Winner;
  caught: boolean;
  /** 0..1 charge while a snatcher holds E to steal a phone. */
  snatchProgress: number;
  /** Bearings (radians, 0 = ahead, + = right) to active snatches — cop only. */
  snatchAlerts: number[];
  /** True while the round is paused and the pause menu is shown. */
  paused: boolean;
  /** True when the player is near the bridge (shows the "in development" notice). */
  nearBridge: boolean;
}

const POWER_META: Record<PowerKind, PowerMeta> = {
  track_cop: { kind: "track_cop", label: "Cop Tracker", hint: "Reveals the cop for 30s" },
  speed: { kind: "speed", label: "Sprint", hint: "Move faster for 8s" },
  invisible: { kind: "invisible", label: "Vanish", hint: "Untraceable for 5s" },
  smoke: { kind: "smoke", label: "Smoke Bomb", hint: "Drop a blinding smoke screen" },
  reveal: { kind: "reveal", label: "Scanner", hint: "Reveals snatchers for 3s" },
  trap: { kind: "trap", label: "Bear Trap", hint: "Drop a trap that freezes a snatcher" },
};

const SNATCHER_POWERS: PowerKind[] = ["track_cop", "speed", "invisible", "smoke"];
const COP_POWERS: PowerKind[] = ["reveal", "speed", "trap"];

/** Minimal surface the engine needs from the netcode client (avoids a circular import). */
export interface NetSender {
  sendPos(x: number, z: number, yaw: number): void;
  snatchStart(): void;
  snatchStop(): void;
  apprehend(targetId: string | null): void;
  pickup(crateId: string): void;
  use(kind: PowerKind): void;
}

export interface NetEntity {
  id: string;
  x: number;
  z: number;
}

export interface NetState {
  status: "lobby" | "playing" | "gameover";
  timeLeft: number;
  strikes: number;
  teamPhones: number;
  phoneTarget: number;
  snatchersTotal: number;
  snatchersLeft: number;
  winner: Winner;
  players: { id: string; x: number; z: number; yaw: number; alive: boolean; isCop: boolean; snatching: boolean; invisible: boolean }[];
  crates: NetEntity[];
  traps: NetEntity[];
  smokes: NetEntity[];
}

const ROUND_TIME = 240; // 4 minutes
const PHONE_TARGET = 5;
const MAX_STRIKES = 3;
// Cop moves slightly faster than a snatcher so a chase stays tense.
const SNATCHER_SPEED = 7;
const COP_SPEED = 7.7;
const HALF_X = 44;
const HALF_Z = 80;
// River + bridge + far-bank plaza geometry. The street runs to +HALF_Z, then a
// bridge corridor crosses the Thames to a far-bank plaza where Big Ben and the
// London Eye stand — all walkable.
const RIVER_NEAR = HALF_Z; // street ends / river begins
const RIVER_FAR = HALF_Z + 56; // far-bank shoreline
const FAR_BANK_MAX_Z = RIVER_FAR + 80; // back edge of the walkable plaza
const DEFAULT_BRIDGE_HALF = 9; // x half-width of the walkable bridge corridor
const EYE = 1.7;
const INTERACT_RANGE = 3.2;
const COP_CATCH_RANGE = 2.4;
const SNATCH_TIME = 3; // seconds to hold E for a successful snatch
const CROWD_SIZE = 30;

const CLOTHES = [
  0xb23a48, 0x2e4057, 0x6a8d73, 0xd9a566, 0x8e5572,
  0x3d5a80, 0x9b6a6c, 0x556270, 0xc08552, 0x4a5859,
];

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** Deterministic PRNG (mulberry32) so every client builds the same crowd. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* ----------------------------- Agent ----------------------------- */

type AgentType = "civilian" | "snatcher" | "cop";

interface CrowdPath {
  hx: number;
  hz: number;
  rx: number;
  rz: number;
  sx: number;
  sz: number;
  px: number;
  pz: number;
}

interface Agent {
  group: THREE.Group;
  type: AgentType;
  alive: boolean;
  hasPhone: boolean;
  phoneMesh: THREE.Object3D;
  wander: THREE.Vector3;
  speed: number;
  trapped: number;
  stealCd: number;
  fleeing: boolean;
  marker: THREE.Mesh;
  /** AI snatcher: currently performing a 3s snatch. */
  snatching: boolean;
  snatchT: number;
  snatchTarget: Agent | null;
  /** Civilian victim: someone is mid-snatch on them this frame → stand and resist. */
  beingSnatched: boolean;
  /** Deterministic looping route for online crowd (shared across clients). */
  path: CrowdPath | null;
  /** Perceived gender of the look — drives which scream plays on snatch. */
  gender: "male" | "female";
}

/** Visual registry entry: tracks a spawned person's animated Meshy model. */
interface Person {
  group: THREE.Group;
  body: THREE.Group;
  kind: CharKind;
  char: CharacterInstance | null;
  prev: THREE.Vector3;
  /** Deterministic civilian look index (online crowd) — undefined = random. */
  variant?: number;
}

interface Powerup {
  kind: PowerKind;
  group: THREE.Group;
  falling: boolean;
}

interface TrapEntity {
  group: THREE.Group;
  pos: THREE.Vector3;
  armed: boolean;
}

interface RemoteAvatar {
  group: THREE.Group;
  marker: THREE.Mesh;
  tx: number;
  tz: number;
  tyaw: number;
  alive: boolean;
  isCop: boolean;
  snatching: boolean;
  invisible: boolean;
}

function kindFor(type: AgentType): CharKind {
  return type === "cop" ? "police" : "pedestrian";
}

/* ---------------------- Procedural textures ----------------------- */

function makeCanvas(size: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d ctx");
  return { c, ctx };
}

function roadTexture(): THREE.Texture {
  const { c, ctx } = makeCanvas(512);
  ctx.fillStyle = "#3a3d42";
  ctx.fillRect(0, 0, 512, 512);
  // asphalt speckle
  for (let i = 0; i < 9000; i++) {
    const g = Math.floor(rand(40, 80));
    ctx.fillStyle = `rgb(${g},${g},${g + 4})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  // centre dashed line
  ctx.fillStyle = "#d8cf6e";
  for (let y = 0; y < 512; y += 64) {
    ctx.fillRect(250, y + 14, 12, 36);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 10);
  tex.anisotropy = 4;
  return tex;
}

function pavementTexture(): THREE.Texture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = "#8d8f93";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {
    const g = Math.floor(rand(120, 160));
    ctx.fillStyle = `rgba(${g},${g},${g},0.5)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = "rgba(60,60,64,0.7)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Soft radial halo used for the additive glow around lamp bulbs. */
function glowTexture(): THREE.Texture {
  const { c, ctx } = makeCanvas(128);
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,233,176,1)");
  grad.addColorStop(0.35, "rgba(255,206,120,0.55)");
  grad.addColorStop(1, "rgba(255,196,110,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Weathered stone slab texture for the bridge deck and parapet. */
function bridgeTexture(): THREE.Texture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = "#a9a394";
  ctx.fillRect(0, 0, 256, 256);
  // mottled grime speckle
  for (let i = 0; i < 4000; i++) {
    const g = Math.floor(rand(120, 175));
    ctx.fillStyle = `rgba(${g},${g - 6},${g - 18},0.4)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // ashlar block joints — staggered courses
  ctx.strokeStyle = "rgba(70,66,56,0.85)";
  ctx.lineWidth = 3;
  const bh = 42;
  const bw = 86;
  for (let row = 0; row * bh <= 256; row++) {
    const y = row * bh;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
    const off = row % 2 === 0 ? 0 : bw / 2;
    for (let x = off; x <= 256; x += bw) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + bh);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function waterTexture(): THREE.Texture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = "#1f4f6b";
  ctx.fillRect(0, 0, 256, 256);
  // glittering ripples
  for (let i = 0; i < 1400; i++) {
    const a = rand(0.05, 0.32);
    const g = Math.floor(rand(120, 210));
    ctx.fillStyle = `rgba(${g},${g + 20},${g + 35},${a})`;
    const w = rand(2, 8);
    ctx.fillRect(Math.random() * 256, Math.random() * 256, w, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 6);
  return tex;
}

function brickTexture(base: string, accent: string): THREE.Texture {
  const { c, ctx } = makeCanvas(256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  const bw = 32;
  const bh = 16;
  for (let row = 0; row < 256 / bh; row++) {
    const off = row % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col < 256 / bw + 1; col++) {
      const x = col * bw + off;
      const y = row * bh;
      const v = Math.floor(rand(-14, 14));
      const cc = shade(accent, v);
      ctx.fillStyle = cc;
      ctx.fillRect(x + 1, y + 1, bw - 2, bh - 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp((n >> 16) + amt, 0, 255);
  const g = clamp(((n >> 8) & 0xff) + amt, 0, 255);
  const b = clamp((n & 0xff) + amt, 0, 255);
  return `rgb(${r},${g},${b})`;
}

/* ----------------------------- Engine ----------------------------- */

export class GameEngine {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private raf = 0;
  private setHud: (s: HudState) => void;

  // input
  private keys: Record<string, boolean> = {};
  private yaw = 0;
  private pitch = 0;
  private pointerLocked = false;
  private paused = false;
  private interactQueued = false;
  private powerQueued = false;

  // player
  private role: Role = "snatcher";
  private playerPos = new THREE.Vector3(0, EYE, 30);
  /** Server-assigned spawn for the next online round (random per player). */
  private pendingSpawn: { x: number; z: number; yaw: number } | null = null;
  private playerVel = new THREE.Vector3();
  private baseSpeed = 7;

  // world
  private agents: Agent[] = [];
  private powerups: Powerup[] = [];
  private traps: TrapEntity[] = [];
  private buses: THREE.Group[] = [];
  private thamesWater: THREE.Mesh | null = null;

  // collision: cylindrical colliders for solid static props (phone boxes,
  // lamps, landmarks). Rebuilt with the street.
  private colliders: { x: number; z: number; r: number }[] = [];
  // walkable bridge corridor half-width (updated from the generated bridge).
  private bridgeHalf = DEFAULT_BRIDGE_HALF;

  // generated character models
  private charModels = new CharacterModels();
  private people: Person[] = [];

  // generated static props (buildings, lamp, crate, road)
  private propModels = new PropModels();
  private streetGroup = new THREE.Group();
  private lampHalo = glowTexture();

  // markers
  private copMarker: THREE.Mesh | null = null;
  private smoke: THREE.Object3D | null = null;
  private smokeTime = 0;

  // state
  private status: GameStatus = "lobby";
  private timeLeft = ROUND_TIME;
  private phonesStolen = 0;
  private snatchersTotal = 0;
  private strikes = 0;
  private inventory: PowerKind | null = null;
  private effects: { kind: PowerKind; remaining: number; duration: number }[] = [];
  private winner: Winner = null;
  private caught = false;
  private prompt = "";
  private toast = "";
  private toastKey = 0;
  private nearBridge = false;
  private spawnTimer = 6;
  private copSuspicion = 0; // for snatcher player: how aware AI cop is

  // online
  private online = false;
  private net: NetSender | null = null;
  private myId = "";
  private remote = new Map<string, RemoteAvatar>();
  private crowd: Agent[] = [];
  private crowdSeed = 1;
  private netCrates = new Map<string, THREE.Group>();
  private netTraps = new Map<string, THREE.Group>();
  private netSmokes = new Map<string, THREE.Object3D>();
  private srvTimeLeft = ROUND_TIME;
  private srvStrikes = 0;
  private srvPhones = 0;
  private srvPhoneTarget = PHONE_TARGET;
  private srvSnatchersLeft = 0;
  private srvSnatchersTotal = 0;
  private revealIds: string[] = [];
  private revealUntil = 0;
  private trackId: string | null = null;
  private trackUntil = 0;
  private frozenUntil = 0;
  private posSendTimer = 0;
  private snatchCd = 0;

  // snatch (hold-E) state
  private snatchCharge = 0; // seconds the player has held E on a valid target
  private snatching = false; // is the local player actively snatching (online send dedupe)
  private playerSnatchTarget: Agent | null = null; // civilian the local player is snatching
  private snatchAlerts: number[] = []; // bearings to active snatches (cop HUD)
  private snatchBeacons: THREE.Mesh[] = []; // reusable 3D markers above active snatches
  private audio = new AudioManager(); // one-shot game SFX
  private timeWarned = false; // "10 seconds left" alarm fired this round?

  /** Combined asset-load progress (0..1) across characters + props. */
  get assetProgress(): number {
    return (this.charModels.progress + this.propModels.progress) / 2;
  }

  /** True once every generated character + prop model has finished loading. */
  get assetsReady(): boolean {
    return this.charModels.ready && this.propModels.ready;
  }

  constructor(canvas: HTMLCanvasElement, setHud: (s: HudState) => void) {
    this.setHud = setHud;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc9d8e6);
    this.scene.fog = new THREE.Fog(0xc9d8e6, 110, 300);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    this.camera.position.copy(this.playerPos);

    this.buildWorld();
    this.bindInput(canvas);
    this.resize();

    // load generated models in the background, then upgrade any spawned people.
    void this.charModels
      .load()
      .then(() => this.upgradePeople())
      .catch((err) => console.warn("character models failed to load", err));

    // load generated static props, then rebuild the street with them.
    void this.propModels
      .load()
      .then(() => {
        this.buildStreet();
        this.upgradePhones();
      })
      .catch((err) => console.warn("prop models failed to load", err));
  }

  /* --------------------------- world --------------------------- */

  private buildWorld(): void {
    // lighting
    const hemi = new THREE.HemisphereLight(0xbcd3ef, 0x4a4036, 0.85);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    sun.position.set(70, 110, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -HALF_X - 20;
    sun.shadow.camera.right = HALF_X + 20;
    sun.shadow.camera.top = HALF_Z + 20;
    sun.shadow.camera.bottom = -HALF_Z - 20;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    // street set (road, pavements, buildings, lamps, phone boxes, river,
    // landmarks, buses) — rebuilt once generated prop models finish loading.
    this.scene.add(this.streetGroup);
    this.buildStreet();

    // sky dome gradient via large sphere — rendered without fog so the gradient
    // and sun stay vivid instead of washing out to a flat haze colour.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(440, 32, 20),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true, fog: false })
    );
    const geo = sky.geometry as THREE.SphereGeometry;
    const colors: number[] = [];
    const zenith = new THREE.Color(0x2f6cb0);
    const mid = new THREE.Color(0x8fb8e0);
    const horizon = new THREE.Color(0xdfe9f0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = clamp(pos.getY(i) / 440, -1, 1);
      // two-stop gradient: horizon haze -> mid sky -> deep zenith blue
      const t = clamp(y, 0, 1);
      const col = t < 0.35
        ? horizon.clone().lerp(mid, t / 0.35)
        : mid.clone().lerp(zenith, (t - 0.35) / 0.65);
      colors.push(col.r, col.g, col.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.scene.add(sky);

    // Sun — glowing disc placed along the directional light's direction, with a
    // soft additive halo so it reads as a real sun in the sky.
    const sunDir = new THREE.Vector3(70, 110, 60).normalize();
    const sunGroup = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.SphereGeometry(16, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff6e0, fog: false })
    );
    sunGroup.add(disc);
    for (const [r, opacity, color] of [[34, 0.5, 0xfff1cf], [62, 0.28, 0xffe6b0], [110, 0.14, 0xffdca0]] as const) {
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.BackSide })
      );
      sunGroup.add(halo);
    }
    sunGroup.position.copy(sunDir.multiplyScalar(400));
    this.scene.add(sunGroup);
  }

  /** Build (or rebuild) the whole street set. Uses generated prop models
   *  where they are loaded, otherwise procedural geometry. */
  private buildStreet(): void {
    for (const c of this.streetGroup.children.slice()) {
      this.streetGroup.remove(c);
      c.traverse?.((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !m.userData.shared) {
          m.geometry?.dispose();
        }
      });
    }
    this.colliders = [];
    this.buildRoad();
    this.buildBuildings();
    this.buildLamps();
    this.buildPhoneBoxes();
    this.buildTunnels();
    this.buildThames();
    this.rebuildBuses();
  }

  /** A modern urban concrete road tunnel at the south end of the street that
   *  buses drive out of, so traffic no longer pops out of thin air. The
   *  riverside end is left open so the Big Ben / London Eye skyline stays in
   *  full view. Built procedurally so it's correctly proportioned to the
   *  street width and never distorts. */
  private buildTunnels(): void {
    const portalZ = -HALF_Z + 2;
    this.buildTunnelInterior(portalZ);
    this.buildModernTunnelFacade(portalZ);
  }

  /** Clean modern concrete tunnel face: a low header beam over the road, a
   *  ribbed facade wall above it, side abutments and slim trim framing the
   *  dark mouth. Proportioned to the road so it reads as a real city tunnel. */
  private buildModernTunnelFacade(portalZ: number): void {
    const W = HALF_X - 0.6; // road half-width
    const openH = 10; // clearance height of the mouth (buses pass easily)
    const wallTop = 17; // top of the facade wall
    const headerH = 1.8;

    const concrete = new THREE.MeshStandardMaterial({ color: 0x9ca0a5, roughness: 0.92, metalness: 0.04 });
    const concreteDark = new THREE.MeshStandardMaterial({ color: 0x7d8187, roughness: 0.95 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xc6cace, roughness: 0.8 });

    const g = new THREE.Group();

    // Header beam spanning the top of the opening.
    const header = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 4, headerH, 3), concrete);
    header.position.set(0, openH + headerH / 2, 0);
    header.castShadow = true;
    header.receiveShadow = true;
    g.add(header);

    // Facade wall above the header.
    const wallH = wallTop - (openH + headerH);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 4, wallH, 2.2), concrete);
    wall.position.set(0, openH + headerH + wallH / 2, 0);
    wall.castShadow = true;
    wall.receiveShadow = true;
    g.add(wall);

    // Slim bright trim band just above the mouth (modern detail line).
    const band = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 5, 0.45, 3.1), trim);
    band.position.set(0, openH + headerH + 0.25, 0);
    g.add(band);

    // Vertical ribs across the facade wall for an urban concrete look.
    const ribCount = 9;
    for (let i = 0; i < ribCount; i++) {
      const rx = -W + 1 + (i / (ribCount - 1)) * (W * 2 - 2);
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.5, wallH - 0.6, 0.5), concreteDark);
      rib.position.set(rx, openH + headerH + wallH / 2, 1.2);
      g.add(rib);
    }

    // Side abutment walls and vertical edge trim framing the mouth.
    for (const side of [-1, 1]) {
      const ab = new THREE.Mesh(new THREE.BoxGeometry(5, wallTop, 4), concreteDark);
      ab.position.set(side * (W + 2.4), wallTop / 2, 0);
      ab.castShadow = true;
      ab.receiveShadow = true;
      g.add(ab);
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.7, openH + headerH, 3.2), trim);
      jamb.position.set(side * (W + 0.1), (openH + headerH) / 2, 0);
      g.add(jamb);
    }

    g.position.z = portalZ;
    this.streetGroup.add(g);
  }

  /** Pitch-black recessed interior (floor, ceiling, side walls and back wall)
   *  set behind the portal so the tunnel mouth reads as a true dark void, and a
   *  solid wall of colliders across the mouth so players/NPCs cannot walk in. */
  private buildTunnelInterior(portalZ: number): void {
    const W = HALF_X - 0.6;
    const depth = 44;
    const cz = portalZ - depth / 2 - 1; // throat centre, behind the map edge
    const black = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, metalness: 0 });
    const g = new THREE.Group();
    // dark floor (covers the road texture inside the throat)
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.2, depth), black);
    floor.position.set(0, 0.12, cz);
    g.add(floor);
    // ceiling (bottom sits at the mouth clearance height)
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.8, depth), black);
    ceiling.position.set(0, 10.4, cz);
    g.add(ceiling);
    // side walls
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(1.2, 12, depth), black);
      wall.position.set(side * W, 6, cz);
      g.add(wall);
    }
    // back wall sealing the far end of the throat
    const back = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 12, 1.2), black);
    back.position.set(0, 6, cz - depth / 2);
    g.add(back);
    this.streetGroup.add(g);

    // Solid collider wall across the tunnel mouth so nothing can walk inside.
    const r = 1.6;
    for (let x = -W; x <= W; x += r * 1.5) {
      this.colliders.push({ x, z: portalZ + 1.5, r });
    }
  }

  /** Scatter classic red telephone boxes along both pavements. */
  private buildPhoneBoxes(): void {
    const generated = this.propModels.has("phonebox");
    for (let z = -HALF_Z + 16; z < HALF_Z - 6; z += 22) {
      for (const side of [-1, 1]) {
        const x = side * (HALF_X - 8.5);
        const box = generated ? this.propModels.create("phonebox") : this.makePhoneBoxFallback();
        if (!box) continue;
        box.position.set(x, 0, z);
        box.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
        this.streetGroup.add(box);
        this.colliders.push({ x, z, r: 0.95 });
      }
    }
  }

  private makePhoneBoxFallback(): THREE.Group {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xb01818, roughness: 0.5, metalness: 0.2 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.5, 1.1), red);
    body.position.y = 1.25;
    body.castShadow = true;
    g.add(body);
    const glass = new THREE.MeshStandardMaterial({ color: 0x223, roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.5 });
    for (const face of [0, 1, 2, 3]) {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.5, 0.06), glass);
      const a = (face * Math.PI) / 2;
      pane.position.set(Math.sin(a) * 0.56, 1.5, Math.cos(a) * 0.56);
      pane.rotation.y = a;
      g.add(pane);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 1.2), red);
    roof.position.y = 2.65;
    g.add(roof);
    return g;
  }

  /** Build the River Thames running horizontally across the riverside end of
   *  the street, with a bridge spanning it from the play area to the far bank
   *  where the London Eye and Big Ben rise as a skyline. */
  private buildThames(): void {
    const nearZ = RIVER_NEAR;
    const farZ = RIVER_FAR;
    const riverWidth = HALF_X * 6;

    // bridge corridor width follows the generated bridge model when available.
    // The model is directionless, so the WIDTH is its shorter horizontal axis.
    const bridgeDims = this.propModels.dims("bridge");
    const modelWidth = Math.min(bridgeDims.x, bridgeDims.z);
    this.bridgeHalf = modelWidth > 1 ? clamp(modelWidth / 2, 6, 14) : DEFAULT_BRIDGE_HALF;
    const bridgeHalf = this.bridgeHalf;

    // water surface (flat, running left-right across the view)
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(riverWidth, farZ - nearZ, 1, 1),
      new THREE.MeshStandardMaterial({
        map: waterTexture(),
        color: 0x2a5d7c,
        roughness: 0.25,
        metalness: 0.5,
        emissive: 0x0a2436,
        emissiveIntensity: 0.3,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.05, (nearZ + farZ) / 2);
    this.streetGroup.add(water);
    this.thamesWater = water;

    // stone embankment along the near shore, with a gap for the bridge
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a8170, roughness: 0.95 });
    for (const sx of [-1, 1]) {
      const segW = HALF_X - bridgeHalf;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.9, 1.6), wallMat);
      wall.position.set(sx * (bridgeHalf + segW / 2), 0.45, nearZ - 0.4);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.streetGroup.add(wall);
    }

    // far bank plaza so the landmarks have a walkable surface to stand on
    const bank = new THREE.Mesh(
      new THREE.PlaneGeometry(riverWidth, (FAR_BANK_MAX_Z - farZ) + 40),
      new THREE.MeshStandardMaterial({ map: pavementTexture(), color: 0xb9bcc0, roughness: 1 }),
    );
    (bank.material as THREE.MeshStandardMaterial).map!.repeat.set(20, 14);
    bank.rotation.x = -Math.PI / 2;
    bank.position.set(0, 0.02, (farZ + FAR_BANK_MAX_Z) / 2 + 5);
    bank.receiveShadow = true;
    this.streetGroup.add(bank);

    this.buildBridge(nearZ, farZ, bridgeHalf);

    // landmarks on the far-bank plaza, flanking the bridge exit
    const eye = this.propModels.has("londonEye")
      ? this.propModels.create("londonEye")
      : this.makeEyeFallback();
    if (eye) {
      const ex = -HALF_X * 0.62;
      const ez = farZ + 30;
      eye.position.set(ex, 0, ez);
      eye.rotation.y = Math.PI;
      this.streetGroup.add(eye);
      this.colliders.push({ x: ex, z: ez, r: 10 });
    }
    const ben = this.propModels.has("bigBen")
      ? this.propModels.create("bigBen")
      : this.makeBenFallback();
    if (ben) {
      const bx = HALF_X * 0.62;
      const bz = farZ + 34;
      ben.position.set(bx, 0, bz);
      ben.rotation.y = Math.PI;
      this.streetGroup.add(ben);
      this.colliders.push({ x: bx, z: bz, r: 5 });
    }

    this.buildFarBankDecor(farZ);
  }

  /** Dress the far-bank plaza so it reads as a real London riverside square
   *  rather than empty pavement: a backdrop terrace of Georgian townhouses,
   *  London plane trees, Victorian lamp posts, red phone boxes and benches.
   *  Everything is placed deterministically and kept clear of the central
   *  walkable path between the bridge and the landmarks. */
  private buildFarBankDecor(farZ: number): void {
    const rng = mulberry32(0x10d0a);
    const W = HALF_X - 0.6;
    const backZ = FAR_BANK_MAX_Z;

    // 1) Backdrop terrace of London townhouses along the rear edge, facing the
    //    river so they frame the square behind the landmarks.
    let z = -W + 4;
    while (z < W - 4) {
      const width = 9 + rng() * 5;
      const house = this.makeTownhouse(width, 14 + rng() * 10, rng);
      house.position.set(z + width / 2, 0, backZ + 4);
      this.streetGroup.add(house);
      z += width + 0.5;
    }

    // 2) Side terraces along the left/right edges of the plaza, facing inward.
    //    Mix the generated Meshy buildings (varied heights/widths) with the
    //    procedural townhouses so the rows no longer look repetitive.
    const variants: PropKind[] = ["buildingTall", "buildingWide", "buildingModern"];
    const haveVariants = variants.filter((k) => this.propModels.has(k));
    for (const side of [-1, 1]) {
      const yaw = side === -1 ? Math.PI / 2 : -Math.PI / 2;
      let sz = farZ + 14;
      let i = Math.floor(rng() * 3);
      while (sz < backZ - 8) {
        // Every other slot, drop in a generated Meshy building if one is loaded.
        const useMeshy = haveVariants.length > 0 && rng() < 0.6;
        if (useMeshy) {
          const kind = haveVariants[i % haveVariants.length];
          i += 1;
          const dims = this.propModels.dims(kind);
          const b = this.propModels.create(kind);
          if (b) {
            const width = dims.x || 12;
            b.rotation.y = yaw;
            b.position.set(side * (HALF_X + (dims.z || 8) / 2 + 1), 0, sz + width / 2);
            this.streetGroup.add(b);
            sz += width + 0.6;
            continue;
          }
        }
        const width = 8 + rng() * 4;
        const house = this.makeTownhouse(width, 12 + rng() * 8, rng);
        house.rotation.y = yaw;
        house.position.set(side * (HALF_X + 3), 0, sz + width / 2);
        this.streetGroup.add(house);
        sz += width + 0.5;
      }
    }

    // 3) A riverside promenade railing along the far shore, with a central gap
    //    where the bridge lands.
    const railMat = new THREE.MeshStandardMaterial({ color: 0x1c2127, roughness: 0.6, metalness: 0.5 });
    const gap = this.bridgeHalf + 1.5;
    for (let rx = -W + 1; rx <= W - 1; rx += 2) {
      if (Math.abs(rx) < gap) continue;
      const postR = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 6), railMat);
      postR.position.set(rx, 0.5, farZ + 0.6);
      this.streetGroup.add(postR);
    }
    for (const sx of [-1, 1]) {
      const railLen = W - gap;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, 0.1, 0.1), railMat);
      rail.position.set(sx * (gap + railLen / 2), 0.95, farZ + 0.6);
      this.streetGroup.add(rail);
    }

    // 4) Plane trees, lamp posts, benches and phone boxes scattered around the
    //    plaza edges, keeping the centre path clear.
    const onPath = (x: number, zz: number): boolean =>
      Math.abs(x) < this.bridgeHalf + 4 && zz < farZ + 40;
    const placeRow = (zRow: number, make: (x: number, zz: number) => void) => {
      for (let x = -W + 8; x <= W - 8; x += 11) {
        const px = x + (rng() - 0.5) * 3;
        if (onPath(px, zRow)) continue;
        make(px, zRow + (rng() - 0.5) * 3);
      }
    };
    placeRow(farZ + 8, (x, zz) => {
      this.streetGroup.add(this.makeLamp(x, zz));
      this.colliders.push({ x, z: zz, r: 0.4 });
    });
    placeRow(farZ + 26, (x, zz) => {
      this.streetGroup.add(this.makeTree(x, zz, rng));
      this.colliders.push({ x, z: zz, r: 1 });
    });
    placeRow(backZ - 14, (x, zz) => {
      this.streetGroup.add(this.makeTree(x, zz, rng));
      this.colliders.push({ x, z: zz, r: 1 });
    });

    // benches facing the river along the promenade
    for (const x of [-W * 0.55, -W * 0.28, W * 0.28, W * 0.55]) {
      const bz = farZ + 5;
      this.streetGroup.add(this.makeBench(x, bz));
      this.colliders.push({ x, z: bz, r: 0.8 });
    }

    // a couple of red phone boxes flanking the bridge exit
    const generated = this.propModels.has("phonebox");
    for (const sx of [-1, 1]) {
      const px = sx * (this.bridgeHalf + 4);
      const pz = farZ + 6;
      const box = generated ? this.propModels.create("phonebox") : this.makePhoneBoxFallback();
      if (!box) continue;
      box.position.set(px, 0, pz);
      box.rotation.y = Math.PI;
      this.streetGroup.add(box);
      this.colliders.push({ x: px, z: pz, r: 0.95 });
    }
  }

  /** A Georgian/Victorian London terraced townhouse: brick facade with sash
   *  windows, a pale cornice and a slate roof. Front faces +Z. */
  private makeTownhouse(width: number, height: number, rng: () => number): THREE.Group {
    const g = new THREE.Group();
    const depth = 9;
    const palettes: [string, string][] = [
      ["#8a5a44", "#a8745a"],
      ["#7a4a3c", "#9a6450"],
      ["#caa777", "#e0c79a"],
      ["#5e4640", "#7c5f55"],
    ];
    const pal = palettes[Math.floor(rng() * palettes.length)];
    const tex = brickTexture(pal[0], pal[1]);
    tex.repeat.set(Math.max(2, Math.round(width / 3)), Math.max(3, Math.round(height / 3)));
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }),
    );
    body.position.set(0, height / 2, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // pale stone cornice + parapet
    const stone = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.9 });
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(width + 0.6, 0.8, depth + 0.6), stone);
    cornice.position.set(0, height + 0.4, 0);
    g.add(cornice);

    // slate mansard roof
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(width, 2.2, depth),
      new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.85 }),
    );
    roof.position.set(0, height + 1.9, 0);
    g.add(roof);

    // warm sash windows on the front face
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xffe9b8,
      emissive: 0xffc864,
      emissiveIntensity: 0.5,
      roughness: 0.4,
    });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.8 });
    const rows = Math.max(2, Math.floor(height / 4));
    const cols = Math.max(1, Math.floor(width / 3));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = -width / 2 + (c + 0.5) * (width / cols);
        const wy = 2.2 + r * (height / rows);
        if (wy > height - 1) continue;
        const frame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.1, 0.2), frameMat);
        frame.position.set(wx, wy, depth / 2 + 0.02);
        g.add(frame);
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.7, 0.24), winMat);
        win.position.set(wx, wy, depth / 2 + 0.04);
        g.add(win);
      }
    }
    return g;
  }

  /** A London plane tree: tapered trunk with a couple of leafy canopy clusters. */
  private makeTree(x: number, z: number, rng: () => number): THREE.Group {
    const g = new THREE.Group();
    const h = 4.5 + rng() * 2.5;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.32, h, 7),
      new THREE.MeshStandardMaterial({ color: 0x6e5944, roughness: 0.95 }),
    );
    trunk.position.y = h / 2;
    trunk.castShadow = true;
    g.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 1 });
    const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x5f8c45, roughness: 1 });
    for (let i = 0; i < 4; i++) {
      const rad = 1.6 + rng() * 1;
      const blob = new THREE.Mesh(
        new THREE.SphereGeometry(rad, 8, 7),
        i % 2 === 0 ? leafMat : leafMat2,
      );
      blob.position.set((rng() - 0.5) * 2, h + (rng() - 0.3) * 1.6, (rng() - 0.5) * 2);
      blob.castShadow = true;
      g.add(blob);
    }
    g.position.set(x, 0, z);
    return g;
  }

  /** A simple slatted park bench. Front (seat opening) faces -Z toward the river. */
  private makeBench(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    const woodA = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.6, metalness: 0.5 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.7), woodA);
    seat.position.y = 0.55;
    seat.castShadow = true;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.6, 0.12), woodA);
    back.position.set(0, 0.9, 0.32);
    g.add(back);
    for (const lx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.7), ironMat);
      leg.position.set(lx * 1.05, 0.27, 0);
      g.add(leg);
    }
    g.position.set(x, 0, z);
    return g;
  }

  /** A clean stone bridge deck across the river at walking height, with solid
   *  parapet walls, baluster detailing and support piers. Built procedurally so
   *  the deck sits exactly at the player's foot level regardless of any model
   *  proportions (a multi-arch model can't fit this flat, fixed-height world). */
  private buildBridge(nearZ: number, farZ: number, half: number): void {
    const span = farZ - nearZ + 6;
    const centerZ = (nearZ + farZ) / 2;
    const DECK_TOP = 0.32; // top surface of the walkable deck

    const deckTex = bridgeTexture();
    deckTex.repeat.set(Math.max(2, Math.round(half / 3)), Math.max(4, Math.round(span / 6)));
    const stoneMat = new THREE.MeshStandardMaterial({ map: deckTex, color: 0xb8b2a2, roughness: 0.95 });
    const wallTex = bridgeTexture();
    wallTex.repeat.set(1, Math.max(6, Math.round(span / 5)));
    const trimMat = new THREE.MeshStandardMaterial({ map: wallTex, color: 0x9a9282, roughness: 0.9 });

    // Walkable stone deck slab — top at DECK_TOP so the player crosses on it.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.4, span), stoneMat);
    deck.position.set(0, DECK_TOP - 0.2, centerZ);
    deck.receiveShadow = true;
    this.streetGroup.add(deck);

    // Solid parapet walls on both sides, with a flat cap rail and balusters.
    const wallH = 0.85;
    const capMat = new THREE.MeshStandardMaterial({ color: 0x6f6a5d, roughness: 0.85 });
    const balusters = Math.max(8, Math.round(span / 2));
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, wallH, span), trimMat);
      wall.position.set(sx * (half - 0.2), DECK_TOP + wallH / 2, centerZ);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.streetGroup.add(wall);

      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, span), capMat);
      cap.position.set(sx * (half - 0.2), DECK_TOP + wallH + 0.09, centerZ);
      this.streetGroup.add(cap);

      // raised newel posts at the bridge ends
      for (const ez of [nearZ - 2, farZ + 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, wallH + 0.7, 0.9), capMat);
        post.position.set(sx * (half - 0.2), DECK_TOP + (wallH + 0.7) / 2, ez);
        post.castShadow = true;
        this.streetGroup.add(post);
      }

      // baluster detailing along the wall face
      for (let i = 0; i <= balusters; i++) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, wallH * 0.7, 6), capMat);
        b.position.set(sx * (half - 0.05), DECK_TOP + wallH * 0.35, centerZ - span / 2 + (span / balusters) * i);
        this.streetGroup.add(b);
      }
    }

    // Support piers dipping toward the waterline on the bridge flanks.
    const pierMat = new THREE.MeshStandardMaterial({ color: 0x6b6457, roughness: 1 });
    for (const pz of [nearZ + span * 0.25, centerZ, farZ - span * 0.25]) {
      for (const sx of [-1, 1]) {
        const pier = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.95, 3, 10), pierMat);
        pier.position.set(sx * (half - 0.6), -1.2, pz);
        pier.castShadow = true;
        this.streetGroup.add(pier);
      }
    }
  }

  private makeEyeFallback(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xdfe7ee, roughness: 0.4, metalness: 0.6 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(18, 0.6, 8, 48), mat);
    ring.position.y = 20;
    g.add(ring);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 18, 6), mat);
      spoke.position.set(Math.cos(a) * 9, 20 + Math.sin(a) * 9, 0);
      spoke.rotation.z = a + Math.PI / 2;
      g.add(spoke);
    }
    return g;
  }

  private makeBenFallback(): THREE.Group {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: 0xb09a5e, roughness: 0.9 });
    const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 44, 7), stone);
    tower.position.y = 22;
    g.add(tower);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(5.4, 12, 4), new THREE.MeshStandardMaterial({ color: 0x3c6e57, roughness: 0.8 }));
    roof.position.y = 50;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    const face = new THREE.MeshStandardMaterial({ color: 0xf4ecd0, emissive: 0xe8dca0, emissiveIntensity: 0.4 });
    for (const a of [0, 1, 2, 3]) {
      const clock = new THREE.Mesh(new THREE.CircleGeometry(2, 18), face);
      const ang = (a * Math.PI) / 2;
      clock.position.set(Math.sin(ang) * 3.6, 40, Math.cos(ang) * 3.6);
      clock.rotation.y = ang;
      g.add(clock);
    }
    return g;
  }

  /** (Re)create the moving red buses, using the generated model when loaded. */
  private rebuildBuses(): void {
    for (const bus of this.buses) this.scene.remove(bus);
    this.buses = [];
    const lanes = [-HALF_X * 0.45, HALF_X * 0.2, -HALF_X * 0.1];
    for (let i = 0; i < 3; i++) {
      const bus = this.makeBus();
      // stagger start positions so a bus is always emerging from the south tunnel
      bus.position.set(lanes[i], 0, -HALF_Z - 14 + i * 30);
      this.buses.push(bus);
      this.scene.add(bus);
    }
  }

  private buildRoad(): void {
    // textured base plane (always present so there is never a void underneath)
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_X * 2, HALF_Z * 2),
      new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.95 })
    );
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    this.streetGroup.add(road);

    // pavements — base slab kerb (always present), topped with generated
    // paving tiles when the Meshy slab is loaded.
    const pavMat = new THREE.MeshStandardMaterial({ map: pavementTexture(), roughness: 1 });
    pavMat.map!.repeat.set(2, 22);
    const hasPavTile = this.propModels.ready && this.propModels.has("pavement");
    for (const side of [-1, 1]) {
      const pav = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, HALF_Z * 2), pavMat);
      pav.position.set(side * (HALF_X - 4), 0.15, 0);
      pav.receiveShadow = true;
      this.streetGroup.add(pav);
    }

    // Tile the generated paving slab across the top of each pavement strip so
    // the walkway reads as clean light-grey London flagstones.
    if (hasPavTile) {
      const pdims = this.propModels.dims("pavement");
      const step = Math.max(pdims.x, pdims.z, 2) - 0.02;
      const top = 0.3; // pavement kerb top surface
      for (const side of [-1, 1]) {
        const cx = side * (HALF_X - 4);
        for (let x = cx - 4 + step / 2; x < cx + 4; x += step) {
          for (let z = -HALF_Z + step / 2; z < HALF_Z; z += step) {
            const tile = this.propModels.create("pavement");
            if (!tile) break;
            tile.position.set(x, top, z);
            tile.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
            this.streetGroup.add(tile);
          }
        }
      }
    }

    // generated asphalt slabs tiled across the road surface. The slabs are
    // grounded at y=0 in props.ts, so we SINK them by their own thickness and
    // leave only a thin top layer flush with the ground — otherwise their full
    // height sticks up and clips the characters walking at y=0.
    if (this.propModels.ready) {
      const dims = this.propModels.dims("road");
      const step = Math.max(dims.x, dims.z, 4) - 0.02;
      const sink = Math.max(dims.y - 0.04, 0); // top sits ~0.04 above base plane
      for (let x = -HALF_X + step / 2; x < HALF_X - 8; x += step) {
        for (let z = -HALF_Z + step / 2; z < HALF_Z; z += step) {
          const tile = this.propModels.create("road");
          if (!tile) break;
          tile.position.set(x, -sink, z);
          tile.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
          this.streetGroup.add(tile);
        }
      }
    }
  }

  private buildBuildings(): void {
    if (this.propModels.ready) {
      this.buildGeneratedBuildings();
      return;
    }
    const palettes: [string, string][] = [
      ["#3a2f2a", "#5c4a3f"],
      ["#43474d", "#5e636b"],
      ["#6b3f3a", "#8a564f"],
      ["#2f3a44", "#465664"],
    ];
    for (const side of [-1, 1]) {
      let z = -HALF_Z;
      while (z < HALF_Z) {
        const w = rand(8, 14);
        const h = rand(12, 26);
        const depth = 10;
        const pal = palettes[Math.floor(Math.random() * palettes.length)];
        const tex = brickTexture(pal[0], pal[1]);
        tex.repeat.set(Math.round(w / 3), Math.round(h / 3));
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 });
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), mat);
        b.position.set(side * (HALF_X + depth / 2 - 0.5), h / 2, z + w / 2);
        b.castShadow = true;
        b.receiveShadow = true;
        this.streetGroup.add(b);

        // windows (emissive at ground feel)
        const winMat = new THREE.MeshStandardMaterial({
          color: 0x9ec7e8,
          roughness: 0.2,
          metalness: 0.1,
          emissive: 0x16324a,
          emissiveIntensity: 0.4,
        });
        const rows = Math.floor(h / 4);
        const cols = Math.floor(w / 3);
        for (let r = 1; r < rows; r++) {
          for (let cidx = 0; cidx < cols; cidx++) {
            const win = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.8, 0.2), winMat);
            win.position.set(
              side * (HALF_X - 0.4),
              r * 4,
              z + 1.6 + cidx * (w / cols)
            );
            this.streetGroup.add(win);
          }
        }
        z += w + 0.6;
      }
    }
  }

  /** Line both sides of the street with cloned generated building facades. */
  private buildGeneratedBuildings(): void {
    // Mix the original facades with the newer varied Meshy buildings so the
    // main street no longer repeats the same two blocks down its length.
    const kinds: PropKind[] = [
      "buildingA",
      "buildingTall",
      "buildingB",
      "buildingModern",
      "buildingWide",
    ];
    const available = kinds.filter((k) => this.propModels.has(k));
    if (available.length === 0) return;
    for (const side of [-1, 1]) {
      // side -1 (negative X) facade faces +X (inward) → +90° yaw; side +1 → -90°.
      const yaw = side === -1 ? Math.PI / 2 : -Math.PI / 2;
      let z = -HALF_Z;
      // Offset the starting index per side so the two rows don't mirror.
      let i = side === -1 ? 0 : 2;
      while (z < HALF_Z) {
        const kind = available[i % available.length];
        i += 1;
        const dims = this.propModels.dims(kind);
        const width = dims.x || 12;
        const depth = dims.z || 8;
        const b = this.propModels.create(kind);
        if (!b) break;
        b.rotation.y = yaw;
        // facade front sits just behind the pavement edge.
        b.position.set(side * (HALF_X + depth / 2 - 0.5), 0, z + width / 2);
        this.streetGroup.add(b);
        z += width + 0.4;
      }
    }
  }

  private buildLamps(): void {
    for (let z = -HALF_Z + 6; z < HALF_Z; z += 14) {
      for (const side of [-1, 1]) {
        const x = side * (HALF_X - 6.5);
        this.streetGroup.add(this.makeLamp(x, z));
        this.colliders.push({ x, z, r: 0.4 });
      }
    }
  }

  private makeLamp(x: number, z: number): THREE.Group {
    const gen = this.propModels.ready ? this.propModels.create("lamp") : null;
    if (gen) {
      gen.position.set(x, 0, z);
      gen.rotation.y = Math.random() * Math.PI * 2;
      // light the head at ~95% of the lamp height.
      const headY = (this.propModels.dims("lamp").y || 6) * 0.95;
      gen.add(this.makeLampGlow(headY));
      return gen;
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2127, roughness: 0.6, metalness: 0.5 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6, 8), mat);
    post.position.y = 3;
    post.castShadow = true;
    g.add(post);
    g.add(this.makeLampGlow(6));
    g.position.set(x, 0, z);
    return g;
  }

  /** Warm bulb + additive halo sprite + a cheap (shadowless) point light. */
  private makeLampGlow(y: number): THREE.Group {
    const glow = new THREE.Group();

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0xfff1c0,
        emissive: 0xffcf6e,
        emissiveIntensity: 2.4,
      })
    );
    bulb.position.y = y;
    glow.add(bulb);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.lampHalo,
        color: 0xffd98a,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    halo.scale.setScalar(3.2);
    halo.position.y = y;
    glow.add(halo);

    const light = new THREE.PointLight(0xffd28a, 14, 22, 2);
    light.position.y = y - 0.1;
    light.castShadow = false;
    glow.add(light);

    return glow;
  }

  private makeBus(): THREE.Group {
    if (this.propModels.has("bus")) {
      const gen = this.propModels.create("bus");
      if (gen) {
        // generated bus front faces +Z; buses travel toward +Z.
        return gen;
      }
    }
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(3, 3.4, 9),
      new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.5, metalness: 0.2 })
    );
    body.position.y = 2.1;
    body.castShadow = true;
    g.add(body);
    const winMat = new THREE.MeshStandardMaterial({ color: 0x223, roughness: 0.1, metalness: 0.4 });
    for (let i = -1; i <= 1; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.9, 8.6), winMat);
      stripe.position.set(0, 2.7, 0);
      g.add(stripe);
      break;
    }
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111, roughness: 0.8 });
    for (const sx of [-1.4, 1.4]) {
      for (const sz of [-3, 3]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.5, 12), wheelMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(sx, 0.7, sz);
        g.add(w);
      }
    }
    return g;
  }

  /* --------------------------- agents --------------------------- */

  private makePerson(type: AgentType, opts?: { variant?: number; pos?: THREE.Vector3 }): Agent {
    // Pin a concrete look index so the rendered model and its scream voice agree.
    const variant = opts?.variant ?? Math.floor(Math.random() * 997);
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const clothColor = type === "cop" ? 0x1a2b4a : CLOTHES[Math.floor(Math.random() * CLOTHES.length)];
    const skin = [0xf1c8a0, 0xd9a06b, 0x8d5a3c, 0xf3d4b4][Math.floor(Math.random() * 4)];

    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 0.7, 4, 10),
      new THREE.MeshStandardMaterial({ color: clothColor, roughness: 0.8 })
    );
    torso.position.y = 1.05;
    torso.castShadow = true;
    body.add(torso);

    const legs = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.3, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.9 })
    );
    legs.position.y = 0.45;
    legs.castShadow = true;
    body.add(legs);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 12, 12),
      new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 })
    );
    head.position.y = 1.62;
    head.castShadow = true;
    body.add(head);

    if (type === "cop") {
      const helmet = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.28, 0.4, 12),
        new THREE.MeshStandardMaterial({ color: 0x0d1730, roughness: 0.5 })
      );
      helmet.position.y = 1.92;
      body.add(helmet);
      const badge = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffb000, emissiveIntensity: 0.6 })
      );
      badge.position.set(0, 2.02, 0.22);
      body.add(badge);
    }

    // phone (held / stealable)
    const phone = this.makePhone();
    phone.position.set(0.3, 1.05, 0.2);
    phone.visible = type === "civilian";
    g.add(phone);

    // detection marker (hidden by default)
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.4, 1, 4),
      new THREE.MeshBasicMaterial({ color: 0xff2e63, transparent: true, opacity: 0.9 })
    );
    marker.rotation.x = Math.PI;
    marker.position.y = 2.8;
    marker.visible = false;
    g.add(marker);

    const a: Agent = {
      group: g,
      type,
      alive: true,
      hasPhone: type === "civilian",
      phoneMesh: phone,
      wander: this.randomPoint(),
      speed: type === "cop" ? COP_SPEED : rand(2.5, 4),
      trapped: 0,
      stealCd: rand(4, 10),
      fleeing: false,
      marker,
      snatching: false,
      snatchT: 0,
      snatchTarget: null,
      beingSnatched: false,
      path: null,
      gender: this.charModels.genderForVariant(variant),
    };
    g.position.copy(opts?.pos ?? this.randomPoint());
    this.scene.add(g);
    this.registerPerson(g, body, kindFor(type), variant);
    return a;
  }

  /** A held smartphone: the generated model when available, else a glowing slab. */
  private makePhone(): THREE.Object3D {
    if (this.propModels.has("smartphone")) {
      const g = this.propModels.create("smartphone");
      if (g) return g;
    }
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.26, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x111, emissive: 0x55ccff, emissiveIntensity: 0.7 }),
    );
  }

  /** Swap procedural phones for the generated smartphone once it has loaded. */
  private upgradePhones(): void {
    if (!this.propModels.has("smartphone")) return;
    for (const a of [...this.agents, ...this.crowd]) {
      if (!a.hasPhone) continue;
      a.group.remove(a.phoneMesh);
      const phone = this.makePhone();
      phone.position.set(0.3, 1.05, 0.2);
      a.group.add(phone);
      a.phoneMesh = phone;
    }
  }

  /** Toggle the looping snatch animation on a registered person's model. */
  private setSnatchAnim(group: THREE.Object3D, active: boolean): void {
    const p = this.people.find((x) => x.group === group);
    p?.char?.setSnatch(active);
  }

  /** Toggle the "victim resists" animation on a registered person's model. */
  private setResistAnim(group: THREE.Object3D, active: boolean): void {
    const p = this.people.find((x) => x.group === group);
    p?.char?.setResist(active);
  }

  /** Track a person for animated-model upgrade + per-frame locomotion. */
  private registerPerson(group: THREE.Group, body: THREE.Group, kind: CharKind, variant?: number): void {
    const person: Person = { group, body, kind, char: null, prev: group.position.clone(), variant };
    if (this.charModels.ready) this.attachChar(person);
    this.people.push(person);
  }

  private attachChar(person: Person): void {
    const char = this.charModels.create(person.kind, person.variant);
    if (!char) return;
    person.char = char;
    person.body.visible = false; // hide procedural placeholder
    person.group.add(char.root);
  }

  /** Called once generated models finish loading: swap every placeholder. */
  private upgradePeople(): void {
    for (const p of this.people) {
      if (!p.char) this.attachChar(p);
    }
  }

  private removePeopleFor(group: THREE.Object3D): void {
    this.people = this.people.filter((p) => {
      if (p.group !== group) return true;
      p.char?.dispose();
      return false;
    });
  }

  private clearPeople(): void {
    for (const p of this.people) p.char?.dispose();
    this.people = [];
  }

  /** Advance every character's animation mixer, picking locomotion from speed. */
  private updateCharacters(dt: number): void {
    if (dt <= 0) return;
    for (const p of this.people) {
      if (!p.char) continue;
      const dx = p.group.position.x - p.prev.x;
      const dz = p.group.position.z - p.prev.z;
      const speed = Math.sqrt(dx * dx + dz * dz) / dt;
      p.char.update(dt, speed);
      p.prev.set(p.group.position.x, p.group.position.y, p.group.position.z);
    }
  }

  private randomPoint(): THREE.Vector3 {
    return new THREE.Vector3(rand(-HALF_X + 6, HALF_X - 6), 0, rand(-HALF_Z + 6, HALF_Z - 6));
  }

  /* --------------------------- input --------------------------- */

  private bindInput(canvas: HTMLCanvasElement): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("click", this.onCanvasClick);
    this.canvas = canvas;
  }

  private canvas: HTMLCanvasElement | null = null;

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys[e.code] = true;
    if (e.code === "KeyE") this.interactQueued = true;
    if (e.code === "KeyQ") this.powerQueued = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys[e.code] = false;
  };

  private onCanvasClick = (): void => {
    if (this.status !== "playing") return;
    if (!this.pointerLocked && this.canvas) {
      this.canvas.requestPointerLock();
      return;
    }
    this.interactQueued = true;
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    // Losing the pointer lock mid-round (e.g. pressing ESC) opens the pause menu.
    if (!this.pointerLocked && this.status === "playing" && !this.paused) {
      this.paused = true;
      this.pushHud();
    }
  };

  /** Resume a paused round and re-capture the pointer (called from a click). */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.canvas?.requestPointerLock();
    this.pushHud();
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    this.pitch = clamp(this.pitch, -1.2, 1.2);
  };

  /* --------------------------- lifecycle --------------------------- */

  start(): void {
    this.loop();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas?.removeEventListener("click", this.onCanvasClick);
    if (this.online) this.leaveOnline();
    this.renderer.dispose();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  newGame(): void {
    this.online = false;
    this.net = null;
    // clear previous agents
    for (const a of this.agents) this.scene.remove(a.group);
    this.agents = [];
    this.clearPeople();
    for (const p of this.powerups) this.scene.remove(p.group);
    this.powerups = [];
    for (const t of this.traps) this.scene.remove(t.group);
    this.traps = [];
    if (this.copMarker) {
      this.scene.remove(this.copMarker);
      this.copMarker = null;
    }
    if (this.smoke) {
      this.scene.remove(this.smoke);
      this.smoke = null;
    }

    // assign role randomly
    this.role = Math.random() < 0.5 ? "cop" : "snatcher";

    // build population
    const aiSnatchers = this.role === "snatcher" ? 3 : 4;
    this.snatchersTotal = this.role === "snatcher" ? aiSnatchers + 1 : aiSnatchers;
    for (let i = 0; i < aiSnatchers; i++) this.agents.push(this.makePerson("snatcher"));
    if (this.role === "snatcher") this.agents.push(this.makePerson("cop"));
    for (let i = 0; i < 18; i++) this.agents.push(this.makePerson("civilian"));

    // reset state
    this.timeLeft = ROUND_TIME;
    this.phonesStolen = 0;
    this.strikes = 0;
    this.inventory = null;
    this.effects = [];
    this.winner = null;
    this.caught = false;
    this.copSuspicion = 0;
    this.spawnTimer = 5;
    this.playerPos.set(0, EYE, 30);
    this.playerVel.set(0, 0, 0);
    this.yaw = Math.PI;
    this.pitch = 0;

    this.status = "reveal";
    this.pushHud();
  }

  beginRound(): void {
    this.status = "playing";
    this.paused = false;
    this.timeWarned = false;
    this.audio.prime();
    this.audio.play("game_start");
    this.canvas?.requestPointerLock();
    this.pushHud();
  }

  /** Play the panic scream that matches a civilian victim's gender. */
  private playScream(gender: "male" | "female"): void {
    this.audio.play(gender === "female" ? "scream_female" : "scream_male");
  }

  toLobby(): void {
    this.status = "lobby";
    this.paused = false;
    document.exitPointerLock?.();
    this.pushHud();
  }

  /* --------------------------- helpers --------------------------- */

  private aliveSnatchers(): Agent[] {
    return this.agents.filter((a) => a.type === "snatcher" && a.alive);
  }

  private snatchersLeftCount(): number {
    const ai = this.aliveSnatchers().length;
    return this.role === "snatcher" ? ai + (this.caught ? 0 : 1) : ai;
  }

  private fire(toast: string): void {
    this.toast = toast;
    this.toastKey++;
  }

  private endGame(winner: Winner): void {
    this.winner = winner;
    this.status = "gameover";
    this.paused = false;
    document.exitPointerLock?.();
    this.pushHud();
  }

  private givePower(): PowerKind {
    const pool = this.role === "cop" ? COP_POWERS : SNATCHER_POWERS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private hasEffect(kind: PowerKind): boolean {
    return this.effects.some((e) => e.kind === kind);
  }

  /* --------------------------- update --------------------------- */

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.status === "playing" && !this.paused) {
      if (this.online) this.updateOnline(dt);
      else this.update(dt);
    }
    this.updateCamera();
    if (!this.online) this.animateAgents(dt);
    this.updateCharacters(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number): void {
    this.timeLeft -= dt;
    this.checkTimeWarning(this.timeLeft);
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      // time out: the crew failed to snatch every phone in time, so the cop wins
      this.endGame("cop");
      return;
    }

    this.movePlayer(dt);
    this.nearBridge = this.playerPos.z > RIVER_NEAR - 16;
    this.updateEffects(dt);
    this.updateAgents(dt);
    this.updateSnatch(dt);
    this.updatePowerups(dt);
    this.updateBuses(dt);
    this.updateMarkers();
    this.resolveInteract();
    this.resolvePower();
    this.evaluatePrompt();

    // win/lose checks
    if (this.role === "cop") {
      if (this.strikes >= MAX_STRIKES) {
        this.endGame("snatchers");
        return;
      }
      if (this.phonesStolen >= PHONE_TARGET) {
        this.endGame("snatchers");
        return;
      }
      if (this.aliveSnatchers().length === 0) {
        this.endGame("cop");
        return;
      }
    } else {
      if (this.caught) {
        this.endGame("cop");
        return;
      }
      if (this.phonesStolen >= PHONE_TARGET) {
        this.endGame("snatchers");
        return;
      }
    }

    this.pushHud();
  }

  private movePlayer(dt: number): void {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.keys["KeyW"] || this.keys["ArrowUp"]) move.add(forward);
    if (this.keys["KeyS"] || this.keys["ArrowDown"]) move.sub(forward);
    if (this.keys["KeyD"] || this.keys["ArrowRight"]) move.add(right);
    if (this.keys["KeyA"] || this.keys["ArrowLeft"]) move.sub(right);

    const base = this.role === "cop" ? COP_SPEED : SNATCHER_SPEED;
    const speed = base * (this.hasEffect("speed") ? 1.7 : 1);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    // check for trap (snatcher player)
    if (this.role === "snatcher") {
      for (const t of this.traps) {
        if (t.armed && t.pos.distanceTo(this.playerPos) < 1.4) {
          t.armed = false;
          (t.group.children[0] as THREE.Mesh).visible = false;
          this.effects.push({ kind: "trap", remaining: 3, duration: 3 });
          this.fire("You stepped in a bear trap!");
        }
      }
    }
    const frozen = this.effects.some((e) => e.kind === "trap" && this.role === "snatcher");
    if (frozen) move.set(0, 0, 0);

    this.stepPlayer(move.x * dt, move.z * dt);
  }

  /** True if a point lies on a walkable surface. The far bank is still under
   *  development, so the bridge is closed off — players are confined to the
   *  street and can approach, but not cross, the bridge. */
  private isWalkable(x: number, z: number): boolean {
    const W = HALF_X - 0.6;
    if (z >= -HALF_Z + 1 && z <= RIVER_NEAR) return Math.abs(x) <= W; // street
    return false;
  }

  /** Push a point out of every solid static collider (circle-based). */
  private collide(x: number, z: number): { x: number; z: number } {
    const pr = 0.45;
    for (const c of this.colliders) {
      const dx = x - c.x;
      const dz = z - c.z;
      const dist = Math.hypot(dx, dz);
      const minD = c.r + pr;
      if (dist < minD) {
        if (dist > 1e-3) {
          x = c.x + (dx / dist) * minD;
          z = c.z + (dz / dist) * minD;
        } else {
          x = c.x + minD;
        }
      }
    }
    return { x, z };
  }

  /** Move the player by (dx,dz) with wall sliding + solid-prop collision. */
  private stepPlayer(dx: number, dz: number): void {
    const cx = this.playerPos.x;
    const cz = this.playerPos.z;
    let nx = cx + dx;
    let nz = cz + dz;
    if (!this.isWalkable(nx, nz)) {
      // slide along whichever axis stays walkable
      if (this.isWalkable(cx + dx, cz)) nz = cz;
      else if (this.isWalkable(cx, cz + dz)) nx = cx;
      else {
        nx = cx;
        nz = cz;
      }
    }
    const res = this.collide(nx, nz);
    this.playerPos.x = res.x;
    this.playerPos.z = res.z;
  }

  private updateEffects(dt: number): void {
    for (const e of this.effects) e.remaining -= dt;
    const expiredTrack = this.effects.find((e) => e.kind === "track_cop" && e.remaining <= 0);
    if (expiredTrack && this.copMarker) {
      this.scene.remove(this.copMarker);
      this.copMarker = null;
    }
    this.effects = this.effects.filter((e) => e.remaining > 0);
  }

  private updateAgents(dt: number): void {
    const playerGround = new THREE.Vector3(this.playerPos.x, 0, this.playerPos.z);
    const cop = this.role === "snatcher" ? this.agents.find((a) => a.type === "cop" && a.alive) : null;

    // Mark every civilian who is the target of an in-progress snatch this frame
    // so they freeze and play the resist animation.
    for (const a of this.agents) a.beingSnatched = false;
    for (const s of this.agents) {
      if (s.type === "snatcher" && s.alive && s.snatching && s.snatchTarget?.alive) {
        const v = s.snatchTarget;
        v.beingSnatched = true;
        const dir = s.group.position.clone().sub(v.group.position).setY(0);
        if (dir.lengthSq() > 0.01) v.group.rotation.y = Math.atan2(dir.x, dir.z);
      }
    }
    if (this.role === "snatcher" && this.snatchCharge > 0 && this.playerSnatchTarget?.alive) {
      const v = this.playerSnatchTarget;
      v.beingSnatched = true;
      const dir = new THREE.Vector3(this.playerPos.x - v.group.position.x, 0, this.playerPos.z - v.group.position.z);
      if (dir.lengthSq() > 0.01) v.group.rotation.y = Math.atan2(dir.x, dir.z);
    }

    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.trapped > 0) {
        a.trapped -= dt;
        continue;
      }

      // Victim: stand still and struggle while being robbed.
      if (a.beingSnatched) {
        this.setResistAnim(a.group, true);
        continue;
      }
      this.setResistAnim(a.group, false);

      // AI cop behaviour (player is snatcher)
      if (a.type === "cop") {
        this.updateAiCop(a, dt, playerGround);
        continue;
      }

      // AI snatcher behaviour
      if (a.type === "snatcher") {
        if (this.updateAiSnatcher(a, dt, playerGround, cop === null && this.role === "cop")) {
          continue; // standing still mid-snatch
        }
      }

      // wander
      this.wanderAgent(a, dt);
    }
  }

  /** AI snatcher: flee the player cop, or hold a 3s snatch on a nearby civilian.
   *  Returns true while frozen in a snatch (caller skips wandering). */
  private updateAiSnatcher(a: Agent, dt: number, playerGround: THREE.Vector3, copIsPlayer: boolean): boolean {
    a.stealCd -= dt;
    if (copIsPlayer) {
      const d = a.group.position.distanceTo(playerGround);
      a.fleeing = d < 9;
    }

    if (a.snatching) {
      const tgt = a.snatchTarget;
      if (a.fleeing || !tgt || !tgt.hasPhone || !tgt.alive || a.group.position.distanceTo(tgt.group.position) > 3.5) {
        a.snatching = false;
        a.snatchTarget = null;
        this.setSnatchAnim(a.group, false);
        return false;
      }
      // face the victim while snatching
      const dir = tgt.group.position.clone().sub(a.group.position).setY(0);
      if (dir.lengthSq() > 0.01) a.group.rotation.y = Math.atan2(dir.x, dir.z);
      a.snatchT += dt;
      this.setSnatchAnim(a.group, true);
      if (a.snatchT >= SNATCH_TIME) {
        tgt.hasPhone = false;
        tgt.phoneMesh.visible = false;
        a.snatching = false;
        a.snatchTarget = null;
        a.stealCd = rand(9, 16);
        this.setSnatchAnim(a.group, false);
        this.playScream(tgt.gender);
        // AI snatchers are on the snatcher team — their steals count toward the
        // shared team total (matching online), so the HUD/result reflect every
        // phone the crew grabbed, not just the local player's.
        this.phonesStolen++;
      }
      return true;
    }

    if (a.fleeing) {
      const away = a.group.position.clone().sub(playerGround).setY(0).normalize();
      a.wander = a.group.position.clone().add(away.multiplyScalar(8));
      return false;
    }

    if (a.stealCd <= 0) {
      const victim = this.agents.find(
        (c) => c.type === "civilian" && c.alive && c.hasPhone && a.group.position.distanceTo(c.group.position) < 3,
      );
      if (victim) {
        a.snatching = true;
        a.snatchTarget = victim;
        a.snatchT = 0;
      } else {
        a.stealCd = rand(2, 5);
      }
    }
    return false;
  }

  /** Movement keys currently pressed (used to cancel a snatch on the move). */
  private isMovingInput(): boolean {
    return !!(
      this.keys["KeyW"] || this.keys["KeyA"] || this.keys["KeyS"] || this.keys["KeyD"] ||
      this.keys["ArrowUp"] || this.keys["ArrowDown"] || this.keys["ArrowLeft"] || this.keys["ArrowRight"]
    );
  }

  /** Offline: hold E (still, aiming at a civilian with a phone) to snatch over 3s. */
  private updateSnatch(dt: number): void {
    if (this.role !== "snatcher") {
      this.snatchCharge = 0;
      return;
    }
    const frozen = this.effects.some((e) => e.kind === "trap");
    const target = this.nearestAgentInFront();
    const valid =
      !!this.keys["KeyE"] && !this.isMovingInput() && !frozen &&
      !!target && target.type === "civilian" && target.hasPhone;
    if (valid && target) {
      this.playerSnatchTarget = target;
      this.snatchCharge += dt;
      if (this.snatchCharge >= SNATCH_TIME) {
        target.hasPhone = false;
        target.phoneMesh.visible = false;
        this.phonesStolen++;
        this.copSuspicion = Math.min(1, this.copSuspicion + 0.3);
        this.fire(`Phone snatched! ${this.phonesStolen}/${PHONE_TARGET}`);
        this.snatchCharge = 0;
        this.setResistAnim(target.group, false);
        this.playScream(target.gender);
        this.playerSnatchTarget = null;
      }
    } else {
      this.snatchCharge = 0;
      this.playerSnatchTarget = null;
    }
  }

  private updateAiCop(cop: Agent, dt: number, playerGround: THREE.Vector3): void {
    // suspicion rises when player is near or recently stole; falls otherwise
    const dist = cop.group.position.distanceTo(playerGround);
    const invisible = this.hasEffect("invisible");
    let target: THREE.Vector3;

    if (this.decoy && this.decoyTime > 0) {
      target = (this.decoy as THREE.Object3D).position.clone().setY(0);
    } else if (!invisible && this.copSuspicion > 0.4) {
      target = playerGround.clone();
    } else {
      // patrol toward a wandering target
      if (cop.group.position.distanceTo(cop.wander) < 3) cop.wander = this.randomPoint();
      target = cop.wander;
    }

    const dir = target.clone().sub(cop.group.position).setY(0);
    if (dir.lengthSq() > 0.01) {
      dir.normalize();
      const sp = cop.speed * (this.copSuspicion > 0.4 ? 1.05 : 0.8);
      const nx = clamp(cop.group.position.x + dir.x * sp * dt, -HALF_X + 1, HALF_X - 1);
      const nz = clamp(cop.group.position.z + dir.z * sp * dt, -HALF_Z + 2, HALF_Z - 2);
      const res = this.collide(nx, nz);
      cop.group.position.x = res.x;
      cop.group.position.z = res.z;
      cop.group.rotation.y = Math.atan2(dir.x, dir.z);
    }

    // catch the player
    if (!invisible && dist < COP_CATCH_RANGE && this.copSuspicion > 0.3) {
      this.caught = true;
      this.fire("The cop caught you!");
      this.audio.play("apprehend");
    }

    // suspicion decay
    this.copSuspicion = Math.max(0, this.copSuspicion - dt * 0.08);
    if (!invisible && dist < 7) this.copSuspicion = Math.min(1, this.copSuspicion + dt * 0.12);
  }

  private wanderAgent(a: Agent, dt: number): void {
    if (a.group.position.distanceTo(a.wander) < 2) {
      a.wander = this.randomPoint();
      a.fleeing = false;
    }
    const dir = a.wander.clone().sub(a.group.position).setY(0);
    if (dir.lengthSq() > 0.01) {
      dir.normalize();
      const sp = a.speed * (a.fleeing ? 1.8 : 1);
      const nx = clamp(a.group.position.x + dir.x * sp * dt, -HALF_X + 1, HALF_X - 1);
      const nz = clamp(a.group.position.z + dir.z * sp * dt, -HALF_Z + 2, HALF_Z - 2);
      const res = this.collide(nx, nz);
      // if blocked by a solid prop, pick a new wander target next frame
      if (Math.hypot(res.x - nx, res.z - nz) > 0.3) a.wander = this.randomPoint();
      a.group.position.x = res.x;
      a.group.position.z = res.z;
      a.group.rotation.y = Math.atan2(dir.x, dir.z);
    }
  }

  /** Place an online crowd civilian on its deterministic looping route for the
   *  shared wall-clock time `clock` (seconds). All clients compute the same
   *  position, so the cop and snatcher agree on who is being robbed. */
  private steerCrowd(a: Agent, clock: number): void {
    const p = a.path;
    if (!p) {
      this.wanderAgent(a, 0.016);
      return;
    }
    const nx = p.hx + p.rx * Math.sin(clock * p.sx + p.px);
    const nz = p.hz + p.rz * Math.sin(clock * p.sz + p.pz);
    const res = this.collide(nx, nz);
    a.group.position.x = res.x;
    a.group.position.z = res.z;
    // face the direction of travel (rigs face +Z → atan2(vx, vz) is correct).
    const vx = p.rx * p.sx * Math.cos(clock * p.sx + p.px);
    const vz = p.rz * p.sz * Math.cos(clock * p.sz + p.pz);
    if (vx * vx + vz * vz > 1e-6) a.group.rotation.y = Math.atan2(vx, vz);
  }

  private updatePowerups(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.powerups.length < 3) {
      this.spawnTimer = rand(10, 16);
      this.spawnPowerup();
    }
    for (const p of this.powerups) {
      if (p.falling) {
        p.group.position.y -= 9 * dt;
        if (p.group.position.y <= 1) {
          p.group.position.y = 1;
          p.falling = false;
        }
      }
      p.group.rotation.y += dt * 1.5;
      const bob = p.falling ? 0 : Math.sin(performance.now() * 0.003) * 0.15;
      p.group.position.y = (p.falling ? p.group.position.y : 1) + bob;

      // pickup
      const d = new THREE.Vector3(p.group.position.x, 0, p.group.position.z).distanceTo(
        new THREE.Vector3(this.playerPos.x, 0, this.playerPos.z)
      );
      if (!p.falling && d < 2 && this.inventory === null) {
        this.inventory = p.kind;
        this.scene.remove(p.group);
        this.powerups = this.powerups.filter((x) => x !== p);
        this.fire(`Picked up ${POWER_META[p.kind].label}`);
        this.audio.play("powerup_pickup");
      }
    }
    if (this.decoyTime > 0) {
      this.decoyTime -= dt;
      if (this.decoyTime <= 0 && this.decoy) {
        this.scene.remove(this.decoy);
        this.decoy = null;
      }
    }
  }

  private spawnPowerup(): void {
    const kind = this.givePower();
    const g = new THREE.Group();
    const color =
      kind === "speed" ? 0x36e0a0 :
      kind === "invisible" ? 0x8a7dff :
      kind === "track_cop" ? 0x57c7ff :
      kind === "decoy" ? 0xffd24a :
      kind === "reveal" ? 0x57c7ff :
      0xff6b35;
    const gen = this.propModels.ready ? this.propModels.create("crate") : null;
    if (gen) {
      g.add(gen);
    } else {
      const crate = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55, 0),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.3 })
      );
      crate.castShadow = true;
      g.add(crate);
      // parachute
      const chute = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.8 })
      );
      chute.position.y = 1.4;
      g.add(chute);
    }
    // glowing beacon so the supply drop's kind reads at a distance
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4, roughness: 0.2 })
    );
    beacon.position.y = gen ? 1.1 : 0.7;
    g.add(beacon);
    g.position.set(rand(-HALF_X + 6, HALF_X - 6), 28, rand(-HALF_Z + 6, HALF_Z - 6));
    this.scene.add(g);
    this.powerups.push({ kind, group: g, falling: true });
    this.fire("A supply drop is falling!");
  }

  private updateBuses(dt: number): void {
    for (const bus of this.buses) {
      bus.position.z += dt * 5;
      // The riverside end is open (no tunnel), so recycle buses just before the
      // embankment and respawn them hidden deep inside the south tunnel throat.
      if (bus.position.z > RIVER_NEAR - 6) bus.position.z = -HALF_Z - 14;
    }
  }

  private updateThames(dt: number): void {
    const water = this.thamesWater;
    if (!water) return;
    const mat = water.material as THREE.MeshStandardMaterial;
    const map = mat.map;
    if (map) {
      map.offset.x = (map.offset.x + dt * 0.015) % 1;
      map.offset.y = (map.offset.y + dt * 0.03) % 1;
    }
  }

  private updateMarkers(): void {
    // cop tracker marker for snatcher player
    if (this.hasEffect("track_cop")) {
      const cop = this.agents.find((a) => a.type === "cop" && a.alive);
      if (cop) {
        if (!this.copMarker) {
          this.copMarker = new THREE.Mesh(
            new THREE.ConeGeometry(0.5, 1.4, 4),
            new THREE.MeshBasicMaterial({ color: 0x57c7ff })
          );
          this.copMarker.rotation.x = Math.PI;
          this.scene.add(this.copMarker);
        }
        this.copMarker.position.set(cop.group.position.x, 3.6, cop.group.position.z);
      }
    }
    // reveal snatchers markers for cop player
    const reveal = this.hasEffect("reveal");
    for (const a of this.agents) {
      a.marker.visible = reveal && a.type === "snatcher" && a.alive;
    }

    // cop arrow hint: beacons + screen bearings to any AI snatcher mid-snatch
    if (this.role === "cop") {
      const locs = this.agents
        .filter((a) => a.type === "snatcher" && a.alive && a.snatching)
        .map((a) => ({ x: a.group.position.x, z: a.group.position.z }));
      this.updateSnatchHints(locs);
    } else {
      this.updateSnatchHints([]);
    }
  }

  /** Position 3D beacons over each active snatch and compute screen bearings to
   *  them (relative to the camera) for the cop's on-screen arrow hints. */
  private updateSnatchHints(locs: { x: number; z: number }[]): void {
    while (this.snatchBeacons.length < locs.length) {
      const b = new THREE.Mesh(
        new THREE.ConeGeometry(0.6, 1.8, 4),
        new THREE.MeshBasicMaterial({ color: 0xff2e63, transparent: true, opacity: 0.92 }),
      );
      b.rotation.x = Math.PI;
      this.scene.add(b);
      this.snatchBeacons.push(b);
    }
    const bob = Math.sin(performance.now() * 0.006) * 0.3;
    for (let i = 0; i < this.snatchBeacons.length; i++) {
      const b = this.snatchBeacons[i];
      if (i < locs.length) {
        b.visible = true;
        b.position.set(locs[i].x, 3.5 + bob, locs[i].z);
        b.rotation.y += 0.06;
      } else {
        b.visible = false;
      }
    }
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    this.snatchAlerts = locs.map((l) => {
      const dx = l.x - this.playerPos.x;
      const dz = l.z - this.playerPos.z;
      return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
    });
  }

  private resolveInteract(): void {
    if (!this.interactQueued) {
      return;
    }
    this.interactQueued = false;
    // Snatching is a hold-E action handled in updateSnatch; a single press/click
    // only triggers the cop's apprehension.
    if (this.role !== "cop") return;
    const target = this.nearestAgentInFront();
    if (!target) return;
    if (target.type === "snatcher") {
      target.alive = false;
      target.group.visible = false;
      this.fire("Snatcher apprehended!");
      this.audio.play("apprehend");
    } else {
      this.strikes++;
      this.copSuspicion = 0;
      this.fire(`Wrong! ${MAX_STRIKES - this.strikes} mistakes left`);
    }
  }

  private nearestAgentInFront(): Agent | null {
    const eye = new THREE.Vector3(this.playerPos.x, 0, this.playerPos.z);
    const look = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    let best: Agent | null = null;
    let bestD = INTERACT_RANGE;
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (this.role === "cop" && a.type === "cop") continue;
      const to = new THREE.Vector3(a.group.position.x - eye.x, 0, a.group.position.z - eye.z);
      const d = to.length();
      if (d > bestD) continue;
      to.normalize();
      if (to.dot(look) < 0.5) continue;
      best = a;
      bestD = d;
    }
    return best;
  }

  private resolvePower(): void {
    if (!this.powerQueued) {
      return;
    }
    this.powerQueued = false;
    if (this.inventory === null) return;
    const kind = this.inventory;
    this.inventory = null;
    this.audio.play("powerup_use");

    switch (kind) {
      case "speed":
        this.effects.push({ kind, remaining: 8, duration: 8 });
        this.fire("Sprint activated");
        break;
      case "invisible":
        this.effects.push({ kind, remaining: 5, duration: 5 });
        this.copSuspicion = 0;
        this.fire("You vanished");
        break;
      case "track_cop":
        this.effects.push({ kind, remaining: 30, duration: 30 });
        this.fire("Cop tracker online");
        break;
      case "reveal":
        this.effects.push({ kind, remaining: 3, duration: 3 });
        this.fire("Scanning the crowd");
        break;
      case "decoy":
        this.dropDecoy();
        break;
      case "trap":
        this.dropTrap();
        break;
    }
  }

  private dropDecoy(): void {
    if (this.decoy) this.scene.remove(this.decoy);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffaa00, emissiveIntensity: 0.8 })
    );
    const front = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).multiplyScalar(8);
    m.position.set(
      clamp(this.playerPos.x + front.x, -HALF_X + 2, HALF_X - 2),
      0.5,
      clamp(this.playerPos.z + front.z, -HALF_Z + 2, HALF_Z - 2)
    );
    this.scene.add(m);
    this.decoy = m;
    this.decoyTime = 8;
    this.fire("Decoy thrown — cop distracted");
  }

  private dropTrap(): void {
    const g = new THREE.Group();
    const trap = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.12, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.4 })
    );
    trap.rotation.x = -Math.PI / 2;
    trap.position.y = 0.1;
    g.add(trap);
    const front = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).multiplyScalar(3);
    g.position.set(
      clamp(this.playerPos.x + front.x, -HALF_X + 2, HALF_X - 2),
      0,
      clamp(this.playerPos.z + front.z, -HALF_Z + 2, HALF_Z - 2)
    );
    this.scene.add(g);
    const tr: TrapEntity = { group: g, pos: g.position.clone(), armed: true };
    this.traps.push(tr);
    this.fire("Bear trap armed");

    // AI snatchers can step in it (player cop)
    // handled in updateAgents via proximity check below
    this.checkTrapAi = true;
  }

  private checkTrapAi = false;

  private evaluatePrompt(): void {
    let p = "";
    const target = this.nearestAgentInFront();
    if (this.role === "cop" && target && target.type !== "cop") {
      p = "Click / E — Apprehend";
    } else if (this.role === "snatcher" && target && target.type === "civilian" && target.hasPhone) {
      p = this.snatchCharge > 0 ? "Hold E — Snatching…" : "Hold E — Snatch phone";
    }
    this.prompt = p;
  }

  private animateAgents(dt: number): void {
    // bobbing walk
    const t = performance.now() * 0.005;
    for (const a of this.agents) {
      if (!a.alive) continue;
      a.group.position.y = Math.abs(Math.sin(t + a.group.id)) * 0.06;
      // AI snatcher stepping into traps (player cop)
      if (this.checkTrapAi && a.type === "snatcher" && a.alive && a.trapped <= 0) {
        for (const tr of this.traps) {
          if (tr.armed && tr.pos.distanceTo(a.group.position) < 1.4) {
            tr.armed = false;
            (tr.group.children[0] as THREE.Mesh).visible = false;
            a.trapped = 4;
            this.fire("A snatcher hit your trap!");
          }
        }
      }
    }
  }

  private updateCamera(): void {
    this.camera.position.set(this.playerPos.x, EYE, this.playerPos.z);
    const dir = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  /* --------------------------- online --------------------------- */

  /** Enter networked mode: drop AI, build a cosmetic crowd, wait in lobby. */
  enterOnline(net: NetSender, myId: string, crowdSeed?: number): void {
    this.online = true;
    this.net = net;
    this.myId = myId;
    this.role = "snatcher";
    if (crowdSeed !== undefined && crowdSeed > 0) this.crowdSeed = crowdSeed;

    for (const a of this.agents) this.scene.remove(a.group);
    this.agents = [];
    for (const p of this.powerups) this.scene.remove(p.group);
    this.powerups = [];
    for (const t of this.traps) this.scene.remove(t.group);
    this.traps = [];
    this.clearOnlineEntities();
    this.clearPeople();
    this.buildCrowd();

    this.timeLeft = ROUND_TIME;
    this.srvTimeLeft = ROUND_TIME;
    this.srvStrikes = 0;
    this.srvPhones = 0;
    this.srvSnatchersLeft = 0;
    this.srvSnatchersTotal = 0;
    this.phonesStolen = 0;
    this.strikes = 0;
    this.inventory = null;
    this.effects = [];
    this.winner = null;
    this.caught = false;
    this.frozenUntil = 0;
    this.revealIds = [];
    this.trackId = null;
    this.status = "lobby";
    this.pushHud();
  }

  setRole(role: Role, spawn?: { x: number; z: number; yaw: number }): void {
    this.role = role;
    if (spawn) this.pendingSpawn = spawn;
    // fresh round: reset local match flags
    this.inventory = null;
    this.effects = [];
    this.caught = false;
    this.winner = null;
    this.frozenUntil = 0;
    this.revealIds = [];
    this.trackId = null;
    this.pushHud();
  }

  beginOnlineRound(): void {
    this.status = "playing";
    this.paused = false;
    this.timeWarned = false;
    this.audio.prime();
    this.audio.play("game_start");
    const sp = this.pendingSpawn;
    this.playerPos.set(sp?.x ?? 0, EYE, sp?.z ?? 30);
    this.playerVel.set(0, 0, 0);
    this.yaw = sp?.yaw ?? Math.PI;
    this.pitch = 0;
    this.canvas?.requestPointerLock();
    this.pushHud();
  }

  endOnlineMatch(): void {
    this.status = "gameover";
    this.paused = false;
    document.exitPointerLock?.();
    this.pushHud();
  }

  leaveOnline(): void {
    this.status = "lobby";
    document.exitPointerLock?.();
    this.online = false;
    this.net = null;
    this.clearOnlineEntities();
    for (const a of this.crowd) this.scene.remove(a.group);
    this.crowd = [];
    this.pushHud();
  }

  private clearOnlineEntities(): void {
    for (const r of this.remote.values()) this.scene.remove(r.group);
    this.remote.clear();
    for (const g of this.netCrates.values()) this.scene.remove(g);
    this.netCrates.clear();
    for (const g of this.netTraps.values()) this.scene.remove(g);
    this.netTraps.clear();
    for (const g of this.netDecoys.values()) this.scene.remove(g);
    this.netDecoys.clear();
    if (this.copMarker) {
      this.scene.remove(this.copMarker);
      this.copMarker = null;
    }
  }

  /** Build the cosmetic civilian crowd deterministically from the shared seed so
   *  every client sees the SAME people, in the same spots, with the same looks.
   *  Each civilian follows a slow looping route driven by a shared wall clock,
   *  keeping all clients in agreement without per-frame network sync. */
  private buildCrowd(): void {
    for (const a of this.crowd) this.scene.remove(a.group);
    this.crowd = [];
    const rng = mulberry32(this.crowdSeed);
    // Two zones so the world feels alive on BOTH sides of the river: the near
    // street, and the far-bank plaza where Big Ben and the London Eye stand.
    const zones: { count: number; zLo: number; zHi: number }[] = [
      { count: 20, zLo: -HALF_Z + 8, zHi: RIVER_NEAR - 12 }, // near street
      { count: 16, zLo: RIVER_FAR + 8, zHi: FAR_BANK_MAX_Z - 12 }, // far-bank landmarks
    ];
    for (const zone of zones) {
      for (let i = 0; i < zone.count; i++) {
        // home anchored on a walkable surface, clear of pavements/buildings.
        const hx = (rng() * 2 - 1) * (HALF_X - 12);
        const hz = zone.zLo + rng() * (zone.zHi - zone.zLo);
        const path: CrowdPath = {
          hx,
          hz,
          rx: 3 + rng() * 5,
          rz: 3 + rng() * 5,
          sx: 0.18 + rng() * 0.22,
          sz: 0.18 + rng() * 0.22,
          px: rng() * Math.PI * 2,
          pz: rng() * Math.PI * 2,
        };
        const variant = Math.floor(rng() * 997);
        const person = this.makePerson("civilian", {
          variant,
          pos: new THREE.Vector3(hx, 0, hz),
        });
        person.path = path;
        this.crowd.push(person);
      }
    }
  }

  /* --- inbound server messages --- */

  onServerState(s: NetState): void {
    this.srvTimeLeft = s.timeLeft;
    if (this.status === "playing") this.checkTimeWarning(s.timeLeft);
    this.srvStrikes = s.strikes;
    this.srvPhones = s.teamPhones;
    this.srvPhoneTarget = s.phoneTarget;
    this.srvSnatchersLeft = s.snatchersLeft;
    this.srvSnatchersTotal = s.snatchersTotal;
    this.winner = s.winner;
    this.syncRemote(s.players);
    this.syncEntities(s.crates, this.netCrates, () => this.makeCrateMesh());
    this.syncEntities(s.traps, this.netTraps, () => this.makeTrapMesh());
    this.syncEntities(s.decoys, this.netDecoys, () => this.makeDecoyMesh());
    if (this.status === "playing") this.pushHud();
  }

  onIntel(msg: { kind: "reveal"; ids: string[]; until: number } | { kind: "track"; id: string; until: number }): void {
    if (msg.kind === "reveal") {
      this.revealIds = msg.ids;
      this.revealUntil = msg.until;
    } else {
      this.trackId = msg.id;
      this.trackUntil = msg.until;
    }
  }

  onGrant(kind: PowerKind): void {
    if (this.inventory !== null) return;
    this.inventory = kind;
    this.fire(`Picked up ${POWER_META[kind].label}`);
    this.audio.play("powerup_pickup");
    this.pushHud();
  }

  onFrozen(until: number): void {
    this.frozenUntil = until;
    if (!this.effects.some((e) => e.kind === "trap")) {
      this.effects.push({ kind: "trap", remaining: (until - Date.now()) / 1000, duration: 3 });
    }
    this.fire("You stepped in a bear trap!");
  }

  onCaught(): void {
    this.caught = true;
    this.fire("You were apprehended!");
    this.pushHud();
  }

  onEvent(message: string): void {
    this.fire(message);
    this.pushHud();
  }

  /** Server-synced one-shot sound so every client hears the same event. */
  onSfx(name: SfxName): void {
    this.audio.play(name);
  }

  /** Fire the urgent countdown alarm once, when ~10s remain in the round. */
  private checkTimeWarning(timeLeft: number): void {
    if (!this.timeWarned && timeLeft > 0 && timeLeft <= 10) {
      this.timeWarned = true;
      this.audio.play("time_warning");
    }
  }

  /* --- entity sync --- */

  private syncRemote(
    players: { id: string; x: number; z: number; yaw: number; alive: boolean; isCop: boolean; snatching: boolean; invisible: boolean }[],
  ): void {
    const seen = new Set<string>();
    for (const p of players) {
      if (p.id === this.myId) {
        if (!p.alive && !this.caught) this.caught = true;
        continue;
      }
      seen.add(p.id);
      let r = this.remote.get(p.id);
      // Rebuild the avatar if its role identity changed (e.g. it was first
      // created during the lobby as a civilian, then the player became the cop).
      if (r && r.isCop !== p.isCop) {
        this.scene.remove(r.group);
        this.removePeopleFor(r.group);
        this.remote.delete(p.id);
        r = undefined;
      }
      if (!r) {
        // Cop players use the police model so snatchers can identify them;
        // everyone else blends in with the civilian crowd.
        const a = this.makePerson(p.isCop ? "cop" : "civilian");
        r = {
          group: a.group, marker: a.marker, tx: p.x, tz: p.z, tyaw: p.yaw,
          alive: p.alive, isCop: p.isCop, snatching: false, invisible: false,
        };
        a.group.position.set(p.x, 0, p.z);
        this.remote.set(p.id, r);
      }
      r.tx = p.x;
      r.tz = p.z;
      r.tyaw = p.yaw;
      r.alive = p.alive;
      r.invisible = p.invisible;
      // A vanished player disappears for everyone else (the deception power).
      r.group.visible = p.alive && !p.invisible;
      // Play the snatch animation on this avatar for every player to see.
      if (r.snatching !== p.snatching) {
        r.snatching = p.snatching;
        this.setSnatchAnim(r.group, p.snatching && p.alive);
      }
    }
    for (const [id, r] of this.remote) {
      if (!seen.has(id)) {
        this.scene.remove(r.group);
        this.removePeopleFor(r.group);
        this.remote.delete(id);
      }
    }
  }

  private syncEntities(
    list: NetEntity[],
    store: Map<string, THREE.Object3D>,
    make: () => THREE.Object3D,
  ): void {
    const seen = new Set<string>();
    for (const e of list) {
      seen.add(e.id);
      let g = store.get(e.id);
      if (!g) {
        g = make();
        g.position.set(e.x, g.position.y, e.z);
        this.scene.add(g);
        store.set(e.id, g);
      } else {
        g.position.x = e.x;
        g.position.z = e.z;
      }
    }
    for (const [id, g] of store) {
      if (!seen.has(id)) {
        this.scene.remove(g);
        store.delete(id);
      }
    }
  }

  private makeCrateMesh(): THREE.Group {
    const g = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffaa00, emissiveIntensity: 0.7, roughness: 0.3 }),
    );
    crate.castShadow = true;
    g.add(crate);
    const chute = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.8 }),
    );
    chute.position.y = 1.4;
    g.add(chute);
    g.position.y = 1;
    return g;
  }

  private makeTrapMesh(): THREE.Group {
    const g = new THREE.Group();
    const trap = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.12, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.4 }),
    );
    trap.rotation.x = -Math.PI / 2;
    trap.position.y = 0.1;
    g.add(trap);
    g.position.y = 0;
    return g;
  }

  private makeDecoyMesh(): THREE.Group {
    const g = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffaa00, emissiveIntensity: 0.9 }),
    );
    g.add(m);
    g.position.y = 0.5;
    return g;
  }

  /* --- online update loop --- */

  private updateOnline(dt: number): void {
    this.moveOnlinePlayer(dt);
    this.nearBridge = this.playerPos.z > RIVER_NEAR - 16;
    this.updateEffects(dt);

    // throttled position upload (~15Hz)
    this.posSendTimer -= dt;
    if (this.posSendTimer <= 0 && this.net) {
      this.posSendTimer = 1 / 15;
      this.net.sendPos(this.playerPos.x, this.playerPos.z, this.yaw);
    }

    // interpolate remote avatars
    const t = performance.now() * 0.005;
    for (const r of this.remote.values()) {
      if (!r.alive) continue;
      r.group.position.x += (r.tx - r.group.position.x) * Math.min(1, dt * 12);
      r.group.position.z += (r.tz - r.group.position.z) * Math.min(1, dt * 12);
      r.group.position.y = Math.abs(Math.sin(t + r.group.id)) * 0.06;
      // The character rigs face +Z, but the player's look/forward vector points to
      // -Z at yaw 0, so the avatar must face yaw + π to walk forward (not moonwalk).
      const targetYaw = r.tyaw + Math.PI;
      const dy = ((targetYaw - r.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
      r.group.rotation.y += dy * Math.min(1, dt * 10);
    }

    // mark crowd victims: the local player's target plus the nearest civilian to
    // any remote player who is mid-snatch (so the cop sees them stand and resist).
    for (const a of this.crowd) a.beingSnatched = false;
    if (this.role === "snatcher" && this.snatching && this.playerSnatchTarget?.alive) {
      this.playerSnatchTarget.beingSnatched = true;
    }
    for (const r of this.remote.values()) {
      if (!r.snatching || !r.alive) continue;
      let best: Agent | null = null;
      let bestD = 3.5;
      for (const a of this.crowd) {
        const d = a.group.position.distanceTo(r.group.position);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (best) {
        best.beingSnatched = true;
        const dir = r.group.position.clone().sub(best.group.position).setY(0);
        if (dir.lengthSq() > 0.01) best.group.rotation.y = Math.atan2(dir.x, dir.z);
      }
    }

    // cosmetic crowd: deterministic looping route on a shared clock so every
    // client agrees on each civilian's position (victims freeze and resist).
    const clock = Date.now() * 0.001;
    for (const a of this.crowd) {
      if (a.beingSnatched) {
        this.setResistAnim(a.group, true);
      } else {
        this.setResistAnim(a.group, false);
        this.steerCrowd(a, clock);
      }
      a.group.position.y = Math.abs(Math.sin(t + a.group.id)) * 0.06;
    }

    // bob crates
    for (const g of this.netCrates.values()) {
      g.rotation.y += dt * 1.5;
      g.position.y = 1 + Math.sin(performance.now() * 0.003 + g.id) * 0.15;
    }

    this.updateBuses(dt);
    this.resolveOnlinePickup();
    this.resolveOnlineInteract();
    this.updateOnlineSnatch(dt);
    this.resolveOnlinePower();
    this.updateOnlineMarkers();
    this.evaluateOnlinePrompt();
    if (this.snatchCd > 0) this.snatchCd -= dt;
    this.pushHud();
  }

  /** Online: hold E (still, aiming at a civilian) to snatch over 3s. Start/stop
   *  is sent to the server, which is authoritative for the heist score. */
  private updateOnlineSnatch(dt: number): void {
    if (this.role !== "snatcher" || this.caught) {
      if (this.snatching) {
        this.snatching = false;
        this.snatchCharge = 0;
        this.net?.snatchStop();
      }
      return;
    }
    const frozen = Date.now() < this.frozenUntil;
    const target = this.nearestPersonInFront();
    const victim = target && target.kind === "civilian" && target.agent.hasPhone ? target.agent : null;
    const want = !!this.keys["KeyE"] && !this.isMovingInput() && !frozen && !!victim;

    if (want && !this.snatching) {
      this.snatching = true;
      this.snatchCharge = 0;
      this.net?.snatchStart();
    } else if (!want && this.snatching) {
      this.snatching = false;
      this.snatchCharge = 0;
      this.net?.snatchStop();
    }

    this.playerSnatchTarget = this.snatching && victim ? victim : null;
    if (this.snatching && victim) {
      this.snatchCharge += dt;
      if (this.snatchCharge >= SNATCH_TIME) {
        // server credits the team; hide the cosmetic phone locally and reset.
        victim.hasPhone = false;
        victim.phoneMesh.visible = false;
        this.setResistAnim(victim.group, false);
        this.playScream(victim.gender);
        this.snatching = false;
        this.snatchCharge = 0;
        this.playerSnatchTarget = null;
        this.net?.snatchStop();
      }
    }
  }

  private moveOnlinePlayer(dt: number): void {
    if (Date.now() < this.frozenUntil) return;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.keys["KeyW"] || this.keys["ArrowUp"]) move.add(forward);
    if (this.keys["KeyS"] || this.keys["ArrowDown"]) move.sub(forward);
    if (this.keys["KeyD"] || this.keys["ArrowRight"]) move.add(right);
    if (this.keys["KeyA"] || this.keys["ArrowLeft"]) move.sub(right);
    const base = this.role === "cop" ? COP_SPEED : SNATCHER_SPEED;
    const speed = base * (this.hasEffect("speed") ? 1.7 : 1);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
    this.stepPlayer(move.x * dt, move.z * dt);
  }

  private resolveOnlinePickup(): void {
    if (this.inventory !== null || !this.net) return;
    const here = new THREE.Vector3(this.playerPos.x, 0, this.playerPos.z);
    for (const [id, g] of this.netCrates) {
      const d = new THREE.Vector3(g.position.x, 0, g.position.z).distanceTo(here);
      if (d < 2) {
        this.net.pickup(id);
        return;
      }
    }
  }

  private resolveOnlineInteract(): void {
    if (!this.interactQueued) return;
    this.interactQueued = false;
    if (this.caught || !this.net) return;
    // Snatching is a hold-E action handled in updateOnlineSnatch; a press only
    // triggers the cop's apprehension.
    if (this.role !== "cop") return;
    const target = this.nearestPersonInFront();
    if (!target) return;
    this.net.apprehend(target.kind === "player" ? target.id : null);
  }

  private nearestPersonInFront():
    | { kind: "player"; id: string; dist: number }
    | { kind: "civilian"; agent: Agent; dist: number }
    | null {
    const eye = new THREE.Vector3(this.playerPos.x, 0, this.playerPos.z);
    const look = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const range = this.role === "cop" ? 4 : INTERACT_RANGE;
    let best:
      | { kind: "player"; id: string; dist: number }
      | { kind: "civilian"; agent: Agent; dist: number }
      | null = null;
    let bestD = range;
    const consider = (px: number, pz: number): number => {
      const to = new THREE.Vector3(px - eye.x, 0, pz - eye.z);
      const d = to.length();
      if (d > bestD) return -1;
      to.normalize();
      if (to.dot(look) < 0.55) return -1;
      return d;
    };
    for (const [id, r] of this.remote) {
      if (!r.alive) continue;
      const d = consider(r.group.position.x, r.group.position.z);
      if (d >= 0) {
        best = { kind: "player", id, dist: d };
        bestD = d;
      }
    }
    for (const a of this.crowd) {
      if (!a.alive) continue;
      const d = consider(a.group.position.x, a.group.position.z);
      if (d >= 0) {
        best = { kind: "civilian", agent: a, dist: d };
        bestD = d;
      }
    }
    return best;
  }

  private resolveOnlinePower(): void {
    if (!this.powerQueued) return;
    this.powerQueued = false;
    if (this.inventory === null || !this.net) return;
    const kind = this.inventory;
    this.inventory = null;
    this.net.use(kind);
    switch (kind) {
      case "speed":
        this.effects.push({ kind, remaining: 8, duration: 8 });
        this.fire("Sprint activated");
        break;
      case "invisible":
        this.effects.push({ kind, remaining: 5, duration: 5 });
        this.fire("You vanished");
        break;
      case "track_cop":
        this.effects.push({ kind, remaining: 30, duration: 30 });
        this.fire("Cop tracker online");
        break;
      case "reveal":
        this.effects.push({ kind, remaining: 3, duration: 3 });
        this.fire("Scanning the crowd");
        break;
      case "decoy":
        this.fire("Decoy thrown");
        break;
      case "trap":
        this.fire("Bear trap armed");
        break;
    }
  }

  private updateOnlineMarkers(): void {
    const now = Date.now();
    // snatcher tracking the cop
    if (this.trackId && now < this.trackUntil) {
      const r = this.remote.get(this.trackId);
      if (r) {
        if (!this.copMarker) {
          this.copMarker = new THREE.Mesh(
            new THREE.ConeGeometry(0.5, 1.4, 4),
            new THREE.MeshBasicMaterial({ color: 0x57c7ff }),
          );
          this.copMarker.rotation.x = Math.PI;
          this.scene.add(this.copMarker);
        }
        this.copMarker.position.set(r.group.position.x, 3.6, r.group.position.z);
      }
    } else if (this.copMarker) {
      this.scene.remove(this.copMarker);
      this.copMarker = null;
    }
    // cop revealing snatchers
    const revealing = now < this.revealUntil;
    for (const [id, r] of this.remote) {
      r.marker.visible = revealing && this.revealIds.includes(id) && r.alive;
    }

    // cop arrow hint: beacons + screen bearings to any player mid-snatch
    if (this.role === "cop") {
      const locs: { x: number; z: number }[] = [];
      for (const r of this.remote.values()) {
        if (r.snatching && r.alive) locs.push({ x: r.group.position.x, z: r.group.position.z });
      }
      this.updateSnatchHints(locs);
    } else {
      this.updateSnatchHints([]);
    }
  }

  private evaluateOnlinePrompt(): void {
    if (this.caught) {
      this.prompt = "You're out — spectating";
      return;
    }
    let p = "";
    const target = this.nearestPersonInFront();
    if (this.role === "cop" && target) {
      p = "Click / E — Apprehend";
    } else if (this.role === "snatcher" && target && target.kind === "civilian" && target.agent.hasPhone) {
      p = this.snatching ? "Hold E — Snatching…" : "Hold E — Snatch phone";
    }
    this.prompt = p;
  }

  /* --------------------------- hud --------------------------- */

  private pushHud(): void {
    if (this.online) {
      this.pushOnlineHud();
      return;
    }
    const effects: ActiveEffect[] = this.effects.map((e) => ({
      kind: e.kind,
      label: POWER_META[e.kind].label,
      remaining: e.remaining,
      duration: e.duration,
    }));
    this.setHud({
      status: this.status,
      role: this.role,
      timeLeft: Math.ceil(this.timeLeft),
      phonesStolen: this.phonesStolen,
      phoneTarget: PHONE_TARGET,
      snatchersLeft: this.snatchersLeftCount(),
      snatchersTotal: this.snatchersTotal,
      strikes: this.strikes,
      maxStrikes: MAX_STRIKES,
      inventory: this.inventory ? POWER_META[this.inventory] : null,
      effects,
      prompt: this.prompt,
      toast: this.toast,
      toastKey: this.toastKey,
      winner: this.winner,
      caught: this.caught,
      snatchProgress: clamp(this.snatchCharge / SNATCH_TIME, 0, 1),
      snatchAlerts: this.snatchAlerts,
      paused: this.paused,
      nearBridge: this.nearBridge,
    });
  }

  private pushOnlineHud(): void {
    const effects: ActiveEffect[] = this.effects.map((e) => ({
      kind: e.kind,
      label: POWER_META[e.kind].label,
      remaining: e.remaining,
      duration: e.duration,
    }));
    this.setHud({
      status: this.status,
      role: this.role,
      timeLeft: this.srvTimeLeft,
      phonesStolen: this.srvPhones,
      phoneTarget: this.srvPhoneTarget,
      snatchersLeft: this.srvSnatchersLeft,
      snatchersTotal: this.srvSnatchersTotal,
      strikes: this.srvStrikes,
      maxStrikes: MAX_STRIKES,
      inventory: this.inventory ? POWER_META[this.inventory] : null,
      effects,
      prompt: this.prompt,
      toast: this.toast,
      toastKey: this.toastKey,
      winner: this.winner,
      caught: this.caught,
      snatchProgress: clamp(this.snatchCharge / SNATCH_TIME, 0, 1),
      snatchAlerts: this.snatchAlerts,
      paused: this.paused,
      nearBridge: this.nearBridge,
    });
  }
}
