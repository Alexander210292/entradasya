import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import type { IncomingMessage, RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import pg from "pg";
import sharp from "sharp";
import { contract, validateResponse } from "../shared/api.ts";
import { services } from "../shared/config.ts";

import type {
  Purchase,
  IssueTickets,
  Reservation,
  Role,
  Selection,
} from "../shared/contracts.ts";

type Session = { token: string; user: { id: string; role: Role } };
type Actors = {
  client: Session;
  other: Session;
  organizer: Session;
  gatekeeper: Session;
};
type EventSector = Pick<Selection, "eventId" | "sectorId">;
type PurchaseRequest = {
  token: string;
  key: string;
  body: Purchase;
  status?: number;
};
type TestRequest = {
  service?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: object | string;
  token?: string;
  internal?: string;
  key?: string;
  status?: number | number[];
};
type OrderResponse = {
  id: string;
  status: string;
  notificationStatus: string;
  ticketStatus: string;
  unitPriceMinor?: number;
  amountMinor?: number;
  failureCode?: string;
};
type TicketList = { items: { id: string }[] };
type PaymentResponse = {
  orderId: string;
  status: string;
  amountMinor: number;
  currency: string;
  processedAt: string;
};
type ScanResponse = {
  allowed: boolean;
  admittedAt?: string;
  reason?: string;
  firstAdmittedAt?: string;
};
type CatalogueEvent = {
  id: string;
  status: string;
  sectors: { id: string; available: number }[];
};
type Values = {
  uploadEventImage: { imagePath: string };
  getEventImage: Buffer;
  register: Session["user"] & { email: string };
  login: Session;
  createEvent: { id: string };
  createSector: { id: string };
  listPublishedEvents: { items: { id: string }[] };
  getPublishedEvent: CatalogueEvent;
  listOwnEvents: { items: CatalogueEvent[] };
  purchaseTickets: OrderResponse;
  getOwnOrder: OrderResponse;
  listOwnOrders: { items: OrderResponse[] };
  getSales: { ticketsSold: number; revenueMinor: number };
  listOwnTickets: TicketList;
  downloadOwnTicket: Buffer;
  processPayment: PaymentResponse;
  reserveCapacity: Reservation;
  issueTickets: TicketList;
  lookupTicket: { ticketId: string; eventId: string };
  registerCheckin: ScanResponse;
  getAttendance: { admittedCount: number };
};
type Result<Id extends string> = (Id extends keyof Values
  ? Values[Id]
  : object) & { code?: string; orderId?: string };

const dir = await mkdtemp(join(tmpdir(), "entradasya-base-"));
const logs: string[] = [];
const children = new Map<
  string,
  { child: ChildProcess; exited: Promise<void> }
>();
const tested = new Set<string>();
const ops = new Map(
  Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, spec]) => [
      spec.operationId,
      { path, method, service: spec.tags[0] },
    ]),
  ),
);
let postgresEnv: NodeJS.ProcessEnv | undefined;
let environment: Record<string, Record<string, string>> = {};
const timeouts = 400;
let startMailpit: () => void;

function listeningPort(server: Server) {
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function portsForTest() {
  const sockets: Server[] = [];
  try {
    for (let i = 0; i < services.length + 4; i += 1) {
      const socket = createServer().listen(0, "127.0.0.1");
      await once(socket, "listening");
      sockets.push(socket);
    }
    return sockets.map(listeningPort);
  } finally {
    await Promise.all(
      sockets.map((socket) => new Promise((done) => socket.close(done))),
    );
  }
}

function run(file: string, args: string[], env = postgresEnv) {
  execFileSync(file, args, { env, stdio: "inherit" });
}

function start(name: string, file: string, args: string[], env = postgresEnv) {
  const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((accept) => {
    child.once("error", (error) => {
      logs.push(String(error));
      accept();
    });
    child.once("close", () => accept());
  });
  child.stdout.on("data", (data) => logs.push(String(data)));
  child.stderr.on("data", (data) => logs.push(String(data)));
  children.set(name, { child, exited });
}

async function stop(name: string) {
  const process = children.get(name);
  if (!process) return;
  process.child.kill();
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 5000);
  try {
    await process.exited;
  } finally {
    clearTimeout(timer);
    children.delete(name);
  }
}

async function eventually<T>(run: () => T | Promise<T>): Promise<T> {
  const until = Date.now() + 12000;
  while (true) {
    try {
      return await run();
    } catch (error) {
      if (Date.now() >= until) throw error;
      await delay(100);
    }
  }
}

function listen(name: string) {
  start(
    name,
    process.execPath,
    ["scripts/service.ts", "start", name],
    environment[name],
  );
}

async function request<Id extends string>(
  id: Id,
  {
    service,
    params = {},
    query = {},
    body,
    token,
    internal,
    key,
    status = 200,
  }: TestRequest = {},
): Promise<Result<Id>> {
  const spec = ops.get(id);
  assert(spec, "Operación desconocida: " + id);
  const target = service ?? spec.service;
  const path = spec.path.replaceAll(/\{(\w+)\}/g, (_, field) => params[field]);
  const url = new URL(path, `http://127.0.0.1:${environment[target].PORT}`);
  for (const [name, value] of Object.entries(query))
    url.searchParams.append(name, value);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = "Bearer " + token;
  if (internal) headers["X-Internal-Token"] = internal;
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(url, {
    method: spec.method.toUpperCase(),
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  let value;
  if (response.headers.get("content-type")?.includes("application/json")) {
    value = await response.json();
  } else if (response.status !== 204) {
    assert.match(
      response.headers.get("content-type") ?? "",
      /^(application\/pdf|image\/webp)/,
    );
    value = Buffer.from(await response.arrayBuffer());
  }
  const expected = typeof status === "number" ? [status] : status;
  assert.ok(
    expected.includes(response.status),
    `${id} en ${target}: HTTP ${response.status} (${value?.code ?? ""}), esperado ${expected.join(" o ")}`,
  );
  assert.ok(
    validateResponse(id, response.status, value),
    `Respuesta incompatible con OpenAPI en ${id} (${response.status})`,
  );
  tested.add(id);
  return value as Result<Id>;
}

async function health(service: string, status = 200) {
  assert.deepEqual(await request("getHealth", { service, status }), {
    status: status === 200 ? "ok" : "unavailable",
  });
}

async function timeoutEndpoint(port: string, run: () => Promise<unknown>) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }).listen(Number(port), "127.0.0.1");
  await once(server, "listening");
  try {
    const start = Date.now();
    await run();
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed >= timeouts * 0.8 && elapsed < 2500,
      `timeout fuera del margen: ${elapsed} ms`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  }
}

async function setup() {
  const [dbPort, smtpPort, uiPort, webPort, ...backendPorts] = await portsForTest();
  const mailpit =
    process.env.MAILPIT_BIN ??
    (await access(".local/bin/mailpit").then(
      () => resolve(".local/bin/mailpit"),
      () => "mailpit",
    ));
  postgresEnv = {
    ...process.env,
    ENTRADASYA_LOCAL_DIR: dir,
    ENTRADASYA_PG_PORT: String(dbPort),
  };
  run(process.execPath, ["scripts/local.ts", "db:init"]);
  run(process.execPath, ["scripts/local.ts", "db:init"]);
  environment = Object.fromEntries(
    await Promise.all(
      services.map(async (name, index) => {
        const defaults = parseEnv(
          await readFile(join(dir, "env", name + ".env"), "utf8"),
        );
        const config: Record<string, string> = {
          ...postgresEnv,
          ...defaults,
          PORT: String(backendPorts[index]),
        };
        if (name === "notifications") {
          config.SMTP_PORT = String(smtpPort);
          config.WEB_BASE_URL = `http://127.0.0.1:${webPort}`;
          config.SMTP_TIMEOUT_MS = String(timeouts);
        }
        if (name === "orders" || name === "checkin") {
          config.HTTP_TIMEOUT_MS = String(timeouts);
          for (const target of services) {
            const key = target.toUpperCase() + "_URL";
            if (Object.hasOwn(config, key))
              config[key] =
                `http://127.0.0.1:${backendPorts[services.indexOf(target)]}`;
          }
        }
        return [name, config];
      }),
    ),
  );
  for (const name of services.filter((item) => item !== "notifications")) {
    run(
      process.execPath,
      ["scripts/service.ts", "migrate", name],
      environment[name],
    );
    const pool = new pg.Pool({
      connectionString: environment[name].DATABASE_URL,
    });
    try {
      const { rows } = await pool.query(
        "SELECT current_user AS role, version FROM schema_migrations ORDER BY version",
      );
      const versions = ["001-initial"];
      if (name === "auth") versions.push("002-user-invariants");
      if (name === "events") versions.push("002-reservation-sector");
      assert.deepEqual(
        rows,
        versions.map((version) => ({ role: name + "_app", version })),
      );
    } finally {
      await pool.end();
    }
  }
  run(
    process.execPath,
    ["scripts/service.ts", "seed", "auth"],
    environment.auth,
  );
  startMailpit = () =>
    start(
      "mailpit",
      mailpit,
      [
        "--listen",
        "127.0.0.1:" + uiPort,
        "--smtp",
        "127.0.0.1:" + smtpPort,
        "--disable-version-check",
      ],
      { PATH: process.env.PATH },
    );
  startMailpit();
  for (const name of services) listen(name);
  await Promise.all(services.map((name) => eventually(() => health(name))));
  return { uiPort, webPort };
}

const password = "base-check-secret-password";
const fakeEmail = "cliente-base@example.test";

function login(email: string, pass = password) {
  return request("login", { body: { email, password: pass } });
}

async function identities() {
  await request("register", { body: "{", status: 400 });
  for (const invalid of [
    { name: "" },
    { email: "correo-invalido" },
    { password: "" },
  ]) {
    await request("register", {
      body: { name: "Cuenta", email: fakeEmail, password, ...invalid },
      status: 400,
    });
  }
  await request("register", {
    body: { name: "Cuenta", email: fakeEmail, password, role: "portero" },
    status: 400,
  });
  const registered = await request("register", {
    body: { name: "Cliente", email: fakeEmail.toUpperCase(), password },
    status: 201,
  });
  assert.equal(registered.email, fakeEmail);
  assert.equal(registered.role, "cliente");
  await request("register", {
    body: { name: "Duplicado", email: fakeEmail.toUpperCase(), password },
    status: 409,
  });
  await request("register", {
    body: { name: "Otro", email: "otra@example.test", password },
    status: 201,
  });
  await request("login", {
    body: { email: fakeEmail, password: "incorrecta" },
    status: 401,
  });
  const client = await login(fakeEmail.toUpperCase());
  const other = await login("otra@example.test");
  const organizer = await login("organizador@example.test", "demo-entradasya");
  const gatekeeper = await login("portero@example.test", "demo-entradasya");
  const verified = jwt.verify(client.token, environment.auth.JWT_SECRET, {
    algorithms: ["HS256"],
    complete: true,
  });
  assert.equal(verified.header.alg, "HS256");
  const claims = verified.payload;
  assert(typeof claims !== "string" && claims.exp && claims.iat);
  assert.equal(claims.sub, client.user.id);
  assert.equal(claims.role, "cliente");
  assert.equal(claims.exp - claims.iat, 3600);
  const expired = jwt.sign({ role: "cliente" }, environment.auth.JWT_SECRET, {
    subject: client.user.id,
    expiresIn: -1,
  });
  await request("listOwnOrders", { token: expired, status: 401 });
  const wrongSignature = jwt.sign({ role: "cliente" }, randomUUID(), {
    subject: client.user.id,
    expiresIn: 60,
  });
  await request("listOwnOrders", { token: wrongSignature, status: 401 });
  await request("listOwnOrders", { status: 401 });
  assert.equal(organizer.user.role, "organizador");
  assert.equal(gatekeeper.user.role, "portero");
  run(
    process.execPath,
    ["scripts/service.ts", "seed", "auth"],
    environment.auth,
  );
  assert.equal(
    (await login("organizador@example.test", "demo-entradasya")).user.id,
    organizer.user.id,
  );
  assert.equal(
    (await login("portero@example.test", "demo-entradasya")).user.id,
    gatekeeper.user.id,
  );
  const pool = new pg.Pool({ connectionString: environment.auth.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      "SELECT email, password_digest FROM users WHERE id=$1",
      [client.user.id],
    );
    assert.deepEqual(rows, [
      {
        email: fakeEmail,
        password_digest: createHash("md5").update(password).digest("hex"),
      },
    ]);
  } finally {
    await pool.end();
  }
  return { client, other, organizer, gatekeeper };
}

const eventInput = {
  name: "Evento base",
  date: "2026-12-01T19:00:00-04:00",
  venue: "Local de prueba",
  imageUrl: "https://example.test/event.png",
  description: "Verificación de EntradasYa.",
};

async function catalogue(actors: Actors) {
  const organizer = actors.organizer.token;
  const { id: eventId } = await request("createEvent", {
    token: organizer,
    body: eventInput,
    status: 201,
  });
  const foreignToken = jwt.sign(
    { role: "organizador" },
    environment.auth.JWT_SECRET,
    { subject: randomUUID(), expiresIn: 60 },
  );
  await request("updateEvent", {
    token: foreignToken,
    params: { eventId },
    body: eventInput,
    status: 404,
  });
  await request("updateEvent", {
    token: organizer,
    params: { eventId },
    body: eventInput,
  });
  await request("createEvent", {
    token: actors.client.token,
    body: eventInput,
    status: 403,
  });
  await request("getPublishedEvent", { params: { eventId }, status: 404 });
  await request("getPublishedEvent", {
    params: { eventId: "invalido" },
    status: 400,
  });
  const section = { name: "General", unitPriceMinor: 7500, capacity: 3 };
  const { id: sectorId } = await request("createSector", {
    token: organizer,
    params: { eventId },
    body: section,
    status: 201,
  });
  await request("updateSector", {
    token: organizer,
    params: { eventId, sectorId },
    body: section,
  });
  await request("updateEventStatus", {
    token: organizer,
    params: { eventId },
    body: { status: "published" },
  });
  assert.equal((await request("listPublishedEvents")).items.length, 1);
  assert.equal(
    (await request("getPublishedEvent", { params: { eventId } })).status,
    "published",
  );
  assert.equal(
    (await request("listOwnEvents", { token: organizer })).items[0].id,
    eventId,
  );
  return { eventId, sectorId };
}

async function eventUploads(actors: Actors) {
  const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#344b32' } }).png().toBuffer();
  const body = { content: image.toString('base64') };
  await request('uploadEventImage', { body, status: 401 });
  await request('uploadEventImage', { body, token: actors.client.token, status: 403 });
  const token = actors.organizer.token;
  await request('uploadEventImage', { token, body: { content: Buffer.from('not an image').toString('base64') }, status: 400 });
  await request('uploadEventImage', { token, body: { content: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }, status: 400 });
  const [uploaded, retried] = await Promise.all([
    request('uploadEventImage', { token, body, status: 201 }),
    request('uploadEventImage', { token, body, status: 201 }),
  ]);
  assert.deepEqual(uploaded, retried);
  const imageId = uploaded.imagePath.split('/').at(-1)!;
  const contents = await request('getEventImage', { params: { imageId } });
  assert.equal((await sharp(contents).metadata()).format, 'webp');
  assert.equal((await sharp(contents).metadata()).width, 80);
  await request('getEventImage', { params: { imageId: randomUUID() }, status: 404 });
  assert.deepEqual((await readdir(environment.events.EVENTS_IMAGES_DIR)).filter((name) => name.endsWith('.tmp')), []);
}

async function catalogueRules(actors: Actors, otherEvent: EventSector) {
  const token = actors.organizer.token;
  const body = { ...eventInput, name: "Evento para probar reservas" };
  const { id: eventId } = await request("createEvent", {
    token,
    body,
    status: 201,
  });
  const params = { eventId };
  const ownEvent = async () => {
    const list = await request("listOwnEvents", { token });
    const event = list.items.find(({ id }) => id === eventId);
    assert(event);
    return event;
  };
  assert.equal((await ownEvent()).status, "draft");
  assert.ok(
    !(await request("listPublishedEvents")).items.some(
      ({ id }) => id === eventId,
    ),
  );
  const publication = { token, params, body: { status: "published" } };
  assert.equal(
    (await request("updateEventStatus", { ...publication, status: 409 })).code,
    "SECTOR_REQUIRED",
  );

  const section = { name: "General", unitPriceMinor: 7500, capacity: 2 };
  for (const invalid of [
    { capacity: 0 },
    { unitPriceMinor: 0 },
    { unitPriceMinor: 1.5 },
  ]) {
    await request("createSector", {
      token,
      params,
      body: { ...section, ...invalid },
      status: 400,
    });
  }
  const { id: sectorId } = await request("createSector", {
    token,
    params,
    body: section,
    status: 201,
  });
  const sectorParams = { eventId, sectorId };
  const foreign = jwt.sign(
    { role: "organizador" },
    environment.auth.JWT_SECRET,
    { subject: randomUUID(), expiresIn: 60 },
  );
  assert.deepEqual(
    (await request("listOwnEvents", { token: foreign })).items,
    [],
  );
  await request("updateSector", {
    token: foreign,
    params: sectorParams,
    body: section,
    status: 404,
  });
  await request("updateEventStatus", {
    ...publication,
    token: foreign,
    status: 404,
  });
  await request("updateSector", {
    token,
    params: { eventId, sectorId: otherEvent.sectorId },
    body: section,
    status: 404,
  });
  await request("updateEventStatus", publication);
  assert.equal((await ownEvent()).status, "published");

  const internal = environment.events.EVENTS_ORDERS_TOKEN;
  const reserve = (
    orderId: string,
    selection: Selection,
    status?: TestRequest["status"],
  ) =>
    request("reserveCapacity", {
      params: { orderId },
      internal,
      body: selection,
      status,
    });
  const selection = { eventId, sectorId, quantity: 2 };
  await reserve(
    randomUUID(),
    { ...selection, sectorId: otherEvent.sectorId },
    404,
  );

  const retrySector = await request("createSector", {
    token,
    params,
    body: { ...section, name: "Reintentos", capacity: 1 },
    status: 201,
  });
  const retryOrder = randomUUID();
  const retrySelection = { eventId, sectorId: retrySector.id, quantity: 1 };
  const simultaneousRetries = await Promise.all([
    reserve(retryOrder, retrySelection),
    reserve(retryOrder.toUpperCase(), retrySelection),
  ]);
  assert.deepEqual(simultaneousRetries[0], simultaneousRetries[1]);

  const firstOrder = randomUUID();
  const secondOrder = randomUUID();
  const race = await Promise.all([
    reserve(firstOrder, selection, [200, 409]),
    reserve(secondOrder, selection, [200, 409]),
  ]);
  const confirmed = race.find(({ orderId }) => orderId);
  assert(confirmed);
  assert.equal(race.filter(({ code }) => code === "SOLD_OUT").length, 1);
  assert.equal(confirmed.organizerId, actors.organizer.user.id);
  assert.equal(
    (await request("getPublishedEvent", { params })).sectors[0].available,
    0,
  );
  const retry = reserve(confirmed.orderId.toUpperCase(), {
    eventId: eventId.toUpperCase(),
    sectorId: sectorId.toUpperCase(),
    quantity: 2,
  });
  const repeated = await Promise.all([
    retry,
    reserve(confirmed.orderId, selection),
  ]);
  for (const result of repeated) assert.deepEqual(result, confirmed);
  assert.equal(
    (await reserve(confirmed.orderId, { ...selection, quantity: 1 }, 409)).code,
    "RESERVATION_CONFLICT",
  );

  assert.equal(
    (
      await request("updateSector", {
        token,
        params: sectorParams,
        body: { ...section, capacity: 1 },
        status: 409,
      })
    ).code,
    "CAPACITY_RESERVED",
  );
  await request("updateEvent", {
    token,
    params,
    body: { ...body, venue: "Recinto actualizado" },
  });
  await request("updateSector", {
    token,
    params: sectorParams,
    body: { ...section, unitPriceMinor: 9000 },
  });

  await request("updateEventStatus", {
    token,
    params,
    body: { status: "cancelled" },
  });
  assert.equal((await ownEvent()).status, "cancelled");
  await request("getPublishedEvent", { params, status: 404 });
  assert.ok(
    !(await request("listPublishedEvents")).items.some(
      ({ id }) => id === eventId,
    ),
  );
  await request("updateEventStatus", { ...publication, status: 409 });
  await request("updateEvent", { token, params, body, status: 409 });
  assert.equal(
    (await reserve(randomUUID(), selection, 409)).code,
    "EVENT_UNAVAILABLE",
  );
  assert.deepEqual(await reserve(confirmed.orderId, selection), confirmed);

  const release = (orderId: string) =>
    request("releaseCapacity", {
      params: { orderId },
      internal,
      status: 204,
    });
  await Promise.all([
    release(confirmed.orderId),
    release(confirmed.orderId.toUpperCase()),
  ]);
  assert.equal((await ownEvent()).sectors[0].available, 2);
  assert.equal(
    (await reserve(confirmed.orderId, selection, 409)).code,
    "RESERVATION_CONFLICT",
  );

  const draft = await request("createEvent", { token, body, status: 201 });
  await request("updateEventStatus", {
    token,
    params: { eventId: draft.id },
    body: { status: "cancelled" },
  });
  assert.equal(
    (await request("listOwnEvents", { token })).items.find(
      ({ id }) => id === draft.id,
    )?.status,
    "cancelled",
  );

  const pool = new pg.Pool({
    connectionString: environment.events.DATABASE_URL,
  });
  try {
    await assert.rejects(
      pool.query(
        "INSERT INTO reservations (order_id, event_id, sector_id, quantity, snapshot) VALUES ($1,$2,$3,1,'{}')",
        [randomUUID(), eventId, otherEvent.sectorId],
      ),
      { code: "23503", constraint: "reservations_sector_event_fkey" },
    );
  } finally {
    await pool.end();
  }
}

async function purchases(
  actors: Actors,
  selection: EventSector,
  uiPort: number,
) {
  const { client, other, organizer } = actors;
  const key = randomUUID();
  const body = {
    ...selection,
    quantity: 2,
    recipientEmail: fakeEmail,
    paymentCode: "1234",
  };
  const options = { token: client.token, key, body };
  for (const quantity of [0, 7, 1.5]) {
    await request("purchaseTickets", {
      ...options,
      body: { ...body, quantity },
      status: 400,
    });
  }
  const order = await request("purchaseTickets", options);
  assert.equal(order.notificationStatus, "sent");
  assert.equal(order.unitPriceMinor, 7500);
  assert.equal(order.amountMinor, 15000);
  assert.equal((await request("purchaseTickets", options)).id, order.id);
  await request("purchaseTickets", {
    ...options,
    body: { ...body, quantity: 1 },
    status: 409,
  });
  const params = { orderId: order.id };
  await request("getOwnOrder", { token: client.token, params });
  await request("getOwnOrder", { token: other.token, params, status: 404 });
  assert.equal(
    (await request("listOwnOrders", { token: client.token })).items.length,
    1,
  );
  const sales = await request("getSales", {
    token: organizer.token,
    params: selection,
  });
  assert.equal(sales.ticketsSold, 2);
  assert.equal(sales.revenueMinor, 15000);
  const anotherOrganizer = jwt.sign(
    { role: "organizador" },
    environment.auth.JWT_SECRET,
    { subject: randomUUID(), expiresIn: 60 },
  );
  const outsideSales = await request("getSales", {
    token: anotherOrganizer,
    params: selection,
  });
  assert.equal(outsideSales.ticketsSold, 0);
  assert.equal(outsideSales.revenueMinor, 0);
  await request("getSales", {
    token: client.token,
    params: selection,
    status: 403,
  });
  const soldOut = await request("purchaseTickets", {
    ...options,
    key: randomUUID(),
    status: 409,
  });
  assert.equal(soldOut.code, "SOLD_OUT");
  assert(soldOut.orderId);
  const cancelled = await request("getOwnOrder", {
    token: client.token,
    params: { orderId: soldOut.orderId },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.failureCode, "SOLD_OUT");
  const missing = await request("purchaseTickets", {
    ...options,
    key: randomUUID(),
    body: { ...body, eventId: randomUUID() },
    status: 404,
  });
  assert.equal(missing.code, "NOT_FOUND");
  assert(missing.orderId);
  assert.equal(
    (
      await request("getOwnOrder", {
        token: client.token,
        params: { orderId: missing.orderId },
      })
    ).failureCode,
    "NOT_FOUND",
  );
  const decline = {
    ...options,
    body: { ...body, quantity: 1, paymentCode: "0000" },
    key: randomUUID(),
    status: 422,
  };
  assert.equal(
    (await request("purchaseTickets", decline)).code,
    "PAYMENT_DECLINED",
  );
  await request("purchaseTickets", decline);
  assert.deepEqual(
    (await request("listOwnOrders", { token: other.token })).items,
    [],
  );
  const messages = await (
    await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`)
  ).json();
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].Subject, "Confirmación de EntradasYa");
  const messageResponse = await fetch(
    `http://127.0.0.1:${uiPort}/api/v1/message/${messages.messages[0].ID}`,
  );
  assert.ok(messageResponse.ok);
  const message = await messageResponse.json();
  assert.equal(message.From.Address, environment.notifications.SMTP_FROM);
  assert.deepEqual(
    message.To.map((recipient: { Address: string }) => recipient.Address),
    [fakeEmail],
  );
  const link = new URL("/mis-entradas", environment.notifications.WEB_BASE_URL);
  link.searchParams.set("orderId", order.id);
  assert.ok(message.Text.includes(link.href));
  const tickets = await request("listOwnTickets", {
    token: client.token,
    query: { orderId: order.id },
  });
  assert.equal(tickets.items.length, 2);
  assert.deepEqual(
    (await request("listOwnTickets", { token: client.token })).items,
    tickets.items,
  );
  assert.deepEqual(
    (
      await request("listOwnTickets", {
        token: other.token,
        query: { orderId: order.id },
      })
    ).items,
    [],
  );
  await request("listOwnTickets", {
    query: { orderId: order.id },
    status: 401,
  });
  const ticketId = tickets.items[0].id;
  const pdf = await request("downloadOwnTicket", {
    token: client.token,
    params: { ticketId },
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  await request("downloadOwnTicket", {
    token: other.token,
    params: { ticketId },
    status: 404,
  });
  await request("downloadOwnTicket", { params: { ticketId }, status: 401 });

  const paymentsToken = environment.payments.PAYMENTS_ORDERS_TOKEN;
  const payments = {
    params,
    internal: paymentsToken,
    body: { amountMinor: 15000, currency: "BOB", paymentCode: "1234" },
  };
  await request("processPayment", {
    ...payments,
    internal: environment.events.EVENTS_ORDERS_TOKEN,
    status: 403,
  });
  assert.equal((await request("processPayment", payments)).status, "approved");
  await request("processPayment", {
    ...payments,
    body: { ...payments.body, paymentCode: "0001" },
    status: 409,
  });

  const eventsToken = environment.events.EVENTS_ORDERS_TOKEN;
  const reservation = await request("reserveCapacity", {
    params,
    internal: eventsToken,
    body: { ...selection, quantity: 2 },
  });
  const issue = {
    params,
    internal: environment.tickets.TICKETS_ORDERS_TOKEN,
    body: {
      ...selection,
      quantity: 2,
      customerId: client.user.id,
      eventName: reservation.eventName,
      eventDate: reservation.eventDate,
      eventVenue: reservation.eventVenue,
      sectorName: reservation.sectorName,
    },
  };
  assert.deepEqual((await request("issueTickets", issue)).items, tickets.items);
  await request("issueTickets", {
    ...issue,
    body: { ...issue.body, quantity: 1 },
    status: 409,
  });
  await request("releaseCapacity", {
    params: { orderId: randomUUID() },
    internal: eventsToken,
    status: 204,
  });
  await request("sendConfirmation", {
    params,
    body: { recipientEmail: fakeEmail, eventName: "Base" },
    status: 401,
  });
  await request("sendConfirmation", {
    params,
    internal: environment.payments.PAYMENTS_ORDERS_TOKEN,
    body: { recipientEmail: fakeEmail, eventName: "Base" },
    status: 403,
  });
  return { ticketId, options };
}

async function paymentRetries() {
  const orderId = randomUUID();
  const payment = {
    params: { orderId },
    internal: environment.payments.PAYMENTS_ORDERS_TOKEN,
    body: { amountMinor: 3500, currency: "BOB", paymentCode: "0000" },
  };
  await request("processPayment", {
    ...payment,
    internal: undefined,
    status: 401,
  });
  for (const invalid of [
    { paymentCode: "123" },
    { paymentCode: "ABCD" },
    { amountMinor: 0 },
  ]) {
    await request("processPayment", {
      ...payment,
      body: { ...payment.body, ...invalid },
      status: 400,
    });
  }
  const [first, repeat] = await Promise.all([
    request("processPayment", payment),
    request("processPayment", {
      ...payment,
      params: { orderId: orderId.toUpperCase() },
    }),
  ]);
  assert.equal(first.status, "declined");
  assert.deepEqual(repeat, first);
  assert.equal(
    (
      await request("processPayment", {
        ...payment,
        body: { ...payment.body, amountMinor: 3501 },
        status: 409,
      })
    ).code,
    "PAYMENT_CONFLICT",
  );
  const pool = new pg.Pool({
    connectionString: environment.payments.DATABASE_URL,
  });
  try {
    const { rows } = await pool.query(
      "SELECT amount_minor, currency, status, processed_at FROM payments WHERE order_id = $1",
      [orderId],
    );
    assert.deepEqual(rows, [
      {
        amount_minor: String(first.amountMinor),
        currency: first.currency,
        status: first.status,
        processed_at: new Date(first.processedAt),
      },
    ]);
  } finally {
    await pool.end();
  }
}

async function partialTicketBatch(actors: Actors, selection: EventSector) {
  const orderId = randomUUID();
  const params = { orderId };
  const body: IssueTickets = {
    ...selection,
    quantity: 2,
    customerId: actors.client.user.id,
    eventName: "Concierto de prueba",
    eventDate: "2026-12-01T19:00:00-04:00",
    eventVenue: "Auditorio José Ballivián",
    sectorName: "Preferencia",
  };
  const issue = {
    params,
    body,
    internal: environment.tickets.TICKETS_ORDERS_TOKEN,
  };
  const list = { query: params, token: actors.client.token };
  const pdfDir = environment.tickets.TICKETS_PDF_DIR;
  const pool = new pg.Pool({
    connectionString: environment.tickets.DATABASE_URL,
  });
  const savedTickets = () =>
    pool.query<{ id: string; code: string }>(
      "SELECT id, code FROM tickets WHERE order_id=$1 ORDER BY ordinal",
      [orderId],
    );
  try {
    await rename(pdfDir, pdfDir + "-temporarily-moved");
    try {
      await request("issueTickets", { ...issue, status: 503 });
    } finally {
      await rename(pdfDir + "-temporarily-moved", pdfDir);
    }
    const { rows: tickets } = await savedTickets();
    assert.equal(tickets.length, body.quantity);
    assert.equal(new Set(tickets.map(({ code }) => code)).size, body.quantity);
    const first = tickets[0];
    const blockedPdf = join(pdfDir, tickets[1].id + ".pdf");
    await mkdir(blockedPdf);
    try {
      await request("issueTickets", { ...issue, status: 503 });
      assert.equal(
        (await readFile(join(pdfDir, first.id + ".pdf")))
          .subarray(0, 5)
          .toString(),
        "%PDF-",
      );
      assert.ok(!(await readdir(pdfDir)).some((name) => name.endsWith(".tmp")));
      assert.deepEqual((await request("listOwnTickets", list)).items, []);
      await request("downloadOwnTicket", {
        token: list.token,
        params: { ticketId: first.id },
        status: 404,
      });
      await request("lookupTicket", {
        internal: environment.checkin.TICKETS_CHECKIN_TOKEN,
        body: { code: first.code },
        status: 404,
      });
    } finally {
      await rm(blockedPdf, { recursive: true });
    }
    const [published, retried] = await Promise.all([
      request("issueTickets", issue),
      request("issueTickets", {
        ...issue,
        params: { orderId: orderId.toUpperCase() },
        body: {
          ...body,
          eventId: body.eventId.toUpperCase(),
          customerId: body.customerId.toUpperCase(),
        },
      }),
    ]);
    assert.deepEqual(retried, published);
    assert.deepEqual((await savedTickets()).rows, tickets);
    assert.deepEqual(
      published.items.map(({ id }) => id),
      tickets.map(({ id }) => id),
    );
    assert.deepEqual(
      (await request("listOwnTickets", list)).items,
      published.items,
    );
    for (const ticket of tickets) {
      const pdf = await request("downloadOwnTicket", {
        token: list.token,
        params: { ticketId: ticket.id },
      });
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
      const match = await request("lookupTicket", {
        internal: environment.checkin.TICKETS_CHECKIN_TOKEN,
        body: { code: ticket.code },
      });
      assert.deepEqual(match, { ticketId: ticket.id, eventId: body.eventId });
    }
  } finally {
    await pool.end();
  }
}

async function ticketCode(ticketId: string): Promise<string> {
  const pool = new pg.Pool({
    connectionString: environment.tickets.DATABASE_URL,
  });
  try {
    const { rows } = await pool.query<{ code: string }>(
      "SELECT code FROM tickets WHERE id=$1",
      [ticketId],
    );
    return rows[0].code;
  } finally {
    await pool.end();
  }
}

async function checkin(
  actors: Actors,
  selection: EventSector,
  ticketId: string,
) {
  const code = await ticketCode(ticketId);
  const { eventId } = selection;
  const lookup = {
    body: { code },
    internal: environment.checkin.TICKETS_CHECKIN_TOKEN,
  };
  assert.equal((await request("lookupTicket", lookup)).ticketId, ticketId);
  await request("lookupTicket", {
    ...lookup,
    internal: environment.tickets.TICKETS_ORDERS_TOKEN,
    status: 403,
  });
  const options = { token: actors.gatekeeper.token, body: { eventId, code } };
  await request("registerCheckin", { body: options.body, status: 401 });
  await request("registerCheckin", {
    ...options,
    token: actors.client.token,
    status: 403,
  });
  await request("getAttendance", {
    token: actors.organizer.token,
    params: { eventId },
    status: 403,
  });
  assert.equal(
    (
      await request("registerCheckin", {
        ...options,
        body: { eventId, code: "inexistente" },
      })
    ).reason,
    "INVALID_CODE",
  );
  assert.equal(
    (
      await request("registerCheckin", {
        ...options,
        body: { eventId: randomUUID(), code },
      })
    ).reason,
    "WRONG_EVENT",
  );
  const scan = await Promise.all([
    request("registerCheckin", options),
    request("registerCheckin", options),
  ]);
  const allowed = scan.find((item) => item.allowed);
  assert.ok(allowed);
  assert.deepEqual(
    scan.find((item) => !item.allowed),
    {
      allowed: false,
      reason: "ALREADY_USED",
      firstAdmittedAt: allowed.admittedAt,
    },
  );
  const total = { token: options.token, params: { eventId } };
  assert.equal((await request("getAttendance", total)).admittedCount, 1);
  assert.equal(
    (
      await request("getAttendance", {
        ...total,
        params: { eventId: randomUUID() },
      })
    ).admittedCount,
    0,
  );
  const pool = new pg.Pool({
    connectionString: environment.checkin.DATABASE_URL,
  });
  try {
    const { rows } = await pool.query(
      "SELECT ticket_id, event_id, gatekeeper_id, admitted_at FROM admissions WHERE ticket_id=$1",
      [ticketId],
    );
    assert(allowed.admittedAt);
    assert.deepEqual(rows, [
      {
        ticket_id: ticketId,
        event_id: eventId,
        gatekeeper_id: actors.gatekeeper.user.id,
        admitted_at: new Date(allowed.admittedAt),
      },
    ]);
  } finally {
    await pool.end();
  }
  await stop("tickets");
  await timeoutEndpoint(environment.tickets.PORT, async () => {
    const error = await request("registerCheckin", { ...options, status: 503 });
    assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
  });
  assert.equal((await request("getAttendance", total)).admittedCount, 1);
  const invalid = createHttpServer((_req, res) => {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ eventId }));
  }).listen(Number(environment.tickets.PORT), "127.0.0.1");
  await once(invalid, "listening");
  try {
    assert.equal(
      (await request("registerCheckin", { ...options, status: 503 })).code,
      "DEPENDENCY_UNAVAILABLE",
    );
    assert.equal((await request("getAttendance", total)).admittedCount, 1);
  } finally {
    await new Promise<void>((done) => invalid.close(() => done()));
  }
  listen("tickets");
  await eventually(() => health("tickets"));
  return code;
}

function purchaseSector(actors: Actors, eventId: string, name: string) {
  return request("createSector", {
    token: actors.organizer.token,
    params: { eventId },
    status: 201,
    body: { name, unitPriceMinor: 2500, capacity: 1 },
  });
}

async function forwardDependency(req: IncomingMessage, origin: string) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return fetch(new URL(req.url ?? "/", origin), {
    method: req.method,
    body: body || undefined,
    signal: AbortSignal.timeout(3000),
    headers: {
      "X-Internal-Token": String(req.headers["x-internal-token"]),
      "Content-Type": "application/json",
    },
  });
}

async function withOrdersDependency(
  variable: "PAYMENTS_URL" | "TICKETS_URL" | "EVENTS_URL" | "NOTIFICATIONS_URL",
  handler: (origin: string) => RequestListener,
  scenario: () => Promise<void>,
) {
  const original = environment.orders[variable];
  const timeout = environment.orders.HTTP_TIMEOUT_MS;
  const proxy = createHttpServer(handler(original)).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    await stop("orders");
    environment.orders[variable] = `http://127.0.0.1:${listeningPort(proxy)}`;
    environment.orders.HTTP_TIMEOUT_MS = "1500";
    listen("orders");
    await eventually(() => health("orders"));
    await scenario();
  } finally {
    await stop("orders");
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
    environment.orders[variable] = original;
    environment.orders.HTTP_TIMEOUT_MS = timeout;
    listen("orders");
    await eventually(() => health("orders"));
  }
}

async function resumePurchases(
  actors: Actors,
  selection: EventSector,
  options: PurchaseRequest,
) {
  const { eventId } = selection;
  const paymentSector = await purchaseSector(
    actors,
    eventId,
    "Pago interrumpido",
  );
  const paymentPurchase = {
    ...options,
    key: randomUUID(),
    body: { ...options.body, sectorId: paymentSector.id, quantity: 1 },
  };
  let completedPayment: PaymentResponse | undefined;
  let paymentCalls = 0;
  await withOrdersDependency(
    "PAYMENTS_URL",
    (origin) => async (req, res) => {
      paymentCalls += 1;
      try {
        const result = await forwardDependency(req, origin);
        if (result.ok) completedPayment = await result.json();
      } catch {
        res.writeHead(502).end();
      }
    },
    async () => {
      const observe = async () => {
        const payment = await eventually(() => {
          assert(completedPayment);
          return completedPayment;
        });
        assert.equal(payment.status, "approved");
        const params = { orderId: payment.orderId };
        const current = await request("getOwnOrder", {
          token: options.token,
          params,
        });
        assert.equal(current.status, "pending");
        assert.equal(current.amountMinor, 2500);
        const repeat = await request("purchaseTickets", {
          ...paymentPurchase,
          status: 202,
        });
        assert.equal(repeat.id, current.id);
        assert.equal(
          (
            await request("purchaseTickets", {
              ...paymentPurchase,
              body: { ...paymentPurchase.body, quantity: 2 },
              status: 409,
            })
          ).code,
          "IDEMPOTENCY_CONFLICT",
        );
        const history = await request("listOwnOrders", {
          token: options.token,
        });
        assert.equal(
          history.items.filter(({ id }) => id === current.id).length,
          1,
        );
        assert.equal(paymentCalls, 1);
        return current.id;
      };
      const [pending, observedId] = await Promise.all([
        request("purchaseTickets", { ...paymentPurchase, status: 202 }),
        observe(),
      ]);
      assert.equal(pending.id, observedId);
      assert.equal(pending.status, "pending");
      const event = await request("getPublishedEvent", { params: { eventId } });
      assert.equal(
        event.sectors.find(({ id }) => id === paymentSector.id)?.available,
        0,
      );
    },
  );

  await request("updateSector", {
    token: actors.organizer.token,
    params: { eventId, sectorId: paymentSector.id },
    body: { name: "Pago interrumpido", unitPriceMinor: 3500, capacity: 1 },
  });
  const resumed = await request("purchaseTickets", paymentPurchase);
  assert.equal(resumed.id, completedPayment?.orderId);
  assert.equal(resumed.ticketStatus, "ready");
  assert.equal(resumed.unitPriceMinor, 2500);
  assert.equal(resumed.amountMinor, 2500);

  const ticketSector = await purchaseSector(
    actors,
    eventId,
    "Emisión interrumpida",
  );
  const ticketPurchase = {
    ...options,
    key: randomUUID(),
    body: { ...options.body, sectorId: ticketSector.id, quantity: 1 },
  };
  const salesOptions = { token: actors.organizer.token, params: { eventId } };
  const sales = await request("getSales", salesOptions);
  let pendingTicket: OrderResponse | undefined;
  await withOrdersDependency(
    "TICKETS_URL",
    () => (_req, res) => {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"items":[]}');
    },
    async () => {
      pendingTicket = await request("purchaseTickets", {
        ...ticketPurchase,
        status: 202,
      });
      assert.equal(pendingTicket.status, "paid");
      assert.equal(pendingTicket.ticketStatus, "pending");
      const liveSales = await request("getSales", salesOptions);
      assert.equal(liveSales.ticketsSold, sales.ticketsSold + 1);
      assert.equal(liveSales.revenueMinor, sales.revenueMinor + 2500);
      assert.deepEqual(
        (
          await request("listOwnTickets", {
            token: options.token,
            query: { orderId: pendingTicket.id },
          })
        ).items,
        [],
      );
    },
  );
  assert(pendingTicket);
  const resumedTicket = await request("purchaseTickets", ticketPurchase);
  assert.equal(resumedTicket.id, pendingTicket.id);
  assert.equal(resumedTicket.ticketStatus, "ready");
}

async function rejectedPurchase(actors: Actors, options: PurchaseRequest) {
  const { eventId } = options.body;
  const sector = await purchaseSector(
    actors,
    eventId,
    "Compensación pendiente",
  );
  const decline = {
    ...options,
    key: randomUUID(),
    body: {
      ...options.body,
      sectorId: sector.id,
      quantity: 1,
      paymentCode: "0000",
    },
  };
  const available = async () => {
    const event = await request("getPublishedEvent", { params: { eventId } });
    return event.sectors.find(({ id }) => id === sector.id)?.available;
  };
  let orderId: string | undefined;
  let attemptedReleases = 0;
  await withOrdersDependency(
    "EVENTS_URL",
    (origin) => async (req, res) => {
      if (req.method === "DELETE") {
        attemptedReleases += 1;
        res
          .writeHead(503, { "Content-Type": "application/json" })
          .end(
            '{"code":"DEPENDENCY_UNAVAILABLE","message":"Cupo temporalmente indisponible."}',
          );
        return;
      }
      try {
        const result = await forwardDependency(req, origin);
        res
          .writeHead(result.status, { "Content-Type": "application/json" })
          .end(await result.text());
      } catch {
        res.writeHead(502).end();
      }
    },
    async () => {
      const pending = await request("purchaseTickets", {
        ...decline,
        status: 202,
      });
      orderId = pending.id;
      assert.equal(pending.status, "pending");
      assert.equal(await available(), 0);
      assert.equal(attemptedReleases, 1);
      assert.equal(
        (
          await request("getOwnOrder", {
            token: options.token,
            params: { orderId },
          })
        ).status,
        "pending",
      );
      assert.equal(attemptedReleases, 1);
    },
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await request("purchaseTickets", {
      ...decline,
      status: 422,
    });
    assert.equal(result.orderId, orderId);
    assert.equal(result.code, "PAYMENT_DECLINED");
  }
  assert.equal(await available(), 1);
  const paid = await request("purchaseTickets", {
    ...decline,
    key: randomUUID(),
    body: { ...decline.body, paymentCode: "1234" },
  });
  assert.equal(paid.status, "paid");
  assert.notEqual(paid.id, orderId);
}

async function notificationWithoutResponse(
  actors: Actors,
  options: PurchaseRequest,
  uiPort: number,
) {
  const { eventId } = options.body;
  const sector = await purchaseSector(
    actors,
    eventId,
    "Confirmación sin respuesta",
  );
  const purchase = {
    ...options,
    key: randomUUID(),
    body: { ...options.body, sectorId: sector.id, quantity: 1 },
  };
  const messageCount = async () => {
    const response = await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`, {
      signal: AbortSignal.timeout(3000),
    });
    const { total } = await response.json();
    return total as number;
  };
  const earlier = await messageCount();
  let calls = 0;
  let persistedStatus: string | undefined;
  let accepted = false;
  let confirmedOrder: string | undefined;
  await withOrdersDependency(
    "NOTIFICATIONS_URL",
    (origin) => async (req, res) => {
      calls += 1;
      try {
        const orderId = req.url?.split("/").at(-1);
        assert(orderId);
        persistedStatus = (
          await request("getOwnOrder", {
            token: options.token,
            params: { orderId },
          })
        ).notificationStatus;
        const result = await forwardDependency(req, origin);
        accepted = result.status === 204;
      } catch {
        res.writeHead(502).end();
      }
    },
    async () => {
      const result = await request("purchaseTickets", purchase);
      confirmedOrder = result.id;
      assert(accepted);
      assert.equal(persistedStatus, "unknown");
      assert.equal(result.notificationStatus, "unknown");
      assert.equal(result.ticketStatus, "ready");
      const repeated = await request("purchaseTickets", purchase);
      assert.equal(repeated.id, result.id);
      assert.equal(repeated.notificationStatus, "unknown");
      assert.equal(calls, 1);
      const { items } = await request("listOwnTickets", {
        token: options.token,
        query: { orderId: result.id },
      });
      assert.equal(items.length, 1);
      await request("downloadOwnTicket", {
        token: options.token,
        params: { ticketId: items[0].id },
      });
    },
  );
  assert.equal((await request("purchaseTickets", purchase)).id, confirmedOrder);
  assert.equal(await messageCount(), earlier + 1);
}

async function scanCancelledEvent(actors: Actors, options: PurchaseRequest) {
  const token = actors.organizer.token;
  const { id: eventId } = await request("createEvent", {
    token,
    body: { ...eventInput, name: "Evento cancelado después de la compra" },
    status: 201,
  });
  const { id: sectorId } = await purchaseSector(actors, eventId, "General");
  await request("updateEventStatus", {
    token,
    params: { eventId },
    body: { status: "published" },
  });
  const purchase = {
    ...options,
    key: randomUUID(),
    body: { ...options.body, eventId, sectorId, quantity: 1 },
  };
  const order = await request("purchaseTickets", purchase);
  const { items } = await request("listOwnTickets", {
    token: options.token,
    query: { orderId: order.id },
  });
  await request("updateEventStatus", {
    token,
    params: { eventId },
    body: { status: "cancelled" },
  });
  const blocked = await request("purchaseTickets", {
    ...purchase,
    key: randomUUID(),
    status: 409,
  });
  assert.equal(blocked.code, "EVENT_UNAVAILABLE");
  assert(blocked.orderId);
  assert.equal(
    (
      await request("getOwnOrder", {
        token: options.token,
        params: { orderId: blocked.orderId },
      })
    ).status,
    "cancelled",
  );
  const scan = await request("registerCheckin", {
    token: actors.gatekeeper.token,
    body: {
      eventId: eventId.toUpperCase(),
      code: await ticketCode(items[0].id),
    },
  });
  assert.equal(scan.allowed, true);
  const attendance = await request("getAttendance", {
    token: actors.gatekeeper.token,
    params: { eventId },
  });
  assert.equal(attendance.admittedCount, 1);
}

async function failures(options: PurchaseRequest, actors: Actors) {
  const mail = {
    params: { orderId: randomUUID() },
    internal: environment.notifications.NOTIFICATIONS_ORDERS_TOKEN,
    body: { recipientEmail: fakeEmail, eventName: "Prueba SMTP" },
    status: 503,
  };
  await stop("mailpit");
  await timeoutEndpoint(environment.notifications.SMTP_PORT, async () => {
    assert.equal(
      (await request("sendConfirmation", mail)).code,
      "SMTP_OUTCOME_UNKNOWN",
    );
  });
  assert.equal((await request("sendConfirmation", mail)).code, "SMTP_FAILED");
  await health("notifications", 503);
  const sector = await request("createSector", {
    token: actors.organizer.token,
    params: { eventId: options.body.eventId },
    body: { name: "Fallo SMTP", unitPriceMinor: 2500, capacity: 1 },
    status: 201,
  });
  const smtpFailed = await request("purchaseTickets", {
    ...options,
    key: randomUUID(),
    body: { ...options.body, sectorId: sector.id, quantity: 1 },
  });
  assert.equal(smtpFailed.status, "paid");
  assert.equal(smtpFailed.notificationStatus, "failed");
  const { items } = await request("listOwnTickets", {
    token: options.token,
    query: { orderId: smtpFailed.id },
  });
  assert.equal(items.length, 1);
  await request("downloadOwnTicket", {
    token: options.token,
    params: { ticketId: items[0].id },
  });

  await stop("notifications");
  const paid = await request("purchaseTickets", {
    ...options,
    key: randomUUID(),
    body: { ...options.body, quantity: 1 },
  });
  assert.equal(paid.status, "paid");
  assert.equal(paid.ticketStatus, "ready");
  assert.equal(paid.notificationStatus, "failed");
  startMailpit();
  listen("notifications");
  await eventually(() => health("notifications"));

  const pdfDir = environment.tickets.TICKETS_PDF_DIR;
  await rename(pdfDir, pdfDir + "-off");
  await health("tickets", 503);
  await rename(pdfDir + "-off", pdfDir);
  await health("tickets");

  run(process.execPath, ["scripts/local.ts", "db:stop"]);
  for (const name of services.filter((item) => item !== "notifications"))
    await health(name, 503);
  run(process.execPath, ["scripts/local.ts", "db:init"]);
  for (const name of services.filter((item) => item !== "notifications"))
    await eventually(() => health(name));
}

try {
  const { uiPort, webPort } = await setup();
  if (process.argv.includes("--browser")) {
    const { verifyBrowser } = await import("./verify-web.ts");
    await verifyBrowser({
      dir, uiPort, webPort, environment, start, stop, listen, health,
      database: (action) => run(process.execPath, ["scripts/local.ts", action]),
      withOrdersDependency, forwardDependency,
    });
  } else {
  const actors = await identities();
  await eventUploads(actors);
  const selection = await catalogue(actors);
  await catalogueRules(actors, selection);
  const { ticketId, options } = await purchases(actors, selection, uiPort);
  await paymentRetries();
  await partialTicketBatch(actors, selection);
  const code = await checkin(actors, selection, ticketId);
  await resumePurchases(actors, selection, options);
  await rejectedPurchase(actors, options);
  await notificationWithoutResponse(actors, options, uiPort);
  await scanCancelledEvent(actors, options);
  await failures(options, actors);
  const output = logs.join("");
  const jsonLogs = output
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.ok(
    jsonLogs.some(
      (entry) =>
        entry.service === "orders" &&
        entry.orderId &&
        entry.date &&
        entry.level &&
        entry.message,
    ),
  );
  assert.ok(
    jsonLogs.some((entry) => entry.service === "checkin" && entry.ticketId),
  );
  for (const level of ["info", "warn"]) {
    assert.ok(
      jsonLogs.some(
        (entry) =>
          entry.service === "notifications" &&
          entry.level === level &&
          entry.orderId &&
          entry.date &&
          entry.message,
      ),
    );
  }
  for (const secret of [
    password,
    fakeEmail,
    code,
    actors.client.token,
    environment.tickets.TICKETS_ORDERS_TOKEN,
  ]) {
    assert.ok(!output.includes(secret), "Dato sensible encontrado en logs.");
  }
  assert.deepEqual([...tested].sort(), [...ops.keys()].sort());
  console.log(
    `Verificación superada: 7 procesos, migraciones en 6 bases, ${tested.size} operaciones, concurrencia y fallos de dependencias.`,
  );
  }
} catch (error) {
  for (const line of logs.join("").trim().split("\n")) {
    // Only show unattributed process startup errors. Request logs are verified separately.
    if (line.startsWith("Error:") || line.startsWith("node:"))
      console.error(line);
  }
  throw error;
} finally {
  await Promise.all([...children.keys()].map(stop));
  let cleaned = true;
  if (postgresEnv) {
    try {
      await access(join(dir, "postgres", "postmaster.pid"));
      run(process.execPath, ["scripts/local.ts", "db:stop"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        cleaned = false;
        console.error(
          "No se pudo detener PostgreSQL de prueba. Directorio conservado:",
          dir,
        );
      }
    }
  }
  if (cleaned) await rm(dir, { recursive: true, force: true });
}
