import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

/* ------------------------------------------------------------------ *
 *  Phone Snatcher — generated character models (Meshy GLB)
 *  Loads two rigged humanoids (pedestrian + police officer) and their
 *  idle / walk / run clips, then hands out per-instance, individually
 *  animated copies that the engine drops onto each person.
 * ------------------------------------------------------------------ */

export type CharKind = "pedestrian" | "police";

type AxisKey =
  | "positiveX" | "negativeX"
  | "positiveY" | "negativeY"
  | "positiveZ" | "negativeZ";

interface ModelDef {
  /** Rigged GLB URL — this is the skinned visual the clips bind to. */
  rigged: string;
  idle: string;
  walk: string;
  run: string;
  /** Orientation metadata from generation. */
  localFrontAxis: AxisKey;
  localUpAxis: AxisKey;
  /** Target rendered height in metres. */
  height: number;
}

/* === Generated asset URLs (filled in after Meshy generation) === */
const R2 = "https://r2-pub.rork.com/generated-3d-models/yfgqeifpmt8941tk7v8l3";
const PED = `${R2}/b54fd027-6256-4c43-8745-8a276f4cd05f`;
const COP = `${R2}/26944834-1b4f-428c-9055-b28d59b91a45`;

const MODELS: Record<CharKind, ModelDef> = {
  pedestrian: {
    rigged: `${PED}-rigged.glb`,
    idle: `${PED}-anim-idle.glb`,
    walk: `${PED}-anim-casual-walk-inplace.glb`,
    // no dedicated run clip was generated — reuse the walk cycle.
    run: `${PED}-anim-casual-walk-inplace.glb`,
    localFrontAxis: "positiveZ",
    localUpAxis: "positiveY",
    height: 1.8,
  },
  police: {
    rigged: `${COP}-rigged.glb`,
    idle: `${COP}-anim-idle.glb`,
    walk: `${COP}-anim-casual-walk-inplace.glb`,
    run: `${COP}-anim-casual-walk-inplace.glb`,
    localFrontAxis: "positiveZ",
    localUpAxis: "positiveY",
    height: 1.85,
  },
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

/** Skinned-aware bounds (Box3.setFromObject is wrong for rigged meshes). */
function measure(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  const rootInverse = object.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const childBox = new THREE.Box3();
  const toRoot = new THREE.Matrix4();
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const skinned = node as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      skinned.skeleton.update();
      skinned.computeBoundingBox();
      childBox.copy(skinned.boundingBox!);
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      childBox.copy(mesh.geometry.boundingBox!);
    }
    toRoot.multiplyMatrices(rootInverse, mesh.matrixWorld);
    box.union(childBox.applyMatrix4(toRoot));
  });
  return box;
}

interface Template {
  scene: THREE.Group;
  clips: { idle: THREE.AnimationClip; walk: THREE.AnimationClip; run: THREE.AnimationClip };
}

type Locomotion = "idle" | "walk" | "run";

/** A single animated character: add `root` to the person group, drive with update(). */
export class CharacterInstance {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions: Record<Locomotion, THREE.AnimationAction>;
  private state: Locomotion = "idle";

  constructor(tpl: Template, def: ModelDef) {
    const clone = SkeletonUtils.clone(tpl.scene) as THREE.Group;
    clone.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });

    // normalise: scale to target height, correct facing, ground + centre.
    const raw = measure(clone);
    const size = new THREE.Vector3();
    raw.getSize(size);
    const scale = size.y > 0.001 ? def.height / size.y : 1;

    const visual = new THREE.Group();
    visual.scale.setScalar(scale);
    visual.quaternion.copy(orientationCorrection(def.localFrontAxis, def.localUpAxis));
    visual.add(clone);
    visual.updateMatrixWorld(true);

    const fitted = measure(visual);
    const centre = new THREE.Vector3();
    fitted.getCenter(centre);
    visual.position.x -= centre.x;
    visual.position.z -= centre.z;
    visual.position.y -= fitted.min.y;

    this.root.add(visual);

    this.mixer = new THREE.AnimationMixer(clone);
    this.actions = {
      idle: this.mixer.clipAction(tpl.clips.idle),
      walk: this.mixer.clipAction(tpl.clips.walk),
      run: this.mixer.clipAction(tpl.clips.run),
    };
    this.actions.idle.play();
    // desync clips between instances so the crowd doesn't march in lockstep.
    this.mixer.setTime(Math.random() * 2);
  }

  /** Pick locomotion from ground speed (m/s) and advance the mixer. */
  update(dt: number, speed: number): void {
    const next: Locomotion = speed > 5.5 ? "run" : speed > 0.4 ? "walk" : "idle";
    if (next !== this.state) {
      const from = this.actions[this.state];
      const to = this.actions[next];
      to.reset().play();
      from.crossFadeTo(to, 0.22, false);
      this.state = next;
    }
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
  }
}

/** Loads + caches the two character templates, then mints instances. */
export class CharacterModels {
  private loader = new GLTFLoader();
  private templates = new Map<CharKind, Template>();
  private loaded = false;

  get ready(): boolean {
    return this.loaded;
  }

  /** True only when real generated URLs have been wired in. */
  get enabled(): boolean {
    return !MODELS.pedestrian.rigged.startsWith("__");
  }

  async load(): Promise<void> {
    if (!this.enabled || this.loaded) return;
    await Promise.all(
      (Object.keys(MODELS) as CharKind[]).map(async (kind) => {
        const def = MODELS[kind];
        const [rig, idle, walk, run] = await Promise.all([
          this.loader.loadAsync(def.rigged),
          this.loader.loadAsync(def.idle),
          this.loader.loadAsync(def.walk),
          this.loader.loadAsync(def.run),
        ]);
        const idleClip = idle.animations[0].clone();
        idleClip.name = "idle";
        const walkClip = walk.animations[0].clone();
        walkClip.name = "walk";
        const runClip = run.animations[0].clone();
        runClip.name = "run";
        this.templates.set(kind, {
          scene: rig.scene,
          clips: { idle: idleClip, walk: walkClip, run: runClip },
        });
      }),
    );
    this.loaded = true;
  }

  create(kind: CharKind): CharacterInstance | null {
    const tpl = this.templates.get(kind);
    if (!tpl) return null;
    return new CharacterInstance(tpl, MODELS[kind]);
  }
}
