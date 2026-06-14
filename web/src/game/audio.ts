/* ------------------------------------------------------------------ *
 *  Phone Snatcher — sound manager
 *  Lightweight one-shot SFX player backed by preloaded <audio> pools.
 *  Browsers block audio until the first user gesture, so the engine
 *  primes() this on the round-start click; every play() before that is
 *  silently ignored.
 * ------------------------------------------------------------------ */

const BASE = "https://r2-pub.rork.com/generated-audio/yfgqeifpmt8941tk7v8l3";

export type SfxName =
  | "scream_male"
  | "scream_female"
  | "powerup_pickup"
  | "powerup_use"
  | "game_start"
  | "time_warning"
  | "apprehend"
  | "smoke_deploy";

const SFX_URL: Record<SfxName, string> = {
  scream_male: `${BASE}/5eb9c27d-c214-43f4-aee8-1dc403d11711.mp3`,
  scream_female: `${BASE}/89ad5e82-840e-46be-afc1-83b17913d842.mp3`,
  powerup_pickup: `${BASE}/574f5d52-05f0-4fb1-b5d3-b123b48b62de.mp3`,
  powerup_use: `${BASE}/0a72e0fa-39bb-4dde-bced-b9ff23b3032a.mp3`,
  game_start: `${BASE}/531c47d0-7077-486f-9aa7-0916a4f5a804.mp3`,
  time_warning: `${BASE}/7252341b-d388-446b-aa0a-8b273a905e8f.mp3`,
  apprehend: `${BASE}/f7992670-11d9-48d0-a9ff-2b2242f8764d.mp3`,
  smoke_deploy: `${BASE}/82ef3149-3fc3-465f-9526-c092fabad469.mp3`,
};

/** Per-sound base volume so screams don't bury UI chimes. */
const SFX_GAIN: Record<SfxName, number> = {
  scream_male: 0.9,
  scream_female: 0.9,
  powerup_pickup: 0.7,
  powerup_use: 0.7,
  game_start: 0.8,
  time_warning: 0.6,
  apprehend: 0.85,
  smoke_deploy: 0.85,
};

/** Small pool per sound so rapid repeats (e.g. two snatches) overlap cleanly. */
const POOL_SIZE = 3;

export class AudioManager {
  private pools = new Map<SfxName, HTMLAudioElement[]>();
  private cursor = new Map<SfxName, number>();
  private unlocked = false;
  private muted = false;

  constructor() {
    if (typeof Audio === "undefined") return;
    (Object.keys(SFX_URL) as SfxName[]).forEach((name) => {
      const pool: HTMLAudioElement[] = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const a = new Audio(SFX_URL[name]);
        a.preload = "auto";
        a.volume = SFX_GAIN[name];
        pool.push(a);
      }
      this.pools.set(name, pool);
      this.cursor.set(name, 0);
    });
  }

  /** Call from a user gesture (round-start click) to satisfy autoplay policy. */
  prime(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    // Nudge every element so the browser marks them as user-initiated.
    this.pools.forEach((pool) => {
      const a = pool[0];
      a.muted = true;
      a.play()
        .then(() => {
          a.pause();
          a.currentTime = 0;
          a.muted = false;
        })
        .catch(() => {
          a.muted = false;
        });
    });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Fire-and-forget one-shot. `volume` (0..1) scales the per-sound gain. */
  play(name: SfxName, volume = 1): void {
    if (this.muted) return;
    const pool = this.pools.get(name);
    if (!pool) return;
    const idx = this.cursor.get(name) ?? 0;
    const a = pool[idx];
    this.cursor.set(name, (idx + 1) % pool.length);
    try {
      a.currentTime = 0;
      a.volume = Math.max(0, Math.min(1, SFX_GAIN[name] * volume));
      void a.play().catch(() => {});
    } catch {
      /* ignore playback races */
    }
  }
}
