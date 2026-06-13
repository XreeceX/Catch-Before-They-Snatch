import { useCallback, useEffect, useRef, useState } from "react";
import {
  Shield,
  Footprints,
  Play,
  Clock,
  Smartphone,
  AlertTriangle,
  Users,
  Zap,
  Eye,
  EyeOff,
  Radar,
  Volume2,
  Magnet,
  Package,
  Globe,
  Bot,
  ArrowLeft,
  ArrowUp,
  Crown,
  Plus,
  Loader2,
  WifiOff,
  Copy,
  Check,
  Pause,
  LogOut,
} from "lucide-react";

import { GameEngine, type HudState, type PowerKind, type Role } from "@/game/engine";
import {
  NetClient,
  fetchRooms,
  makeRoomId,
  normalizeRoomId,
  type ConnState,
  type LobbyPlayer,
  type RoomSummary,
  type ServerMessage,
} from "@/game/net";

const INITIAL_HUD: HudState = {
  status: "lobby",
  role: "snatcher",
  timeLeft: 240,
  phonesStolen: 0,
  phoneTarget: 12,
  snatchersLeft: 4,
  snatchersTotal: 4,
  strikes: 0,
  maxStrikes: 3,
  inventory: null,
  effects: [],
  prompt: "",
  toast: "",
  toastKey: 0,
  winner: null,
  caught: false,
  snatchProgress: 0,
  snatchAlerts: [],
  paused: false,
};

const POWER_ICON: Record<PowerKind, typeof Zap> = {
  track_cop: Radar,
  speed: Zap,
  invisible: EyeOff,
  decoy: Volume2,
  reveal: Eye,
  trap: Magnet,
};

type AppMode = "menu" | "practice" | "online";
type OnlineScreen = "browser" | "lobby" | "reveal" | "playing" | "gameover";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const Index = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [mode, setMode] = useState<AppMode>("menu");
  const [loadProgress, setLoadProgress] = useState(0);
  const [assetsReady, setAssetsReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new GameEngine(canvas, setHud);
    engineRef.current = engine;
    engine.start();
    const onResize = (): void => engine.resize();
    window.addEventListener("resize", onResize);

    // Poll asset-load progress and only reveal the menu once everything is ready.
    const poll = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      setLoadProgress(e.assetProgress);
      if (e.assetsReady) {
        setLoadProgress(1);
        setAssetsReady(true);
        window.clearInterval(poll);
      }
    }, 120);

    return () => {
      window.removeEventListener("resize", onResize);
      window.clearInterval(poll);
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(130% 100% at 50% 38%, transparent 58%, rgba(5,8,15,0.6) 100%)",
        }}
      />

      {!assetsReady && <LoadingScreen progress={loadProgress} />}
      {assetsReady && mode === "menu" && (
        <MainMenu onPractice={() => setMode("practice")} onOnline={() => setMode("online")} />
      )}
      {assetsReady && mode === "practice" && (
        <Practice hud={hud} engineRef={engineRef} onExit={() => setMode("menu")} />
      )}
      {assetsReady && mode === "online" && (
        <Online hud={hud} engineRef={engineRef} onExit={() => setMode("menu")} />
      )}
    </div>
  );
};

/* ----------------------------- Loading screen ----------------------------- */

const LoadingScreen = ({ progress }: { progress: number }) => {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 px-8 text-center backdrop-blur-sm">
      <div className="animate-pop-in w-full max-w-sm">
        <p className="font-display text-xs uppercase tracking-[0.4em] text-secondary text-glow-cyan">
          Streets of London
        </p>
        <h1 className="mt-3 font-display text-5xl font-extrabold uppercase leading-[0.85] tracking-tight">
          <span className="block text-foreground text-glow-pink">Phone</span>
          <span className="block text-secondary text-glow-cyan">Snatcher</span>
        </h1>

        <div className="mt-10 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 size={16} className="animate-spin text-primary" />
          <span className="font-display text-[11px] font-bold uppercase tracking-widest">
            Loading the city…
          </span>
        </div>

        <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full border border-white/12 bg-card/70">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
            style={{
              width: `${pct}%`,
              boxShadow: "0 0 16px hsl(327 96% 60% / 0.8)",
            }}
          />
        </div>
        <p className="mt-2 font-display text-sm font-extrabold tabular-nums text-foreground">
          {pct}%
        </p>
      </div>
    </div>
  );
};

/* ----------------------------- Main menu ----------------------------- */

const MainMenu = ({ onPractice, onOnline }: { onPractice: () => void; onOnline: () => void }) => (
  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
    <div className="animate-pop-in max-w-md">
      <p className="font-display text-xs uppercase tracking-[0.4em] text-secondary text-glow-cyan">
        Streets of London
      </p>
      <h1 className="mt-3 font-display text-6xl font-extrabold uppercase leading-[0.85] tracking-tight sm:text-7xl">
        <span className="block text-foreground text-glow-pink">Phone</span>
        <span className="block text-secondary text-glow-cyan">Snatcher</span>
      </h1>
      <p className="mx-auto mt-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
        A 3D street of deception. One <span className="font-bold text-secondary">Cop</span> hunts
        the crowd. The rest are <span className="font-bold text-primary">Snatchers</span> hiding in
        plain sight. Blend in, steal phones, don't get caught.
      </p>

      <div className="mx-auto mt-9 flex w-full max-w-xs flex-col gap-3">
        <button
          onClick={onOnline}
          className="pointer-events-auto group inline-flex items-center justify-center gap-2 rounded-full bg-primary px-8 py-4 font-display text-lg font-extrabold uppercase tracking-wider text-primary-foreground transition-transform duration-150 hover:scale-105 active:scale-95"
          style={{ boxShadow: "0 0 30px hsl(327 96% 60% / 0.6)" }}
        >
          <Globe size={20} />
          Play Online
        </button>
        <button
          onClick={onPractice}
          className="pointer-events-auto inline-flex items-center justify-center gap-2 rounded-full border border-secondary/40 bg-secondary/10 px-8 py-3.5 font-display text-base font-bold uppercase tracking-wider text-secondary transition-colors hover:bg-secondary/20"
        >
          <Bot size={18} />
          Practice vs Bots
        </button>
      </div>
    </div>
  </div>
);

/* ----------------------------- Practice (vs AI) ----------------------------- */

const Practice = ({
  hud,
  engineRef,
  onExit,
}: {
  hud: HudState;
  engineRef: React.MutableRefObject<GameEngine | null>;
  onExit: () => void;
}) => {
  const isCop = hud.role === "cop";

  useEffect(() => {
    engineRef.current?.newGame();
  }, [engineRef]);

  const handleBegin = useCallback((): void => engineRef.current?.beginRound(), [engineRef]);
  const handleAgain = useCallback((): void => engineRef.current?.newGame(), [engineRef]);
  const handleHome = useCallback((): void => {
    engineRef.current?.toLobby();
    onExit();
  }, [engineRef, onExit]);

  return (
    <>
      {hud.status === "playing" && <Crosshair />}
      {hud.status === "playing" && <SnatchProgress progress={hud.snatchProgress} />}
      {hud.status === "playing" && isCop && <SnatchAlerts bearings={hud.snatchAlerts} />}
      {hud.status === "playing" && <Toast text={hud.toast} k={hud.toastKey} />}
      {hud.status === "playing" && <InGameHud hud={hud} isCop={isCop} />}
      {hud.status === "playing" && hud.paused && (
        <PauseMenu
          onResume={() => engineRef.current?.resume()}
          onExit={handleHome}
        />
      )}
      {hud.status === "reveal" && <RoleReveal hud={hud} isCop={isCop} onBegin={handleBegin} />}
      {hud.status === "gameover" && (
        <Results hud={hud} isCop={isCop} onAgain={handleAgain} onHome={handleHome} hostControls />
      )}
    </>
  );
};

/* ----------------------------- Online ----------------------------- */

const Online = ({
  hud,
  engineRef,
  onExit,
}: {
  hud: HudState;
  engineRef: React.MutableRefObject<GameEngine | null>;
  onExit: () => void;
}) => {
  const [screen, setScreen] = useState<OnlineScreen>("browser");
  const screenRef = useRef<OnlineScreen>("browser");
  const setScreenSafe = useCallback((s: OnlineScreen): void => {
    screenRef.current = s;
    setScreen(s);
  }, []);

  const [name, setName] = useState<string>(
    () => localStorage.getItem("ps_name") ?? "",
  );
  const [conn, setConn] = useState<ConnState>("connecting");
  const [lobby, setLobby] = useState<{ players: LobbyPlayer[]; hostId: string | null }>({
    players: [],
    hostId: null,
  });
  const [role, setRole] = useState<Role>("snatcher");
  const [roomId, setRoomId] = useState<string>("");
  const netRef = useRef<NetClient | null>(null);
  const myIdRef = useRef<string>("");

  const handleMessage = useCallback(
    (msg: ServerMessage): void => {
      const engine = engineRef.current;
      if (!engine) return;
      switch (msg.t) {
        case "welcome":
          myIdRef.current = msg.you;
          if (netRef.current) engine.enterOnline(netRef.current, msg.you, msg.crowdSeed);
          break;
        case "lobby":
          setLobby({ players: msg.players, hostId: msg.hostId });
          if (msg.status === "lobby" && screenRef.current === "gameover") {
            setScreenSafe("lobby");
          }
          break;
        case "role":
          setRole(msg.role);
          engine.setRole(msg.role);
          setScreenSafe("reveal");
          break;
        case "state":
          engine.onServerState(msg);
          if (msg.status === "gameover" && screenRef.current !== "gameover") {
            engine.endOnlineMatch();
            setScreenSafe("gameover");
          }
          break;
        case "intel":
          engine.onIntel(msg);
          break;
        case "grant":
          engine.onGrant(msg.kind);
          break;
        case "frozen":
          engine.onFrozen(msg.until);
          break;
        case "caught":
          engine.onCaught();
          break;
        case "event":
          engine.onEvent(msg.message);
          break;
        case "sfx":
          engine.onSfx(msg.name);
          break;
      }
    },
    [engineRef, setScreenSafe],
  );

  const join = useCallback(
    (roomId: string): void => {
      const cleanName = name.trim() || `Player${Math.floor(Math.random() * 90 + 10)}`;
      localStorage.setItem("ps_name", cleanName);
      setRoomId(roomId);
      const client = new NetClient(roomId, cleanName, handleMessage, setConn);
      netRef.current = client;
      client.connect();
      setLobby({ players: [], hostId: null });
      setScreenSafe("lobby");
    },
    [name, handleMessage, setScreenSafe],
  );

  const leave = useCallback((): void => {
    netRef.current?.disconnect();
    netRef.current = null;
    engineRef.current?.leaveOnline();
    onExit();
  }, [engineRef, onExit]);

  useEffect(() => {
    return () => {
      netRef.current?.disconnect();
      netRef.current = null;
    };
  }, []);

  const isCop = role === "cop";
  const amHost = lobby.hostId !== null && lobby.hostId === myIdRef.current;

  const handleStart = useCallback((): void => netRef.current?.start(), []);
  const handleEnter = useCallback((): void => {
    engineRef.current?.beginOnlineRound();
    setScreenSafe("playing");
  }, [engineRef, setScreenSafe]);

  return (
    <>
      {screen === "playing" && <Crosshair />}
      {screen === "playing" && <SnatchProgress progress={hud.snatchProgress} />}
      {screen === "playing" && isCop && <SnatchAlerts bearings={hud.snatchAlerts} />}
      {screen === "playing" && <Toast text={hud.toast} k={hud.toastKey} />}
      {screen === "playing" && <InGameHud hud={hud} isCop={isCop} />}
      {screen === "playing" && hud.paused && (
        <PauseMenu onResume={() => engineRef.current?.resume()} onExit={leave} exitLabel="Leave Match" />
      )}

      {screen === "browser" && (
        <Browser name={name} setName={setName} onJoin={join} onBack={onExit} />
      )}
      {screen === "lobby" && (
        <LobbyScreen
          lobby={lobby}
          conn={conn}
          amHost={amHost}
          myId={myIdRef.current}
          roomId={roomId}
          onStart={handleStart}
          onLeave={leave}
        />
      )}
      {screen === "reveal" && (
        <RoleReveal hud={{ ...hud, role }} isCop={isCop} onBegin={handleEnter} />
      )}
      {screen === "gameover" && (
        <Results
          hud={hud}
          isCop={isCop}
          onAgain={handleStart}
          onHome={leave}
          hostControls={amHost}
        />
      )}

      {conn !== "open" && screen !== "browser" && <ConnBanner conn={conn} />}
    </>
  );
};

const ConnBanner = ({ conn }: { conn: ConnState }) => (
  <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2">
    <div className="flex items-center gap-2 rounded-full border border-destructive/40 bg-card/90 px-4 py-1.5 backdrop-blur">
      {conn === "connecting" ? (
        <Loader2 size={14} className="animate-spin text-secondary" />
      ) : (
        <WifiOff size={14} className="text-destructive" />
      )}
      <span className="font-display text-[11px] font-bold uppercase tracking-wider text-foreground">
        {conn === "connecting" ? "Connecting…" : "Reconnecting…"}
      </span>
    </div>
  </div>
);

/* ----------------------------- Pause menu ----------------------------- */

const PauseMenu = ({
  onResume,
  onExit,
  exitLabel = "Exit to Menu",
}: {
  onResume: () => void;
  onExit: () => void;
  exitLabel?: string;
}) => (
  <div className="absolute inset-0 z-40 flex items-center justify-center px-6">
    <div
      className="absolute inset-0 bg-background/70 backdrop-blur-md"
      style={{ background: "radial-gradient(120% 90% at 50% 40%, rgba(8,11,20,0.55), rgba(3,5,11,0.88))" }}
    />
    <div className="animate-pop-in pointer-events-auto relative w-full max-w-xs rounded-3xl border border-white/12 bg-card/80 p-7 text-center shadow-2xl backdrop-blur-xl">
      <div
        className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-secondary/15 text-secondary"
        style={{ boxShadow: "0 0 26px hsl(186 92% 55% / 0.35)" }}
      >
        <Pause size={26} />
      </div>
      <h2 className="mt-4 font-display text-3xl font-extrabold uppercase tracking-tight text-foreground">
        Paused
      </h2>
      <p className="mt-1 text-xs uppercase tracking-[0.3em] text-muted-foreground">
        Streets of London
      </p>

      <div className="mt-7 flex flex-col gap-3">
        <button
          onClick={onResume}
          className="group inline-flex items-center justify-center gap-2 rounded-full bg-primary px-8 py-4 font-display text-lg font-extrabold uppercase tracking-wider text-primary-foreground transition-transform duration-150 hover:scale-105 active:scale-95"
          style={{ boxShadow: "0 0 30px hsl(327 96% 60% / 0.55)" }}
        >
          <Play size={20} />
          Continue
        </button>
        <button
          onClick={onExit}
          className="inline-flex items-center justify-center gap-2 rounded-full border border-white/12 bg-white/5 px-8 py-3.5 font-display text-base font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <LogOut size={18} />
          {exitLabel}
        </button>
      </div>
      <p className="mt-5 text-[11px] text-muted-foreground">
        Press <span className="font-bold text-foreground">Esc</span> to pause anytime
      </p>
    </div>
  </div>
);

/* ----------------------------- Server browser ----------------------------- */

const Browser = ({
  name,
  setName,
  onJoin,
  onBack,
}: {
  name: string;
  setName: (s: string) => void;
  onJoin: (roomId: string) => void;
  onBack: () => void;
}) => {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const cleanCode = normalizeRoomId(code);
  const canJoin = cleanCode.length >= 4;

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      const list = await fetchRooms();
      if (active) {
        setRooms(list);
        setLoading(false);
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center overflow-y-auto px-5 py-8">
      <div className="animate-pop-in flex w-full max-w-md flex-col">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="pointer-events-auto grid h-10 w-10 place-items-center rounded-full border border-white/12 bg-card/60 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="font-display text-2xl font-extrabold uppercase tracking-tight text-foreground">
            Find a match
          </h2>
        </div>

        <label className="mt-6 block font-display text-[11px] uppercase tracking-widest text-muted-foreground">
          Your name
        </label>
        <input
          value={name}
          maxLength={16}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter a name"
          className="pointer-events-auto mt-2 w-full rounded-xl border border-white/12 bg-card/70 px-4 py-3 font-display text-base font-bold text-foreground outline-none backdrop-blur placeholder:text-muted-foreground/50 focus:border-primary/60"
        />

        <div className="mt-6 rounded-2xl border border-primary/30 bg-primary/[0.06] p-5">
          <p className="font-display text-[11px] uppercase tracking-widest text-primary">
            Host a game
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Creates a private lobby with a shareable code. Send it to friends so
            they can jump in.
          </p>
          <button
            onClick={() => onJoin(makeRoomId())}
            disabled={!name.trim()}
            className="pointer-events-auto mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-8 py-3.5 font-display text-base font-extrabold uppercase tracking-wider text-primary-foreground transition-transform duration-150 enabled:hover:scale-105 enabled:active:scale-95 disabled:opacity-40"
            style={{ boxShadow: "0 0 24px hsl(327 96% 60% / 0.5)" }}
          >
            <Plus size={18} />
            Create Lobby
          </button>
        </div>

        <div className="mt-4 rounded-2xl border border-secondary/30 bg-secondary/[0.06] p-5">
          <p className="font-display text-[11px] uppercase tracking-widest text-secondary">
            Join with a code
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Got a code from a friend? Enter it to join their lobby.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={code}
              maxLength={4}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setCode(normalizeRoomId(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canJoin) onJoin(cleanCode);
              }}
              placeholder="CODE"
              className="pointer-events-auto w-full rounded-xl border border-white/12 bg-card/70 px-4 py-3 text-center font-display text-xl font-extrabold uppercase tracking-[0.5em] text-foreground outline-none backdrop-blur placeholder:tracking-[0.3em] placeholder:text-muted-foreground/40 focus:border-secondary/60"
            />
            <button
              onClick={() => canJoin && onJoin(cleanCode)}
              disabled={!canJoin}
              className="pointer-events-auto shrink-0 rounded-xl border border-secondary/50 bg-secondary/15 px-6 font-display text-sm font-extrabold uppercase tracking-wider text-secondary transition-colors enabled:hover:bg-secondary/25 disabled:opacity-40"
            >
              Join
            </button>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between">
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Public rooms
          </p>
          {loading && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {rooms.length === 0 && !loading && (
            <div className="rounded-xl border border-dashed border-white/12 bg-card/40 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No open rooms. Create one and share the screen with friends to play together.
              </p>
            </div>
          )}
          {rooms.map((r) => {
            const full = r.playerCount >= r.maxPlayers;
            const joinable = r.status === "open" && !full;
            return (
              <button
                key={r.roomId}
                disabled={!joinable}
                onClick={() => onJoin(r.roomId)}
                className={`pointer-events-auto flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
                  joinable
                    ? "border-white/12 bg-card/60 hover:border-primary/50"
                    : "border-white/8 bg-card/30 opacity-60"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate font-display text-sm font-bold text-foreground">
                    {r.playerNames.slice(0, 3).join(", ") || "Room"}
                    {r.playerNames.length > 3 ? "…" : ""}
                  </p>
                  <p className="font-display text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    {r.roomId.toUpperCase()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`font-display text-[10px] font-bold uppercase tracking-wider ${
                      r.status === "live" ? "text-secondary" : "text-primary"
                    }`}
                  >
                    {full ? "Full" : r.status === "live" ? "Live" : "Open"}
                  </span>
                  <span className="flex items-center gap-1 font-display text-sm font-bold tabular-nums text-foreground">
                    <Users size={14} className="opacity-70" />
                    {r.playerCount}/{r.maxPlayers}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/* ----------------------------- Lobby (online) ----------------------------- */

const LobbyScreen = ({
  lobby,
  conn,
  amHost,
  myId,
  roomId,
  onStart,
  onLeave,
}: {
  lobby: { players: LobbyPlayer[]; hostId: string | null };
  conn: ConnState;
  amHost: boolean;
  myId: string;
  roomId: string;
  onStart: () => void;
  onLeave: () => void;
}) => {
  const enough = lobby.players.length >= 2;
  const [copied, setCopied] = useState(false);
  const code = roomId.toUpperCase();
  const copyCode = useCallback((): void => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  }, [code]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
      <div className="animate-pop-in w-full max-w-md rounded-3xl border border-white/10 bg-card/85 p-8 shadow-2xl">
        <p className="font-display text-xs uppercase tracking-[0.3em] text-secondary">
          Waiting room
        </p>
        <h2 className="mt-2 font-display text-3xl font-extrabold uppercase tracking-tight text-foreground">
          Lobby
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {enough
            ? "Ready when the host is. One player becomes the Cop."
            : "Need at least 2 players. Share the code below to invite friends."}
        </p>

        {roomId && (
          <div className="mt-6">
            <p className="font-display text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              Invite code
            </p>
            <button
              onClick={copyCode}
              className="pointer-events-auto mt-2 flex w-full items-center justify-between gap-3 rounded-2xl border border-primary/40 bg-primary/10 px-5 py-4 transition-colors hover:border-primary/70"
            >
              <span className="font-display text-3xl font-extrabold uppercase tracking-[0.4em] text-foreground">
                {code}
              </span>
              <span className="flex items-center gap-1.5 font-display text-[11px] font-bold uppercase tracking-wider text-primary">
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? "Copied" : "Copy"}
              </span>
            </button>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2">
          {lobby.players.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                p.id === myId ? "border-primary/50 bg-primary/10" : "border-white/10 bg-card/50"
              }`}
            >
              <span className="font-display text-sm font-bold text-foreground">
                {p.name}
                {p.id === myId && <span className="text-muted-foreground"> (you)</span>}
              </span>
              {p.isHost && (
                <span className="flex items-center gap-1 font-display text-[10px] font-bold uppercase tracking-wider text-amber-300">
                  <Crown size={13} />
                  Host
                </span>
              )}
            </div>
          ))}
          {Array.from({ length: Math.max(0, 2 - lobby.players.length) }).map((_, i) => (
            <div
              key={`empty-${i}`}
              className="rounded-xl border border-dashed border-white/10 px-4 py-3 text-left font-display text-sm text-muted-foreground/60"
            >
              Waiting for player…
            </div>
          ))}
        </div>

        {amHost ? (
          <button
            onClick={onStart}
            disabled={!enough || conn !== "open"}
            className="pointer-events-auto mt-7 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-8 py-4 font-display text-base font-extrabold uppercase tracking-wider text-primary-foreground transition-transform duration-150 enabled:hover:scale-105 enabled:active:scale-95 disabled:opacity-40"
            style={{ boxShadow: "0 0 24px hsl(327 96% 60% / 0.5)" }}
          >
            <Play size={18} className="fill-current" />
            Start Match
          </button>
        ) : (
          <div className="mt-7 flex items-center justify-center gap-2 rounded-full border border-white/10 bg-card/50 px-8 py-4 font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Waiting for host
          </div>
        )}
        <button
          onClick={onLeave}
          className="pointer-events-auto mt-3 inline-flex w-full items-center justify-center rounded-full border border-white/12 px-8 py-2.5 font-display text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Leave
        </button>
      </div>
    </div>
  );
};

/* ----------------------------- Snatch progress ----------------------------- */

const SnatchProgress = ({ progress }: { progress: number }) => {
  if (progress <= 0) return null;
  const r = 26;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(1, progress);
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <svg width="72" height="72" viewBox="0 0 72 72" className="-rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="5" />
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          stroke="hsl(327 96% 60%)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          style={{ filter: "drop-shadow(0 0 6px hsl(327 96% 60% / 0.9))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center rotate-0">
        <Smartphone size={22} className="text-primary" />
      </div>
    </div>
  );
};

/* ----------------------------- Snatch alerts (cop) ----------------------------- */

const SnatchAlerts = ({ bearings }: { bearings: number[] }) => {
  if (bearings.length === 0) return null;
  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-[24%] z-20 -translate-x-1/2">
        <div className="animate-pulse rounded-full border border-destructive/60 bg-destructive/15 px-4 py-1.5 font-display text-xs font-extrabold uppercase tracking-widest text-destructive backdrop-blur">
          Phone being snatched!
        </div>
      </div>
      <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
        {bearings.map((b, i) => (
          <div
            key={i}
            className="absolute left-0 top-0"
            style={{ transform: `translate(-50%, -50%) rotate(${b}rad)` }}
          >
            <div style={{ transform: "translateY(-78px)" }}>
              <ArrowUp
                size={34}
                className="text-destructive"
                style={{ filter: "drop-shadow(0 0 6px hsl(0 84% 60% / 0.9))" }}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
};

/* ----------------------------- Crosshair ----------------------------- */

const Crosshair = () => (
  <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
    <div className="h-5 w-5 rounded-full border-2 border-white/70 shadow-[0_0_8px_rgba(0,0,0,0.6)]" />
  </div>
);

/* ----------------------------- Toast ----------------------------- */

const Toast = ({ text, k }: { text: string; k: number }) => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!text) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1900);
    return () => clearTimeout(t);
  }, [k, text]);
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-[18%] z-20 -translate-x-1/2">
      <div
        key={k}
        className="animate-pop-in whitespace-nowrap rounded-full border border-white/15 bg-card/85 px-5 py-2 font-display text-sm font-bold uppercase tracking-wider text-foreground backdrop-blur"
      >
        {text}
      </div>
    </div>
  );
};

/* ----------------------------- In-game HUD ----------------------------- */

const InGameHud = ({ hud, isCop }: { hud: HudState; isCop: boolean }) => {
  const PowerIcon = hud.inventory ? POWER_ICON[hud.inventory.kind] : Package;
  const low = hud.timeLeft <= 30;
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 p-4 sm:p-6">
        <div className="mx-auto flex max-w-3xl items-start justify-between gap-3">
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 backdrop-blur ${
              isCop
                ? "border-secondary/50 bg-secondary/10 text-secondary"
                : "border-primary/50 bg-primary/10 text-primary"
            }`}
          >
            {isCop ? <Shield size={16} /> : <Footprints size={16} />}
            <span className="font-display text-xs font-extrabold uppercase tracking-widest">
              {isCop ? "Cop" : "Snatcher"}
            </span>
          </div>

          <div className="flex flex-col items-center">
            <div
              className={`flex items-center gap-1.5 font-display text-3xl font-extrabold tabular-nums sm:text-4xl ${
                low ? "text-destructive" : "text-foreground"
              }`}
              style={low ? { textShadow: "0 0 16px hsl(0 84% 60% / 0.9)" } : undefined}
            >
              <Clock size={20} className="opacity-70" />
              {fmtTime(hud.timeLeft)}
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-full border border-white/12 bg-card/70 px-3 py-1.5 backdrop-blur">
            {isCop ? (
              <>
                <Users size={16} className="text-secondary" />
                <span className="font-display text-xs font-bold tabular-nums text-foreground">
                  {hud.snatchersLeft}/{hud.snatchersTotal} left
                </span>
              </>
            ) : (
              <>
                <Smartphone size={16} className="text-primary" />
                <span className="font-display text-xs font-bold tabular-nums text-foreground">
                  {hud.phonesStolen}/{hud.phoneTarget}
                </span>
              </>
            )}
          </div>
        </div>

        {isCop && (
          <div className="mx-auto mt-3 flex max-w-3xl items-center justify-center gap-2">
            {Array.from({ length: hud.maxStrikes }).map((_, i) => (
              <AlertTriangle
                key={i}
                size={18}
                className={
                  i < hud.strikes
                    ? "fill-destructive/30 text-destructive drop-shadow-[0_0_8px_hsl(0_84%_60%/0.8)]"
                    : "text-muted-foreground/30"
                }
              />
            ))}
          </div>
        )}
      </div>

      {hud.prompt && (
        <div className="pointer-events-none absolute left-1/2 top-[58%] z-10 -translate-x-1/2">
          <div className="rounded-lg border border-white/15 bg-card/80 px-4 py-1.5 font-display text-sm font-bold uppercase tracking-wider text-foreground backdrop-blur">
            {hud.prompt}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between p-4 sm:p-6">
        <div className="flex flex-col gap-1.5">
          {hud.effects.map((e) => {
            const Icon = POWER_ICON[e.kind];
            return (
              <div
                key={e.kind}
                className="flex items-center gap-2 rounded-full border border-secondary/40 bg-secondary/10 px-3 py-1 backdrop-blur"
              >
                <Icon size={14} className="text-secondary" />
                <span className="font-display text-[11px] font-bold uppercase tracking-wider text-secondary">
                  {e.label} {Math.ceil(e.remaining)}s
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <div
            className={`relative grid h-16 w-16 place-items-center rounded-2xl border-2 backdrop-blur ${
              hud.inventory ? "border-primary/70 bg-primary/15" : "border-white/12 bg-card/50"
            }`}
          >
            <PowerIcon
              size={26}
              className={hud.inventory ? "text-primary" : "text-muted-foreground/40"}
            />
            {hud.inventory && (
              <span className="absolute -bottom-6 whitespace-nowrap font-display text-[10px] font-bold uppercase tracking-wider text-primary">
                Q · {hud.inventory.label}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

/* ----------------------------- Role reveal ----------------------------- */

const RoleReveal = ({
  hud,
  isCop,
  onBegin,
}: {
  hud: HudState;
  isCop: boolean;
  onBegin: () => void;
}) => (
  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center backdrop-blur-sm">
    <div className="animate-pop-in w-full max-w-md rounded-3xl border border-white/10 bg-card/85 p-8 shadow-2xl">
      <p className="font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
        Your secret role
      </p>
      <div className="mt-6 flex justify-center">
        <div
          className={`grid h-28 w-28 place-items-center rounded-3xl border-2 ${
            isCop ? "border-secondary/70 bg-secondary/10" : "border-primary/70 bg-primary/10"
          }`}
          style={{
            boxShadow: isCop
              ? "0 0 50px hsl(187 95% 55% / 0.4)"
              : "0 0 50px hsl(327 96% 60% / 0.4)",
          }}
        >
          {isCop ? (
            <Shield size={56} className="text-secondary" />
          ) : (
            <Footprints size={56} className="text-primary" />
          )}
        </div>
      </div>

      <h2
        className={`mt-6 font-display text-4xl font-extrabold uppercase tracking-tight ${
          isCop ? "text-secondary text-glow-cyan" : "text-primary text-glow-pink"
        }`}
      >
        {isCop ? "You're the Cop" : "You're a Snatcher"}
      </h2>
      <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
        {isCop
          ? `Find and apprehend all ${hud.snatchersTotal} snatchers before the clock runs out. Three wrong accusations and they win.`
          : `Blend in, steal ${hud.phoneTarget} phones as a team, and survive. Don't let the cop catch you.`}
      </p>

      <button
        onClick={onBegin}
        className={`pointer-events-auto mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full px-8 py-4 font-display text-base font-extrabold uppercase tracking-wider transition-transform duration-150 hover:scale-105 active:scale-95 ${
          isCop ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground"
        }`}
        style={{
          boxShadow: isCop
            ? "0 0 26px hsl(187 95% 55% / 0.55)"
            : "0 0 26px hsl(327 96% 60% / 0.55)",
        }}
      >
        <Play size={18} className="fill-current" />
        Enter the Street
      </button>
      <p className="mt-3 text-[11px] text-muted-foreground/70">
        Click the screen to lock your mouse and look around.
      </p>
    </div>
  </div>
);

/* ----------------------------- Results ----------------------------- */

const Results = ({
  hud,
  isCop,
  onAgain,
  onHome,
  hostControls,
}: {
  hud: HudState;
  isCop: boolean;
  onAgain: () => void;
  onHome: () => void;
  hostControls: boolean;
}) => {
  const playerWon =
    (isCop && hud.winner === "cop") || (!isCop && hud.winner === "snatchers");
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center backdrop-blur-sm">
      <div className="animate-pop-in w-full max-w-sm rounded-3xl border border-white/10 bg-card/85 p-8 shadow-2xl">
        <p
          className={`font-display text-sm uppercase tracking-[0.3em] ${
            playerWon ? "text-secondary" : "text-destructive"
          }`}
        >
          {playerWon ? "Victory" : "Defeat"}
        </p>
        <h2 className="mt-4 font-display text-4xl font-extrabold uppercase leading-none tracking-tight text-foreground">
          {hud.winner === "cop" ? "Cop Wins" : "Snatchers Win"}
        </h2>

        <div className="mt-6 flex justify-center gap-6">
          {isCop ? (
            <Stat
              value={`${hud.snatchersTotal - hud.snatchersLeft}/${hud.snatchersTotal}`}
              label="Caught"
            />
          ) : (
            <Stat value={`${hud.phonesStolen}/${hud.phoneTarget}`} label="Snatched" />
          )}
          <Stat value={fmtTime(hud.timeLeft)} label="On clock" />
        </div>

        {hostControls ? (
          <button
            onClick={onAgain}
            className="pointer-events-auto mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-8 py-4 font-display text-base font-extrabold uppercase tracking-wider text-primary-foreground transition-transform duration-150 hover:scale-105 active:scale-95"
            style={{ boxShadow: "0 0 26px hsl(327 96% 60% / 0.55)" }}
          >
            <Play size={18} className="fill-current" />
            New Match
          </button>
        ) : (
          <div className="mt-8 flex items-center justify-center gap-2 rounded-full border border-white/10 bg-card/50 px-8 py-4 font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Waiting for host
          </div>
        )}
        <button
          onClick={onHome}
          className="pointer-events-auto mt-3 inline-flex w-full items-center justify-center rounded-full border border-white/15 px-8 py-3 font-display text-sm font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Leave
        </button>
      </div>
    </div>
  );
};

const Stat = ({ value, label }: { value: string; label: string }) => (
  <div>
    <p className="font-display text-3xl font-extrabold tabular-nums text-foreground text-glow-cyan">
      {value}
    </p>
    <p className="mt-1 font-display text-[11px] uppercase tracking-widest text-muted-foreground">
      {label}
    </p>
  </div>
);

export default Index;
