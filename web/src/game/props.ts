import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/* ------------------------------------------------------------------ *
 *  Phone Snatcher — generated static prop models (Meshy GLB)
 *  Loads the London street set pieces (two building facades, a street
 *  lamp, a supply-drop crate and a tiling road slab), normalises each
 *  one (scale / orient / centre / ground) and hands out cheap clones
 *  the engine drops into the world.
 * ------------------------------------------------------------------ */

export type PropKind = "buildingA" | "buildingB" | "lamp" | "crate" | "road";

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
const LAMP = `${R2}/7ed69813-75a1-484b-81eb-9242e1788e66`;
const CRATE = `${R2}/ac60ef7f-de27-41af-9b1b-172c714e7d1b`;
const ROAD = `${R2}/32aba5c0-5798-4a0e-9e7f-8c28c54872b1`;

const PROPS: Record<PropKind, PropDef> = {
  buildingA: { url: `${BUILDING_A}.glb`, fit: "height", size: 18, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  buildingB: { url: `${BUILDING_B}.glb`, fit: "height", size: 18, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  lamp: { url: `${LAMP}.glb`, fit: "height", size: 6, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  crate: { url: `${CRATE}.glb`, fit: "longest", size: 1.3, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
  road: { url: `${ROAD}.glb`, fit: "longest", size: 12, localFrontAxis: "positiveZ", localUpAxis: "positiveY" },
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

  get ready(): boolean {
    return this.loaded;
  }

  /** True only when real generated URLs have been wired in. */
  get enabled(): boolean {
    return !PROPS.buildingA.url.includes("__");
  }

  async load(): Promise<void> {
    if (!this.enabled || this.loaded) return;
    await Promise.all(
      (Object.keys(PROPS) as PropKind[]).map(async (kind) => {
        const def = PROPS[kind];
        const gltf = await this.loader.loadAsync(def.url);
        this.templates.set(kind, this.normalise(gltf.scene, def));
      }),
    );
    this.loaded = true;
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
