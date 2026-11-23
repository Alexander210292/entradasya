import { spawn, spawnSync, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { services } from "../shared/config.ts";

if (process.platform !== "linux") {
  console.error("En Windows, ejecuta el proyecto desde Ubuntu en WSL2. Consulta el arranque en Windows del README.");
  process.exit(1);
}

type ProcessIdentity = { pid: number; group: number; started: string };
type Stack = { supervisor: ProcessIdentity; children: ProcessIdentity[]; url: string; ready: boolean };

const node = process.execPath;
const script = import.meta.filename;
const project = resolve(import.meta.dirname, "..");
const local = resolve(process.env.ENTRADASYA_LOCAL_DIR ?? resolve(project, ".local"));
const statePath = resolve(local, "stack.json");
const logPath = resolve(local, "app.log");
const startupTimeoutMs = 120000;
const shutdownTimeoutMs = 90000;
const healthCheckAttempts = 150;
const env: NodeJS.ProcessEnv = { ...process.env, ENTRADASYA_LOCAL_DIR: local };
// Cada backend carga su propio puerto y conexión desde .local/env.
delete env.HOST;
delete env.PORT;
delete env.DATABASE_URL;
const localPg = resolve(project, ".local/tools/pgsql/usr/bin");
if (!env.PG_BIN && existsSync(resolve(localPg, "pg_ctl"))) {
  env.PG_BIN = localPg;
  env.LD_LIBRARY_PATH = [resolve(localPg, "../lib64"), env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
if (!env.PG_BIN) {
  const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (pgConfig.status === 0) env.PG_BIN = pgConfig.stdout.trim();
}

function identity(pid: number | undefined): ProcessIdentity | undefined {
  if (!pid) return;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] !== "Z" && fields[0] !== "X") {
      return { pid, group: Number(fields[2]), started: fields[19] };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isAlive(process: ProcessIdentity) {
  const current = identity(process.pid);
  return current?.started === process.started && current.group === process.group;
}

function readState(): Stack | undefined {
  if (!existsSync(statePath)) return;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state: Stack) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, statePath);
}

function run(entry: string, ...args: string[]) {
  execFileSync(node, [entry, ...args], { cwd: project, env, stdio: "inherit", timeout: 45000 });
}

async function waitUntil(check: () => boolean, milliseconds: number) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (check()) return true;
    await delay(100);
  }
  return check();
}

function signal(pid: number, name: NodeJS.Signals) {
  try { process.kill(pid, name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function removeOrphans(state: Stack) {
  const children = () => state.children.some(isAlive);
  if (!children()) return;
  signal(-state.supervisor.group, "SIGTERM");
  if (!(await waitUntil(() => !children(), 5000))) {
    throw new Error(`Siguen activos procesos de EntradasYa. Revisa ${logPath}.`);
  }
}

async function stopStack() {
  const state = readState();
  if (state && isAlive(state.supervisor)) {
    signal(state.supervisor.pid, "SIGTERM");
    if (!(await waitUntil(() => !isAlive(state.supervisor), shutdownTimeoutMs))) {
      throw new Error(`El cierre sigue en curso. Revisa ${logPath}.`);
    }
  }
  if (state) await removeOrphans(state);
  run("scripts/local.ts", "db:stop");
  rmSync(statePath, { force: true });
  console.log("EntradasYa detenida.");
}

async function portAvailable(port: number) {
  const server = createServer();
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    await new Promise<void>((done) => server.close(() => done()));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  }
}

async function chooseWebPort() {
  const preferred = Number(env.WEB_PORT ?? 8080);
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error("WEB_PORT debe estar entre 1 y 65535.");
  }
  if (await portAvailable(preferred)) return preferred;
  if (!env.WEB_PORT && await portAvailable(8088)) return 8088;
  throw new Error(`Puerto web ${preferred} ocupado. Indica un puerto libre con WEB_PORT.`);
}

async function healthy(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

async function startStack() {
  const previous = readState();
  if (previous && isAlive(previous.supervisor)) {
    if (!previous.ready) throw new Error(`El arranque sigue en curso. Revisa ${logPath}.`);
    console.log(`EntradasYa ya está activa en ${previous.url}`);
    return;
  }
  if (previous) await removeOrphans(previous);
  const port = await chooseWebPort();
  if (!env.ENTRADASYA_PG_PORT && !existsSync(resolve(local, "postgres/PG_VERSION"))) {
    const dbPort = await portAvailable(5432) ? 5432 : 5433;
    if (!(await portAvailable(dbPort))) throw new Error("PostgreSQL requiere un puerto libre. Indícalo con ENTRADASYA_PG_PORT.");
    env.ENTRADASYA_PG_PORT = String(dbPort);
  }
  const log = openSync(logPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(node, [script, "supervise"], {
      cwd: project,
      detached: true,
      env: { ...env, WEB_PORT: String(port), WEB_BASE_URL: env.WEB_BASE_URL ?? `http://localhost:${port}` },
      stdio: ["ignore", log, log],
    });
    child.once("error", (error) => console.error(error.message));
    child.unref();
  } finally { closeSync(log); }

  const ready = await waitUntil(() => {
    const state = readState();
    return Boolean(state && state.supervisor.pid === child.pid && state.ready) || !identity(child.pid);
  }, startupTimeoutMs);
  const state = readState();
  if (!ready || !state?.ready || state.supervisor.pid !== child.pid || !isAlive(state.supervisor)) {
    if (state && state.supervisor.pid === child.pid && isAlive(state.supervisor)) signal(state.supervisor.pid, "SIGTERM");
    throw new Error(`EntradasYa no completó el arranque. Revisa ${logPath}.`);
  }
  console.log(`EntradasYa disponible en ${state.url}`);
  console.log(`Mailpit en http://localhost:8025/ · Logs en ${logPath}`);
}

async function supervise() {
  const supervisor = identity(process.pid);
  if (!supervisor || supervisor.group !== process.pid) throw new Error("El supervisor requiere un grupo de procesos propio.");
  const state: Stack = {
    supervisor, children: [], url: `http://localhost:${env.WEB_PORT}/`, ready: false,
  };
  writeState(state);
  const children: { child: ChildProcess; done: Promise<void> }[] = [];
  let stopping = false;
  let exitCode = 0;
  let databaseRequested = false;
  let fallback: NodeJS.Timeout | undefined;

  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const { child } of children) child.kill("SIGTERM");
    fallback = setTimeout(() => {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }, 10000);
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop());

  function start(command: string, ...args: string[]) {
    const child = spawn(command, args, { cwd: project, env, stdio: "inherit" });
    const member = identity(child.pid);
    if (member) {
      state.children.push(member);
      writeState(state);
    }
    const done = new Promise<void>((finish) => {
      child.once("close", () => {
        if (!stopping) { console.error(`Proceso finalizado inesperadamente · ${command}`); stop(1); }
        finish();
      });
      child.once("error", (error) => { console.error(error.message); stop(1); });
    });
    children.push({ child, done });
  }

  try {
    databaseRequested = true;
    run("scripts/local.ts", "db:init");
    for (const service of services) if (service !== "notifications") run("scripts/service.ts", "migrate", service);
    run("scripts/service.ts", "seed", "auth");
    run("scripts/build-web.ts");
    if (!(await healthy("http://127.0.0.1:8025/api/v1/messages"))) {
      const bundled = resolve(project, ".local/bin/mailpit");
      start(env.MAILPIT_BIN ?? (existsSync(bundled) ? bundled : "mailpit"),
        "--listen", "127.0.0.1:8025", "--smtp", "127.0.0.1:1025",
        "--database", resolve(local, "mailpit.db"), "--disable-version-check");
    }
    for (const service of services) start(node, "scripts/service.ts", "start", service);
    start(node, "scripts/nginx.ts");
    const dependencies = [
      ...services.map((_, index) => `http://127.0.0.1:${3001 + index}/health`),
      `http://127.0.0.1:${env.WEB_PORT}/health`,
    ];
    for (let attempt = 0; attempt < healthCheckAttempts && !stopping; attempt += 1) {
      if ((await Promise.all(dependencies.map(healthy))).every(Boolean) && !stopping) {
        state.ready = true;
        writeState(state);
        break;
      }
      if (attempt === healthCheckAttempts - 1) throw new Error("La web o un servicio no pasó el chequeo de salud.");
      await delay(220);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    stop(1);
  }
  await Promise.all(children.map(({ done }) => done));
  if (fallback) clearTimeout(fallback);
  if (databaseRequested) run("scripts/local.ts", "db:stop");
  rmSync(statePath, { force: true });
  process.exitCode = exitCode;
}

try {
  const action = process.argv[2] ?? "start";
  if (action === "supervise") {
    await supervise();
  } else if (action === "locked-start") {
    await startStack();
  } else if (action === "locked-stop") {
    await stopStack();
  } else if (action === "start" || action === "stop") {
    mkdirSync(local, { recursive: true, mode: 0o700 });
    const result = spawnSync("flock", ["-E", "75", "-w", "45", resolve(local, "stack.lock"), node, script, `locked-${action}`], {
      cwd: project, env, stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status === 75) throw new Error("Hay otro arranque o apagado en curso.");
    process.exitCode = result.status ?? 1;
  } else {
    throw new Error("Usa npm run start:local o npm run stop:local.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
