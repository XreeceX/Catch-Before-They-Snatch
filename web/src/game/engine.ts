import * as THREE from "three";
import { CharacterModels, CharacterInstance, CharKind } from "./characters";
import { PropModels } from "./props";

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
  | "decoy"
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
}

const POWER_META: Record<PowerKind, PowerMeta> = {
  track_cop: { kind: "track_cop", label: "Cop Tracker", hint: "Reveals the cop for 30s" },
  speed: { kind: "speed", label: "Sprint", hint: "Move faster for 8s" },
  invisible: { kind: "invisible", label: "Vanish", hint: "Untraceable for 5s" },
  decoy: { kind: "decoy", label: "Noise Decoy", hint: "Distract the cop" },
  reveal: { kind: "reveal", label: "Scanner", hint: "Reveals snatchers for 3s" },
  trap: { kind: "trap", label: "Bear Trap", hint: "Drop a trap that freezes a snatcher" },
};

const SNATCHER_POWERS: PowerKind[] = ["track_cop", "speed", "invisible", "decoy"];
const COP_POWERS: PowerKind[] = ["reveal", "speed", "trap"];

/** Minimal surface the engine needs from the netcode client (avoids a circular import). */
export interface NetSender {
  sendPos(x: number, z: number, yaw: number): void;
  snatch(): void;
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
  players: { id: string; x: number; z: number; yaw: number; alive: boolean; isCop: boolean }[];
  crates: NetEntity[];
  traps: NetEntity[];
  decoys: NetEntity[];
}

const ROUND_TIME = 240; // 4 minutes
const PHONE_TARGET = 8;
const MAX_STRIKES = 3;
const HALF_X = 26;
const HALF_Z = 44;
const EYE = 1.7;
const INTERACT_RANGE = 3.2;
const COP_CATCH_RANGE = 2.4;

const CLOTHES = [
  0xb23a48, 0x2e4057, 0x6a8d73, 0xd9a566, 0x8e5572,
  0x3d5a80, 0x9b6a6c, 0x556270, 0xc08552, 0x4a5859,
];

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* ----------------------------- Agent ----------------------------- */

type AgentType = "civilian" | "snatcher" | "cop";

interface Agent {
  group: THREE.Group;
  type: AgentType;
  alive: boolean;
  hasPhone: boolean;
  phoneMesh: THREE.Mesh;
  wander: THREE.Vector3;
  speed: number;
  trapped: number;
  stealCd: number;
  fleeing: boolean;
  marker: THREE.Mesh;
}

/** Visual registry entry: tracks a spawned person's animated Meshy model. */
interface Person {
  group: THREE.Group;
  body: THREE.Group;
  kind: CharKind;
  char: CharacterInstance | null;
  prev: THREE.Vector3;
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
  private interactQueued = false;
  private powerQueued = false;

  // player
  private role: Role = "snatcher";
  private playerPos = new THREE.Vector3(0, EYE, 30);
  private playerVel = new THREE.Vector3();
  private baseSpeed = 7;

  // world
  private agents: Agent[] = [];
  private powerups: Powerup[] = [];
  private traps: TrapEntity[] = [];
  private buses: THREE.Group[] = [];

  // generated character models
  private charModels = new CharacterModels();
  private people: Person[] = [];

  // generated static props (buildings, lamp, crate, road)
  private propModels = new PropModels();
  private streetGroup = new THREE.Group();

  // markers
  private copMarker: THREE.Mesh | null = null;
  private decoy: THREE.Object3D | null = null;
  private decoyTime = 0;

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
  private spawnTimer = 6;
  private copSuspicion = 0; // for snatcher player: how aware AI cop is

  // online
  private online = false;
  private net: NetSender | null = null;
  private myId = "";
  private remote = new Map<string, RemoteAvatar>();
  private crowd: Agent[] = [];
  private netCrates = new Map<string, THREE.Group>();
  private netTraps = new Map<string, THREE.Group>();
  private netDecoys = new Map<string, THREE.Object3D>();
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

  constructor(canvas: HTMLCanvasElement, setHud: (s: HudState) => void) {
    this.setHud = setHud;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fb0c3);
    this.scene.fog = new THREE.Fog(0x9fb0c3, 60, 150);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 400);
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
      .then(() => this.buildStreet())
      .catch((err) => console.warn("prop models failed to load", err));
  }

  /* --------------------------- world --------------------------- */

  private buildWorld(): void {
    // lighting
    const hemi = new THREE.HemisphereLight(0xbcd3ef, 0x4a4036, 0.85);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    sun.position.set(40, 70, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    // street set (road, pavements, buildings, lamps) — rebuilt once
    // generated prop models finish loading.
    this.scene.add(this.streetGroup);
    this.buildStreet();

    // a couple of iconic red buses (slow movers)
    for (let i = 0; i < 2; i++) {
      const bus = this.makeBus();
      bus.position.set((i === 0 ? -1 : 1) * 5, 0, i === 0 ? -10 : 20);
      this.buses.push(bus);
      this.scene.add(bus);
    }

    // sky dome gradient via large sphere
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(200, 24, 16),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })
    );
    const geo = sky.geometry as THREE.SphereGeometry;
    const colors: number[] = [];
    const top = new THREE.Color(0x3b6ea5);
    const bot = new THREE.Color(0xcdd9e3);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 200;
      const col = bot.clone().lerp(top, clamp(y * 0.5 + 0.5, 0, 1));
      colors.push(col.r, col.g, col.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.scene.add(sky);
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
    this.buildRoad();
    this.buildBuildings();
    this.buildLamps();
    this.buildEndCaps();
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

    // pavements
    const pavMat = new THREE.MeshStandardMaterial({ map: pavementTexture(), roughness: 1 });
    pavMat.map!.repeat.set(2, 22);
    for (const side of [-1, 1]) {
      const pav = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, HALF_Z * 2), pavMat);
      pav.position.set(side * (HALF_X - 4), 0.15, 0);
      pav.receiveShadow = true;
      this.streetGroup.add(pav);
    }

    // generated asphalt slabs tiled across the road surface
    if (this.propModels.ready) {
      const dims = this.propModels.dims("road");
      const step = Math.max(dims.x, dims.z, 4) - 0.02;
      for (let x = -HALF_X + step / 2; x < HALF_X - 8; x += step) {
        for (let z = -HALF_Z + step / 2; z < HALF_Z; z += step) {
          const tile = this.propModels.create("road");
          if (!tile) break;
          tile.position.set(x, 0.02, z);
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
    const dimsA = this.propModels.dims("buildingA");
    const dimsB = this.propModels.dims("buildingB");
    const widthA = dimsA.x || 12;
    const widthB = dimsB.x || 12;
    for (const side of [-1, 1]) {
      // side -1 (negative X) facade faces +X (inward) → +90° yaw; side +1 → -90°.
      const yaw = side === -1 ? Math.PI / 2 : -Math.PI / 2;
      let z = -HALF_Z;
      let toggle = Math.random() < 0.5;
      while (z < HALF_Z) {
        const kind = toggle ? "buildingA" : "buildingB";
        const width = toggle ? widthA : widthB;
        const depth = (toggle ? dimsA.z : dimsB.z) || 8;
        const b = this.propModels.create(kind);
        toggle = !toggle;
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
        this.streetGroup.add(this.makeLamp(side * (HALF_X - 6.5), z));
      }
    }
  }

  private buildEndCaps(): void {
    for (const zside of [-1, 1]) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(HALF_X * 2, 30, 2),
        new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 1 })
      );
      wall.position.set(0, 15, zside * (HALF_Z + 1));
      this.streetGroup.add(wall);
    }
  }

  private makeLamp(x: number, z: number): THREE.Group {
    const gen = this.propModels.ready ? this.propModels.create("lamp") : null;
    if (gen) {
      gen.position.set(x, 0, z);
      gen.rotation.y = Math.random() * Math.PI * 2;
      return gen;
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2127, roughness: 0.6, metalness: 0.5 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6, 8), mat);
    post.position.y = 3;
    post.castShadow = true;
    g.add(post);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffcf6e, emissiveIntensity: 1.4 })
    );
    head.position.y = 6;
    g.add(head);
    g.position.set(x, 0, z);
    return g;
  }

  private makeBus(): THREE.Group {
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

  private makePerson(type: AgentType): Agent {
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
    const phone = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.26, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x111, emissive: 0x55ccff, emissiveIntensity: 0.7 })
    );
    phone.position.set(0.32, 1.1, 0.18);
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
      speed: type === "cop" ? 6.2 : rand(2.5, 4),
      trapped: 0,
      stealCd: rand(4, 10),
      fleeing: false,
      marker,
    };
    g.position.copy(this.randomPoint());
    this.scene.add(g);
    this.registerPerson(g, body, kindFor(type));
    return a;
  }

  /** Track a person for animated-model upgrade + per-frame locomotion. */
  private registerPerson(group: THREE.Group, body: THREE.Group, kind: CharKind): void {
    const person: Person = { group, body, kind, char: null, prev: group.position.clone() };
    if (this.charModels.ready) this.attachChar(person);
    this.people.push(person);
  }

  private attachChar(person: Person): void {
    const char = this.charModels.create(person.kind);
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
  };

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
    if (this.decoy) {
      this.scene.remove(this.decoy);
      this.decoy = null;
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
    this.canvas?.requestPointerLock();
    this.pushHud();
  }

  toLobby(): void {
    this.status = "lobby";
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
    if (this.status === "playing") {
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
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      // time out: snatchers win if any remain
      this.endGame(this.snatchersLeftCount() > 0 ? "snatchers" : "cop");
      return;
    }

    this.movePlayer(dt);
    this.updateEffects(dt);
    this.updateAgents(dt);
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

    const speed = this.baseSpeed * (this.hasEffect("speed") ? 1.7 : 1);
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

    this.playerPos.x = clamp(this.playerPos.x + move.x * dt, -HALF_X + 1, HALF_X - 1);
    this.playerPos.z = clamp(this.playerPos.z + move.z * dt, -HALF_Z + 2, HALF_Z - 2);
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

    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.trapped > 0) {
        a.trapped -= dt;
        continue;
      }

      // AI cop behaviour (player is snatcher)
      if (a.type === "cop") {
        this.updateAiCop(a, dt, playerGround);
        continue;
      }

      // AI snatcher behaviour
      if (a.type === "snatcher") {
        a.stealCd -= dt;
        if (this.role === "cop" && cop === null) {
          // flee from player cop if close
          const d = a.group.position.distanceTo(playerGround);
          a.fleeing = d < 9;
        }
        if (a.fleeing) {
          const away = a.group.position.clone().sub(playerGround).setY(0).normalize();
          a.wander = a.group.position.clone().add(away.multiplyScalar(8));
        } else if (a.stealCd <= 0) {
          // try to steal from nearest civilian
          a.stealCd = rand(6, 12);
        }
      }

      // wander
      this.wanderAgent(a, dt);
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
      cop.group.position.x = clamp(cop.group.position.x + dir.x * sp * dt, -HALF_X + 1, HALF_X - 1);
      cop.group.position.z = clamp(cop.group.position.z + dir.z * sp * dt, -HALF_Z + 2, HALF_Z - 2);
      cop.group.rotation.y = Math.atan2(dir.x, dir.z);
    }

    // catch the player
    if (!invisible && dist < COP_CATCH_RANGE && this.copSuspicion > 0.3) {
      this.caught = true;
      this.fire("The cop caught you!");
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
      a.group.position.x = clamp(a.group.position.x + dir.x * sp * dt, -HALF_X + 1, HALF_X - 1);
      a.group.position.z = clamp(a.group.position.z + dir.z * sp * dt, -HALF_Z + 2, HALF_Z - 2);
      a.group.rotation.y = Math.atan2(dir.x, dir.z);
    }
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
      bus.position.z += dt * 4;
      if (bus.position.z > HALF_Z + 6) bus.position.z = -HALF_Z - 6;
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
  }

  private resolveInteract(): void {
    if (!this.interactQueued) {
      return;
    }
    this.interactQueued = false;
    const target = this.nearestAgentInFront();
    if (!target) return;

    if (this.role === "cop") {
      if (target.type === "snatcher") {
        target.alive = false;
        target.group.visible = false;
        this.fire("Snatcher apprehended!");
      } else {
        this.strikes++;
        this.copSuspicion = 0;
        this.fire(`Wrong! ${MAX_STRIKES - this.strikes} mistakes left`);
      }
    } else {
      // snatcher steals a phone from a civilian
      if (target.type === "civilian" && target.hasPhone) {
        target.hasPhone = false;
        target.phoneMesh.visible = false;
        this.phonesStolen++;
        this.copSuspicion = Math.min(1, this.copSuspicion + 0.25);
        this.fire(`Phone snatched! ${this.phonesStolen}/${PHONE_TARGET}`);
      }
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
      p = "Click / E — Snatch phone";
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
  enterOnline(net: NetSender, myId: string): void {
    this.online = true;
    this.net = net;
    this.myId = myId;
    this.role = "snatcher";

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

  setRole(role: Role): void {
    this.role = role;
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
    this.playerPos.set(0, EYE, 30);
    this.playerVel.set(0, 0, 0);
    this.yaw = Math.PI;
    this.pitch = 0;
    this.canvas?.requestPointerLock();
    this.pushHud();
  }

  endOnlineMatch(): void {
    this.status = "gameover";
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

  private buildCrowd(): void {
    for (const a of this.crowd) this.scene.remove(a.group);
    this.crowd = [];
    for (let i = 0; i < 18; i++) this.crowd.push(this.makePerson("civilian"));
  }

  /* --- inbound server messages --- */

  onServerState(s: NetState): void {
    this.srvTimeLeft = s.timeLeft;
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

  /* --- entity sync --- */

  private syncRemote(players: { id: string; x: number; z: number; yaw: number; alive: boolean; isCop: boolean }[]): void {
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
        r = { group: a.group, marker: a.marker, tx: p.x, tz: p.z, tyaw: p.yaw, alive: p.alive, isCop: p.isCop };
        a.group.position.set(p.x, 0, p.z);
        this.remote.set(p.id, r);
      }
      r.tx = p.x;
      r.tz = p.z;
      r.tyaw = p.yaw;
      r.alive = p.alive;
      r.group.visible = p.alive;
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
      const dy = ((r.tyaw - r.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
      r.group.rotation.y += dy * Math.min(1, dt * 10);
    }

    // cosmetic crowd wander
    for (const a of this.crowd) {
      this.wanderAgent(a, dt);
      a.group.position.y = Math.abs(Math.sin(t + a.group.id)) * 0.06;
    }

    // bob crates
    for (const g of this.netCrates.values()) {
      g.rotation.y += dt * 1.5;
      g.position.y = 1 + Math.sin(performance.now() * 0.003 + g.id) * 0.15;
    }

    this.resolveOnlinePickup();
    this.resolveOnlineInteract();
    this.resolveOnlinePower();
    this.updateOnlineMarkers();
    this.evaluateOnlinePrompt();
    if (this.snatchCd > 0) this.snatchCd -= dt;
    this.pushHud();
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
    const speed = this.baseSpeed * (this.hasEffect("speed") ? 1.7 : 1);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
    this.playerPos.x = clamp(this.playerPos.x + move.x * dt, -HALF_X + 1, HALF_X - 1);
    this.playerPos.z = clamp(this.playerPos.z + move.z * dt, -HALF_Z + 2, HALF_Z - 2);
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
    const target = this.nearestPersonInFront();
    if (this.role === "cop") {
      if (!target) return;
      this.net.apprehend(target.kind === "player" ? target.id : null);
    } else {
      if (this.snatchCd > 0) return;
      if (target && target.kind === "civilian" && target.agent.hasPhone) {
        target.agent.hasPhone = false;
        target.agent.phoneMesh.visible = false;
        this.snatchCd = 0.8;
        this.net.snatch();
      }
    }
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
      p = "Click / E — Snatch phone";
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
    });
  }
}
