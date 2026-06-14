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
  /** Optional one-shot snatch / pickpocket clip (pedestrian only). */
  snatch?: string;
  /** Orientation metadata from generation. */
  localFrontAxis: AxisKey;
  localUpAxis: AxisKey;
  /** Target rendered height in metres. */
  height: number;
  /** Perceived gender of the look — drives the scream voice on snatch. */
  gender: "male" | "female";
}

/* === Generated asset URLs (filled in after Meshy generation) === */
const R2 = "https://r2-pub.rork.com/generated-3d-models/yfgqeifpmt8941tk7v8l3";
const PED = `${R2}/b54fd027-6256-4c43-8745-8a276f4cd05f`;
const COP = `${R2}/26944834-1b4f-428c-9055-b28d59b91a45`;
// Two extra civilian variants. Snatchers always share the civilian pool, so
// adding looks keeps them indistinguishable while making the crowd varied.
const PED2 = `${R2}/5ffe3f1a-dded-4781-9ab6-77be7e49d7dc`;
const PED3 = `${R2}/0b944e2d-d282-4d75-b779-bf6b18a39184`;

function pedDef(base: string, height: number, gender: "male" | "female"): ModelDef {
  return {
    gender,
    rigged: `${base}-rigged.glb`,
    idle: `${base}-anim-idle.glb`,
    walk: `${base}-anim-casual-walk-inplace.glb`,
    // no dedicated run clip was generated — reuse the walk cycle.
    run: `${base}-anim-casual-walk-inplace.glb`,
    // Collect_Object clip, used as the phone-snatch animation.
    snatch: `${base}-anim-collect-object.glb`,
    // These rigs face +Z (per generation metadata). Orienting to that makes
    // them walk facing forward and face victims while snatching.
    localFrontAxis: "positiveZ",
    localUpAxis: "positiveY",
    height,
  };
}

/** Every interchangeable civilian look. The engine picks one at random per
 *  person, so snatchers and civilians are visually indistinguishable. */
const PEDESTRIAN_VARIANTS: ModelDef[] = [
  pedDef(PED, 1.8, "male"),
  pedDef(PED2, 1.72, "female"),
  pedDef(PED3, 1.82, "male"),
];

const POLICE: ModelDef = {
  gender: "male",
  rigged: `${COP}-rigged.glb`,
  idle: `${COP}-anim-idle.glb`,
  walk: `${COP}-anim-casual-walk-inplace.glb`,
  run: `${COP}-anim-casual-walk-inplace.glb`,
  localFrontAxis: "positiveZ",
  localUpAxis: "positiveY",
  height: 1.85,
};

/** A URL still pointing at a placeholder that has no generated GLB yet. */
function pending(url: string): boolean {
  return url.includes("/PENDING") || url.startsWith("__");
}

/**
 * Meshy "in-place" locomotion clips still bake horizontal root translation into
 * the hip/root bone. Because the engine moves the whole group itself, that baked
 * drift makes the mesh slide away from (and snap back to) its group every loop —
 * the character appears to glide / moonwalk instead of stepping in place.
 *
 * This flattens the horizontal (X/Z) channel of every `.position` track to its
 * first keyframe, leaving only vertical bob and the rotation tracks that drive
 * the actual leg/arm cycle. The result is a clean, planted walk in place.
 */
function stripRootMotion(clip: THREE.AnimationClip): THREE.AnimationClip {
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const values = track.values;
    if (values.length < 3) continue;
    const baseX = values[0];
    const baseZ = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = baseX; // X
      values[i + 2] = baseZ; // Z (keep Y for natural vertical bob)
    }
  }
  return clip;
}

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
  clips: {
    idle: THREE.AnimationClip;
    walk: THREE.AnimationClip;
    run: THREE.AnimationClip;
    snatch: THREE.AnimationClip | null;
  };
}

type AnimState = "idle" | "walk" | "run" | "snatch";

/** A single animated character: add `root` to the person group, drive with update(). */
export class CharacterInstance {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private actions: Partial<Record<AnimState, THREE.AnimationAction>>;
  private state: AnimState = "idle";
  private snatching = false;
  private resisting = false;
  private resistT = 0;

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
    if (tpl.clips.snatch) this.actions.snatch = this.mixer.clipAction(tpl.clips.snatch);
    this.actions.idle!.play();
    // desync clips between instances so the crowd doesn't march in lockstep.
    this.mixer.setTime(Math.random() * 2);
  }

  /** Toggle the looping snatch animation (visible to every player). */
  setSnatch(active: boolean): void {
    this.snatching = active && !!this.actions.snatch;
  }

  /** Toggle the "victim resists" state: feet planted, body twisting/flinching
   *  back as if struggling against a snatcher. Visible to every player. */
  setResist(active: boolean): void {
    if (this.resisting === active) return;
    this.resisting = active;
    if (!active) {
      this.resistT = 0;
      this.root.rotation.set(0, 0, 0);
    }
  }

  /** Pick locomotion from ground speed (m/s) and advance the mixer. */
  update(dt: number, speed: number): void {
    let locomotion = speed;
    if (this.resisting) {
      // Plant the feet (idle legs) and shake the upper body as a struggle.
      this.resistT += dt;
      this.root.rotation.z = Math.sin(this.resistT * 22) * 0.16;
      this.root.rotation.x = -0.12 + Math.sin(this.resistT * 11) * 0.06;
      locomotion = 0;
    }
    const next: AnimState = this.resisting
      ? "idle"
      : this.snatching
        ? "snatch"
        : locomotion > 5.5
          ? "run"
          : locomotion > 0.4
            ? "walk"
            : "idle";
    if (next !== this.state) {
      const from = this.actions[this.state];
      const to = this.actions[next];
      if (to) {
        to.reset().play();
        if (from) from.crossFadeTo(to, 0.18, false);
      }
      this.state = next;
    }
    // Couple the locomotion clip's playback to ground speed so feet track the
    // ground instead of sliding (the "moonwalk"/gliding footskate effect). Each
    // clip has its own natural cadence, so walk and run reference different base
    // speeds — without this, fast players (~7 m/s) clamp the walk cycle and glide.
    if (next === "walk") {
      const active = this.actions.walk;
      if (active) active.timeScale = Math.max(0.7, Math.min(1.9, locomotion / 1.6));
    } else if (next === "run") {
      const active = this.actions.run;
      if (active) active.timeScale = Math.max(0.8, Math.min(1.8, locomotion / 4.6));
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

interface LoadedModel {
  tpl: Template;
  def: ModelDef;
}

/** Loads + caches the character templates (police + a pool of civilian
 *  variants), then mints individually animated instances. */
export class CharacterModels {
  private loader = new GLTFLoader();
  private police: LoadedModel | null = null;
  private pedestrians: LoadedModel[] = [];
  private loaded = false;
  private filesLoaded = 0;
  private filesTotal = 0;

  get ready(): boolean {
    return this.loaded || !this.enabled;
  }

  /** Load progress 0..1 across every character GLB file. */
  get progress(): number {
    if (!this.enabled || this.loaded) return 1;
    return this.filesTotal > 0 ? Math.min(1, this.filesLoaded / this.filesTotal) : 0;
  }

  /** True only when at least one real generated character URL is wired in. */
  get enabled(): boolean {
    return !pending(POLICE.rigged) || PEDESTRIAN_VARIANTS.some((d) => !pending(d.rigged));
  }

  /** Count each GLB toward the load progress as it resolves. */
  private track<T>(p: Promise<T>): Promise<T> {
    return p.then((r) => {
      this.filesLoaded += 1;
      return r;
    });
  }

  private async loadModel(def: ModelDef): Promise<LoadedModel | null> {
    try {
      const [rig, idle, walk, run] = await Promise.all([
        this.track(this.loader.loadAsync(def.rigged)),
        this.track(this.loader.loadAsync(def.idle)),
        this.track(this.loader.loadAsync(def.walk)),
        this.track(this.loader.loadAsync(def.run)),
      ]);
      const idleClip = idle.animations[0].clone();
      idleClip.name = "idle";
      const walkClip = stripRootMotion(walk.animations[0].clone());
      walkClip.name = "walk";
      const runClip = stripRootMotion(run.animations[0].clone());
      runClip.name = "run";
      let snatchClip: THREE.AnimationClip | null = null;
      if (def.snatch) {
        try {
          const snatch = await this.track(this.loader.loadAsync(def.snatch));
          snatchClip = snatch.animations[0].clone();
          snatchClip.name = "snatch";
        } catch (err) {
          console.warn("snatch clip failed", err);
        }
      }
      return {
        def,
        tpl: {
          scene: rig.scene,
          clips: { idle: idleClip, walk: walkClip, run: runClip, snatch: snatchClip },
        },
      };
    } catch (err) {
      console.warn("character model failed to load", def.rigged, err);
      return null;
    }
  }

  async load(): Promise<void> {
    if (!this.enabled || this.loaded) return;
    const pedDefs = PEDESTRIAN_VARIANTS.filter((d) => !pending(d.rigged));
    this.filesTotal =
      (pending(POLICE.rigged) ? 0 : 4) +
      pedDefs.reduce((sum, d) => sum + 4 + (d.snatch ? 1 : 0), 0);
    const [police, ...peds] = await Promise.all([
      pending(POLICE.rigged) ? Promise.resolve(null) : this.loadModel(POLICE),
      ...pedDefs.map((d) => this.loadModel(d)),
    ]);
    this.police = police;
    this.pedestrians = peds.filter((p): p is LoadedModel => p !== null);
    this.loaded = true;
  }

  /** Create an animated instance. Pass a deterministic `variant` index to pick a
   *  specific civilian look so every client renders the same crowd. */
  create(kind: CharKind, variant?: number): CharacterInstance | null {
    if (kind === "police") {
      return this.police ? new CharacterInstance(this.police.tpl, this.police.def) : null;
    }
    if (this.pedestrians.length === 0) return null;
    const idx =
      variant !== undefined
        ? ((variant % this.pedestrians.length) + this.pedestrians.length) % this.pedestrians.length
        : Math.floor(Math.random() * this.pedestrians.length);
    const m = this.pedestrians[idx];
    return new CharacterInstance(m.tpl, m.def);
  }

  /** Gender of the look a given `variant` index resolves to (for scream SFX).
   *  Mirrors create()'s index math so the voice matches the visible model. */
  genderForVariant(variant?: number): "male" | "female" {
    if (this.pedestrians.length === 0) {
      // Models not loaded yet — fall back to the declared variant table.
      const defs = PEDESTRIAN_VARIANTS;
      const i =
        variant !== undefined
          ? ((variant % defs.length) + defs.length) % defs.length
          : 0;
      return defs[i].gender;
    }
    const idx =
      variant !== undefined
        ? ((variant % this.pedestrians.length) + this.pedestrians.length) % this.pedestrians.length
        : 0;
    return this.pedestrians[idx].def.gender;
  }
}
