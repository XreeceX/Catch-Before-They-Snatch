import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/* ------------------------------------------------------------------ *
 *  Phone Snatcher — generated static prop models (Meshy GLB)
 *  Loads the London street set pieces (two building facades, a street
 *  lamp, a supply-drop crate and a tiling road slab), normalises each
 *  one (scale / orient / centre / ground) and hands out cheap clones
 *  the engine drops into the world.
 * ------------------------------------------------------------------ */

export type PropKind =
  | "buildingA"
  | "buildingB"
  | "buildingTall"
  | "buildingWide"
  | "buildingModern"
  | "lamp"
  | "crate"
  | "road"
  | "pavement"
  | "bus"
  | "phonebox"
  | "londonEye"
  | "bigBen"
  | "bridge"
  | "smartphone";

type AxisKey =
  | "positiveX" | "negativeX"
  | "positiveY" | "negativeY"
  | "positiveZ" | "negativeZ";

interface PropDef {
  url: string;
  /** Which dimension `size` refers to. */
  fit: "height" | "longest";
  /** Target rendered size in metres for the chosen dimension. */
  size: number;
  localFrontAxis: AxisKey;
  localUpAxis: AxisKey;
}

/* === Generated asset URLs (filled in after Meshy generation) === */
const R2 = "https://r2-pub.rork.com/generated-3d-models/yfgqeifpmt8941tk7v8l3";
const BUILDING_A = `${R2}/d76fd982-7ff6-4ba0-a8ae-66528e342aa7`;
const BUILDING_B = `${R2}/1a48df9f-9858-4fb6-a449-4e0d1c733cb8`;
// New London building variants (varied heights/widths for the far-bank terraces).
const BUILDING_TALL = `${R2}/024c07c7-c7ae-4b17-8c62-b1beb55d051f`;
const BUILDING_WIDE = `${R2}/340f9eaf-135b-4710-bf2a-a23ec13fe833`;
const BUILDING_MODERN = `${R2}/de3c7d25-2bac-490e-95d7-20023d6f6c80`;
const LAMP = `${R2}/7ed69813-75a1-484b-81eb-9242e1788e66`;
const CRATE = `${R2}/ac60ef7f-de27-41af-9b1b-172c714e7d1b`;
// Wet London street paving (replaces the older road slab for a better surface).
const ROAD = `${R2}/7cc002de-97ec-44b4-8fd4-56934c4f348d`;
// Clean light-grey tiling sidewalk paving slab.
const PAVEMENT = `${R2}/6e2cd9bd-7f29-4d47-9eec-5861ea5bba1c`;
// Westminster-style stone arch bridge across the Thames.
const BRIDGE = `${R2}/1a9b8f21-40ec-4489-934d-b43b6bb328f7`;
// Filled in after Meshy generation completes (see waitTask results). Until then
// these stay PENDING and the loader skips them, so the engine uses procedural
// fallbacks for the bus, phone box, landmarks and smartphone.
const BUS = `${R2}/8a68a2d6-8f4d-40e8-bb26-90d98ceec7ed`;
const PHONEBOX = `${R2}/11364c24-5c42-4181-aca4-3cd935fad8b1`;
const LONDON_EYE = `${R2}/c81e9a27-9a5e-48ad-882e-22ed3dcdda2f`;
const BIG_BEN = `${R2}/ceb61531-356b-415e-93fa-f69f40a0ca52`;
const SMARTPHONE = `${R2}/a624a58d-14d8-4bd7-8f42-74fb0da5c376`;

/** A url that has not yet been wired to a real generated GLB. */
function pending(url: string): boolean {
  return url.startsWith("PENDING");
}

const PROPS: Record<PropKind, PropDef> = {
  buildingA: { url: `${BUILDING_A}.glb`, fit: "height", size: 18, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  buildingB: { url: `${BUILDING_B}.glb`, fit: "height", size: 18, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  buildingTall: { url: `${BUILDING_TALL}.glb`, fit: "height", size: 26, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  buildingWide: { url: `${BUILDING_WIDE}.glb`, fit: "height", size: 14, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  buildingModern: { url: `${BUILDING_MODERN}.glb`, fit: "height", size: 20, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  lamp: { url: `${LAMP}.glb`, fit: "height", size: 6, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  crate: { url: `${CRATE}.glb`, fit: "longest", size: 1.3, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  road: { url: `${ROAD}.glb`, fit: "longest", size: 12, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  // Directionless tiling sidewalk slab; sized so its footprint tiles cleanly.
  pavement: { url: `${PAVEMENT}.glb`, fit: "longest", size: 6, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  // Directionless; sized so its longest (deck) axis fills the river crossing.
  bridge: { url: `${BRIDGE}.glb`, fit: "longest", size: 62, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  // Bus front faces -X; buses travel toward +Z, so the correction maps -X → +Z.
  bus: { url: `${BUS}.glb`, fit: "longest", size: 12, localFrontAxis: "negativeX", localUpAxis: "positiveY" },
  phonebox: { url: `${PHONEBOX}.glb`, fit: "height", size: 2.6, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  // Landmarks are directionless (hasIntrinsicFront=false) — no yaw correction.
  londonEye: { url: `${LONDON_EYE}.glb`, fit: "height", size: 44, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  bigBen: { url: `${BIG_BEN}.glb`, fit: "height", size: 60, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  smartphone: { url: `${SMARTPHONE}.glb`, fit: "longest", size: 0.16, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
};

const AXIS: Record<AxisKey, THREE.Vector3> = {
  positiveX: new THREE.Vector3(1, 0, 0),
  negativeX: new THREE.Vector3(-1, 0, 0),
  positiveY: new THREE.Vector3(0, 1, 0),
  negativeY: new THREE.Vector3(0, -1, 0),
  positiveZ: new THREE.Vector3(0, 0, 1),
  negativeZ: new THREE.Vector3(0, 0, -1),
};

function basisQuat(front: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const f = front.clone().normalize();
  const r = new THREE.Vector3().crossVectors(up, f).normalize();
  const u = new THREE.Vector3().crossVectors(f, r).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, f));
}

/** Rotation so the model's local front axis points to +Z (the engine's facing-0). */
function orientationCorrection(front: AxisKey, up: AxisKey): THREE.Quaternion {
  const local = basisQuat(AXIS[front], AXIS[up]);
  const world = basisQuat(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  return world.multiply(local.invert());
}

export interface PropTemplate {
  /** Normalised visual: front faces +Z, centred on X/Z, grounded on Y=0. */
  visual: THREE.Group;
  /** Footprint + height of the normalised model, in metres. */
  dims: THREE.Vector3;
}

/** Loads + caches every prop template, then mints lightweight clones. */
export class PropModels {
  private loader = new GLTFLoader();
  private templates = new Map<PropKind, PropTemplate>();
  private loaded = false;
  private filesLoaded = 0;
  private filesTotal = 0;

  get ready(): boolean {
    return this.loaded || !this.enabled;
  }

  /** Load progress 0..1 across every prop GLB. */
  get progress(): number {
    if (!this.enabled || this.loaded) return 1;
    return this.filesTotal > 0 ? Math.min(1, this.filesLoaded / this.filesTotal) : 0;
  }

  /** True only when at least one real generated URL has been wired in. */
  get enabled(): boolean {
    return (Object.keys(PROPS) as PropKind[]).some((k) => !pending(PROPS[k].url));
  }

  async load(): Promise<void> {
    if (!this.enabled || this.loaded) return;
    const kinds = (Object.keys(PROPS) as PropKind[]).filter((kind) => !pending(PROPS[kind].url));
    this.filesTotal = kinds.length;
    await Promise.all(
      kinds.map(async (kind) => {
        const def = PROPS[kind];
        try {
          const gltf = await this.loader.loadAsync(def.url);
          this.templates.set(kind, this.normalise(gltf.scene, def));
        } catch (err) {
          console.warn(`prop ${kind} failed to load`, err);
        } finally {
          this.filesLoaded += 1;
        }
      }),
    );
    this.loaded = true;
  }

  /** Whether a given prop kind has a usable generated template loaded. */
  has(kind: PropKind): boolean {
    return this.templates.has(kind);
  }

  private normalise(scene: THREE.Object3D, def: PropDef): PropTemplate {
    const root = scene.clone(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });

    const visual = new THREE.Group();
    visual.quaternion.copy(orientationCorrection(def.localFrontAxis, def.localUpAxis));
    visual.add(root);
    visual.updateMatrixWorld(true);

    // measure after orientation, scale to target, then re-centre + ground.
    let box = new THREE.Box3().setFromObject(visual);
    const size = new THREE.Vector3();
    box.getSize(size);
    const ref = def.fit === "height" ? size.y : Math.max(size.x, size.z);
    const scale = ref > 0.001 ? def.size / ref : 1;
    visual.scale.setScalar(scale);
    visual.updateMatrixWorld(true);

    box = new THREE.Box3().setFromObject(visual);
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    root.position.x -= centre.x / scale;
    root.position.z -= centre.z / scale;
    root.position.y -= box.min.y / scale;
    visual.updateMatrixWorld(true);

    box = new THREE.Box3().setFromObject(visual);
    const dims = new THREE.Vector3();
    box.getSize(dims);
    return { visual, dims };
  }

  /** Footprint + height of a normalised prop (returns zero vector if unloaded). */
  dims(kind: PropKind): THREE.Vector3 {
    return this.templates.get(kind)?.dims.clone() ?? new THREE.Vector3();
  }

  /** A fresh clone of the prop, ready to position. Returns null if unloaded. */
  create(kind: PropKind): THREE.Group | null {
    const tpl = this.templates.get(kind);
    if (!tpl) return null;
    const g = new THREE.Group();
    g.add(tpl.visual.clone(true));
    return g;
  }
}
