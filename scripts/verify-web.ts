import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, RequestListener } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import pg from 'pg';
import QRCode from 'qrcode';

type Environment = Record<string, Record<string, string>>;
type Harness = {
  dir: string;
  uiPort: number;
  webPort: number;
  environment: Environment;
  start(name: string, file: string, args: string[], env: NodeJS.ProcessEnv): void;
  stop(name: string): Promise<void>;
  listen(name: string): void;
  health(name: string, status?: number): Promise<void>;
  database(action: 'db:stop' | 'db:init'): void;
  withOrdersDependency(
    variable: 'PAYMENTS_URL',
    handler: (origin: string) => RequestListener,
    scenario: () => Promise<void>,
  ): Promise<void>;
  forwardDependency(req: IncomingMessage, origin: string): Promise<Response>;
};

const clientEmail = 'cliente-web@example.test';
const otherEmail = 'otro-web@example.test';
const clientPassword = 'demo-cliente';
const fixturePassword = 'demo-entradasya';
const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const launch = (args: string[] = []) => chromium.launch({
  executablePath: chrome, headless: true, args: ['--no-sandbox', ...args],
});

async function check(run: () => Promise<void>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 35; attempt += 1) {
    try { await run(); return; }
    catch (error) { failure = error; await delay(120); }
  }
  throw failure;
}

async function browserPage(browser: Browser, viewport = { width: 1380, height: 960 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(6500);
  page.setDefaultNavigationTimeout(10000);
  return page;
}

async function signin(page: Page, origin: string, email: string, password: string, navigate = true) {
  if (navigate) await page.goto(origin + '/ingresar');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar sesión' }).waitFor();
}

async function register(page: Page, origin: string, email: string, name: string) {
  await page.goto(origin + '/registro');
  await page.getByLabel('Nombre', { exact: true }).fill(name);
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(clientPassword);
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar sesión' }).waitFor();
}

async function createEvent(page: Page, origin: string, name: string, publish: boolean) {
  await page.goto(origin + '/organizar/nuevo');
  await page.getByLabel('Nombre del evento').fill(name);
  await page.getByLabel('Fecha y hora (Bolivia)').fill('2026-12-12T20:30');
  await page.getByLabel('Lugar').fill('Teatro Municipal de La Paz');
  if (publish) await page.getByLabel('URL de la imagen').fill(origin + '/concierto.webp');
  else await page.getByLabel('Subir imagen').setInputFiles(resolve('web/public/eventos-demo/coldplay.webp'));
  await page.getByLabel('Descripción').fill('Una noche de música en vivo en La Paz.');
  await page.getByRole('button', { name: 'Crear borrador' }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  const eventId = new URL(page.url()).pathname.split('/').at(-1)!;
  if (publish) {
    await addSector(page, 'General', '75', '12');
    await page.getByRole('button', { name: 'Publicar evento' }).click();
    await page.getByText('Evento publicado.', { exact: true }).waitFor();
  }
  return eventId;
}

async function addSector(page: Page, name: string, price: string, capacity: string) {
  await page.getByRole('button', { name: 'Agregar sector' }).click();
  await page.getByLabel('Nombre del sector').fill(name);
  await page.getByLabel('Precio en Bs').fill(price);
  await page.getByLabel('Cupo', { exact: true }).fill(capacity);
  await page.getByRole('button', { name: 'Guardar sector' }).click();
  await page.getByRole('button', { name: 'Editar sector ' + name }).waitFor();
}

async function checkout(page: Page, url: string, { code = '1234', quantity = '1', sector = 'General' } = {}) {
  await page.goto(url);
  const select = page.getByLabel('Sector', { exact: true });
  const option = select.locator('option').filter({ hasText: new RegExp('^' + sector + ' ·') });
  await select.selectOption(await option.getAttribute('value') ?? '');
  await page.getByLabel('Cantidad', { exact: true }).fill(quantity);
  await page.getByLabel('Código de pago de prueba').fill(code);
}

async function buy(page: Page) {
  const result = page.waitForResponse((response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirmar compra' }).click();
  return result;
}

async function download(page: Page, path: string, index = 0) {
  const result = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar PDF' }).nth(index).click();
  const file = await result;
  await file.saveAs(path);
  const content = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  const code = content.trim().split('\n').at(-1)?.trim();
  assert.match(code ?? '', /^[A-Za-z0-9_-]{32}$/);
  return code!;
}

async function cameraFile(path: string, code: string) {
  const width = 640;
  const height = 480;
  const qr = QRCode.create(code).modules;
  const scale = 10;
  const side = qr.size * scale;
  const x = (width - side) / 2;
  const y = (height - side) / 2;
  const luminance = Buffer.alloc(width * height, 235);
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (!qr.get(row, col)) continue;
      for (let offset = 0; offset < scale; offset += 1) {
        const start = (y + row * scale + offset) * width + x + col * scale;
        luminance.fill(16, start, start + scale);
      }
    }
  }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luminance, Buffer.alloc(width * height / 2, 128)]);
  await writeFile(path, Buffer.concat([Buffer.from('YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\n'), frame, frame, frame]));
}

async function manual(page: Page, code: string) {
  await page.getByLabel('Código de entrada').fill(code);
  await page.getByRole('button', { name: 'Validar entrada' }).click();
}

async function token(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('entradasya.session') ?? '{}').token);
}

async function configureProxy(harness: Harness) {
  const output = join(harness.dir, 'web');
  await cp(resolve('web/dist'), output, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, ENTRADASYA_LOCAL_DIR: harness.dir, WEB_DIST: output, WEB_PORT: String(harness.webPort),
  };
  for (const service of ['auth', 'events', 'orders', 'tickets', 'checkin']) {
    env[service.toUpperCase() + '_PORT'] = harness.environment[service].PORT;
  }
  harness.start('nginx-web', process.execPath, ['scripts/nginx.ts'], env);
  return output;
}

async function verifyGateway(page: Page, harness: Harness, origin: string, build: string) {
  await check(async () => { assert.equal((await page.request.get(origin + '/health')).status(), 200); });
  const asset = join(build, 'assets/main.js');
  await rename(asset, asset + '.off');
  try { assert.equal((await page.request.get(origin + '/health')).status(), 503); }
  finally { await rename(asset + '.off', asset); }
  assert.equal((await page.request.get(origin + '/health')).status(), 200);
  for (const path of ['/internal/tickets/lookup', '/api/payments', '/api/notifications', '/api/tickets/internal/lookup']) {
    assert.equal((await page.request.get(origin + path)).status(), 404);
  }
  harness.database('db:stop');
  try { await harness.health('auth', 503); await harness.health('events', 503); }
  finally { harness.database('db:init'); }
  await check(() => harness.health('auth'));
  await check(() => harness.health('events'));
}

export async function verifyBrowser(harness: Harness) {
  const { dir, uiPort, webPort } = harness;
  const origin = 'http://127.0.0.1:' + webPort;
  const mailOrigin = 'http://127.0.0.1:' + uiPort;
  const output = await configureProxy(harness);
  const browser = await launch();
  let scanner: Browser | undefined;
  try {
    const visitor = await browserPage(browser);
    await verifyGateway(visitor, harness, origin, output);
    const pool = new pg.Pool({ connectionString: harness.environment.auth.DATABASE_URL });
    try {
      await pool.query("INSERT INTO users (name,email,password_digest,role) VALUES ($1,$2,$3,'organizador')",
        ['Otro organizador', 'otra-organizacion@example.test', createHash('md5').update(fixturePassword).digest('hex')]);
    } finally { await pool.end(); }

    const organizer = await browserPage(browser);
    await signin(organizer, origin, 'organizador@example.test', fixturePassword);
    const eventId = await createEvent(organizer, origin, 'Jazz en La Paz', true);
    const concertUrl = origin + '/eventos/' + eventId;
    const organizerUrl = origin + '/organizar/' + eventId;
    const festival = await createEvent(organizer, origin, 'Festival de la Ciudad', true);
    const draft = await createEvent(organizer, origin, 'Encuentro de Diseño', false);
    await visitor.goto(origin);
    await visitor.getByRole('link', { name: /Jazz en La Paz/ }).waitFor();
    await visitor.getByRole('link', { name: /Festival de la Ciudad/ }).waitFor();
    assert.equal(await visitor.getByRole('link', { name: /Encuentro de Diseño/ }).count(), 0);
    await visitor.getByRole('searchbox').fill('Festival');
    await visitor.getByRole('link', { name: /Festival de la Ciudad/ }).waitFor();
    assert.equal(await visitor.getByRole('link', { name: /Jazz en La Paz/ }).count(), 0);
    await visitor.getByRole('searchbox').fill('');
    await visitor.goto(concertUrl);
    await visitor.getByRole('link', { name: 'Ingresa para comprar' }).waitFor();

    const secondOrganizer = await browserPage(browser);
    await signin(secondOrganizer, origin, 'otra-organizacion@example.test', fixturePassword);
    await secondOrganizer.goto(organizerUrl);
    await secondOrganizer.getByText('El evento no está disponible en tu cuenta.').waitFor();
    const foreignChange = await secondOrganizer.request.put(origin + '/api/events/' + eventId, {
      headers: { Authorization: 'Bearer ' + await token(secondOrganizer) },
      data: { name: 'Cambio ajeno', date: '2026-12-12T20:30:00-04:00', venue: 'La Paz', imageUrl: origin + '/concierto.webp', description: 'Cambio' },
    });
    assert.equal(foreignChange.status(), 404);
    await secondOrganizer.evaluate(() => {
      const key = 'entradasya.session';
      const session = JSON.parse(localStorage.getItem(key)!);
      const [header, claims] = session.token.split('.');
      session.token = [header, claims, 'firma-invalida'].join('.');
      localStorage.setItem(key, JSON.stringify(session));
    });
    await secondOrganizer.goto(origin + '/organizar');
    await secondOrganizer.getByRole('alert').filter({ hasText: 'Tu sesión expiró' }).waitFor();
    await secondOrganizer.getByRole('heading', { name: 'Inicia sesión para continuar' }).waitFor();
    const client = await browserPage(browser);
    await register(client, origin, clientEmail, 'Cliente del navegador');
    const other = await browserPage(browser);
    await register(other, origin, otherEmail, 'Otra cuenta');
    const duplicate = await browserPage(browser);
    await duplicate.goto(origin + '/registro');
    await duplicate.getByLabel('Nombre', { exact: true }).fill('Duplicado');
    await duplicate.getByLabel('Correo electrónico').fill(clientEmail);
    await duplicate.getByLabel('Contraseña').fill(clientPassword);
    await duplicate.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
    await duplicate.getByRole('alert').filter({ hasText: 'correo ya está registrado' }).waitFor();

    await checkout(client, concertUrl, { quantity: '2' });
    const bought = await buy(client);
    assert.equal(bought.status(), 200);
    const purchase = await bought.json();
    await client.getByRole('link', { name: /Ver mis entradas/ }).waitFor();
    await client.goto(origin + '/mis-compras');
    await client.getByText('Compra pagada', { exact: true }).waitFor();
    await client.getByRole('link', { name: 'Ver detalle' }).click();
    await client.getByRole('heading', { name: 'Detalle de compra' }).waitFor();

    const inbox = await browserPage(browser);
    await inbox.goto(mailOrigin);
    await inbox.getByText('Confirmación de EntradasYa', { exact: true }).first().click();
    const messages = await (await inbox.request.get(mailOrigin + '/api/v1/messages')).json();
    assert.equal(messages.messages.length, 1);
    const mail = await (await inbox.request.get(mailOrigin + '/api/v1/message/' + messages.messages[0].ID)).json();
    const ticketLink = origin + '/mis-entradas?orderId=' + purchase.id;
    assert.ok(mail.Text.includes(ticketLink));
    await visitor.goto(ticketLink);
    await visitor.getByRole('heading', { name: 'Inicia sesión para continuar' }).waitFor();
    await visitor.getByRole('link', { name: /Iniciar sesión/ }).last().click();
    await signin(visitor, origin, clientEmail, clientPassword, false);
    assert.equal(visitor.url(), ticketLink);
    await visitor.getByRole('button', { name: /Descargar PDF/ }).first().waitFor();
    const firstCode = await download(visitor, join(dir, 'first.pdf'));
    const secondCode = await download(visitor, join(dir, 'second.pdf'), 1);
    assert.notEqual(firstCode, secondCode);
    const ownList = await (await client.request.get(origin + '/api/tickets?orderId=' + purchase.id, {
      headers: { Authorization: 'Bearer ' + await token(client) },
    })).json();
    await other.goto(ticketLink);
    await other.getByText('Esta orden no tiene entradas disponibles en tu cuenta.').waitFor();
    assert.equal((await other.request.get(origin + ownList.items[0].pdfUrl, {
      headers: { Authorization: 'Bearer ' + await token(other) },
    })).status(), 404);

    await organizer.goto(organizerUrl);
    await organizer.getByText('Entradas vendidas').waitFor();
    await check(async () => {
      assert.deepEqual(await organizer.locator('.metrics dd').allTextContents(), ['2', 'Bs\u00a0150,00']);
    });

    const videoPath = join(dir, 'qr.y4m');
    await cameraFile(videoPath, firstCode);
    scanner = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + videoPath]);
    const gate = await browserPage(scanner);
    await signin(gate, origin, 'portero@example.test', fixturePassword);
    await gate.getByLabel('Evento', { exact: true }).selectOption(eventId);
    await gate.getByRole('button', { name: 'Escanear QR' }).click();
    await gate.getByText('Ingreso permitido', { exact: true }).waitFor();

    const manualGate = await browserPage(browser);
    await manualGate.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () => Promise.reject(new DOMException('Permiso denegado.', 'NotAllowedError')),
      });
    });
    await signin(manualGate, origin, 'portero@example.test', fixturePassword);
    await manualGate.getByLabel('Evento', { exact: true }).selectOption(festival);
    await manual(manualGate, secondCode);
    await manualGate.getByText('Esta entrada corresponde a otro evento', { exact: true }).waitFor();
    await manualGate.getByLabel('Evento', { exact: true }).selectOption(eventId);
    await manualGate.getByRole('button', { name: 'Escanear QR' }).click();
    await manualGate.getByText('No se pudo usar la cámara. Puedes ingresar el código manualmente.').waitFor();
    await manual(manualGate, 'invalido');
    await manualGate.getByText('Código inválido', { exact: true }).waitFor();
    await manual(manualGate, secondCode);
    await manualGate.getByText('Ingreso permitido', { exact: true }).waitFor();
    await manual(manualGate, secondCode);
    await manualGate.getByText('Entrada ya utilizada', { exact: true }).waitFor();
    await manualGate.getByText(/Primer ingreso/).waitFor();
    await check(async () => { assert.equal(await manualGate.locator('.count-panel .number').innerText(), '2'); });

    await organizer.goto(origin + '/organizar/' + draft);
    await addSector(organizer, 'Preferencia', '120', '4');
    await organizer.getByRole('button', { name: 'Editar sector Preferencia' }).click();
    await organizer.getByLabel('Cupo', { exact: true }).fill('5');
    await organizer.getByRole('button', { name: 'Guardar sector' }).click();
    await organizer.getByText(/5 de 5 disponibles/).waitFor();
    await organizer.getByLabel('Lugar').fill('Centro Cultural de La Paz');
    await organizer.getByLabel('Subir imagen').setInputFiles(resolve('web/public/eventos-demo/dua-lipa.webp'));
    await organizer.getByAltText('Vista previa de la imagen seleccionada').waitFor();
    const uploaded = organizer.waitForResponse((response) =>
      response.url().endsWith('/api/events/images') && response.request().method() === 'POST');
    await organizer.getByRole('button', { name: 'Guardar cambios' }).click();
    const uploadResponse = await uploaded;
    assert.equal(uploadResponse.status(), 201);
    const { imagePath } = await uploadResponse.json();
    assert.match(imagePath, /^\/api\/events\/images\//);
    await organizer.getByText('Cambios guardados.', { exact: true }).waitFor();
    assert.equal((await visitor.request.get(origin + imagePath)).headers()['content-type'], 'image/webp');
    await organizer.getByRole('button', { name: 'Publicar evento' }).click();
    await organizer.getByText('Evento publicado.', { exact: true }).waitFor();
    await visitor.goto(origin);
    await visitor.getByRole('link', { name: /Encuentro de Diseño/ }).waitFor();
    const picture = visitor.locator('.event-card').filter({ hasText: 'Encuentro de Diseño' }).locator('img');
    assert.equal(await picture.getAttribute('src'), origin + imagePath);
    await picture.evaluate((image) => (image as HTMLImageElement).decode());
    await visitor.getByText('Centro Cultural de La Paz', { exact: true }).waitFor();
    if (process.env.WEB_SCREENSHOT_DIR) {
      const screenshots = resolve(process.env.WEB_SCREENSHOT_DIR);
      await visitor.screenshot({ path: join(screenshots, 'cartelera.png'), fullPage: true });
      await organizer.screenshot({ path: join(screenshots, 'organizador.png'), fullPage: true });
      const mobile = await browserPage(browser, { width: 390, height: 845 });
      await mobile.goto(origin);
      await mobile.getByRole('link', { name: /Jazz en La Paz/ }).waitFor();
      await mobile.screenshot({ path: join(screenshots, 'movil.png'), fullPage: true });
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
    }
    await organizer.getByRole('button', { name: 'Cancelar evento' }).click();
    await organizer.getByRole('button', { name: 'Confirmar cancelación' }).click();
    await organizer.getByText('Evento cancelado.', { exact: true }).waitFor();
    assert.equal((await visitor.request.get(origin + '/api/events/' + draft)).status(), 404);

    await verifyPurchaseFailures(harness, { client, other, organizer, gate: manualGate, origin, eventId, concertUrl, organizerUrl });
    console.log('Aceptación web superada en Chromium a través de Nginx, con Mailpit, descargas PDF y cámara simulada.');
  } finally {
    await scanner?.close();
    await browser.close();
  }
}

type CheckoutFixture = {
  client: Page; other: Page; organizer: Page; gate: Page;
  origin: string; eventId: string; concertUrl: string; organizerUrl: string;
};

async function verifyPurchaseFailures(harness: Harness, fixture: CheckoutFixture) {
  const { client, other, organizer, gate, origin, eventId, concertUrl, organizerUrl } = fixture;
  await organizer.goto(organizerUrl);
  await addSector(organizer, 'Pago de prueba', '40', '1');
  await checkout(client, concertUrl, { code: '0000', sector: 'Pago de prueba' });
  const denied = await buy(client);
  const declined = await denied.json();
  assert.equal(denied.status(), 422);
  await client.getByRole('alert').filter({ hasText: 'Pago rechazado' }).waitFor();
  const declinedRequest = denied.request();
  const savedKey = (await declinedRequest.allHeaders())['idempotency-key'];
  const repeated = await client.request.post(origin + '/api/orders', {
    headers: { Authorization: 'Bearer ' + await token(client), 'Idempotency-Key': savedKey },
    data: declinedRequest.postDataJSON(),
  });
  assert.equal(repeated.status(), 422);
  assert.equal((await repeated.json()).orderId, declined.orderId);
  await checkout(client, concertUrl, { sector: 'Pago de prueba' });
  assert.equal((await buy(client)).status(), 200);

  await organizer.goto(organizerUrl);
  await addSector(organizer, 'Último cupo', '35', '1');
  await Promise.all([
    checkout(client, concertUrl, { sector: 'Último cupo' }),
    checkout(other, concertUrl, { sector: 'Último cupo' }),
  ]);
  const simultaneous = await Promise.all([buy(client), buy(other)]);
  assert.deepEqual(simultaneous.map((response) => response.status()).sort(), [200, 409]);
  const exhausted = simultaneous.find((item) => item.status() === 409)!;
  assert.equal((await exhausted.json()).code, 'SOLD_OUT');
  await (simultaneous[0] === exhausted ? client : other).getByRole('alert').filter({ hasText: 'Agotado' }).waitFor();
  const winner = simultaneous[0] === exhausted ? other : client;
  await winner.getByRole('link', { name: /Ver mis entradas/ }).click();
  const unscanned = await download(winner, join(harness.dir, 'last.pdf'));

  await harness.stop('notifications');
  try {
    await checkout(client, concertUrl);
    const response = await buy(client);
    assert.equal(response.status(), 200);
    const paid = await response.json();
    assert.equal(paid.notificationStatus, 'failed');
    await client.getByText(/Correo no enviado/).waitFor();
    await client.goto(origin + '/mis-compras/' + paid.id);
    await client.getByText(/Correo no enviado/).waitFor();
    await client.getByRole('link', { name: /Ver entradas/ }).click();
    await download(client, join(harness.dir, 'sin-correo.pdf'));
  } finally {
    harness.listen('notifications');
    await check(() => harness.health('notifications'));
  }

  await harness.stop('tickets');
  let pendingId: string;
  try {
    await checkout(client, concertUrl);
    const result = await buy(client);
    assert.equal(result.status(), 202);
    const pending = await result.json();
    assert.equal(pending.status, 'paid');
    pendingId = pending.id;
    await client.getByText(/Emisión pendiente/).waitFor();
    await client.reload();
    await client.getByRole('button', { name: 'Reanudar compra' }).waitFor();
    await manual(gate, unscanned);
    await gate.getByRole('alert').filter({ hasText: 'Dependencia temporalmente indisponible' }).waitFor();
    assert.equal(await gate.locator('.count-panel .number').innerText(), '2');
  } finally {
    harness.listen('tickets');
    await check(() => harness.health('tickets'));
  }
  const secondGate = await gate.context().newPage();
  await secondGate.goto(origin + '/ingreso');
  await secondGate.getByLabel('Evento', { exact: true }).selectOption(eventId);
  const acceptScan = (page: Page) => page.waitForResponse((response) => response.url().endsWith('/api/checkins') && response.request().method() === 'POST');
  const scans = [acceptScan(gate), acceptScan(secondGate)];
  await Promise.all([manual(gate, unscanned), manual(secondGate, unscanned)]);
  const results = await Promise.all(scans.map(async (entry) => (await entry).json()));
  const accepted = results.find((entry) => entry.allowed);
  assert(accepted);
  assert.deepEqual(results.find((entry) => !entry.allowed), {
    allowed: false, reason: 'ALREADY_USED', firstAdmittedAt: accepted.admittedAt,
  });
  await secondGate.close();

  await client.goto(origin + '/mis-compras/' + pendingId);
  await client.getByText(/Emisión pendiente/).waitFor();
  const paymentRetry = client.waitForResponse((response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
  await client.getByRole('button', { name: 'Reanudar compra' }).click();
  const resumed = await paymentRetry;
  assert.equal(resumed.status(), 200);
  assert.equal((await resumed.json()).id, pendingId);
  await client.getByRole('link', { name: /Ver entradas/ }).click();
  const recoveredCode = await download(client, join(harness.dir, 'recovered.pdf'));
  await manual(gate, recoveredCode);
  await gate.getByText('Ingreso permitido', { exact: true }).waitFor();

  let paymentOrder: string | undefined;
  let fetchKey: string | undefined;
  let fetchBody: object;
  await harness.withOrdersDependency('PAYMENTS_URL', (target) => async (req, res) => {
    try {
      const upstream = await harness.forwardDependency(req, target);
      assert.equal(upstream.status, 200);
      paymentOrder = (await upstream.json()).orderId;
    } catch { res.writeHead(502).end(); }
  }, async () => {
    await checkout(client, concertUrl);
    const result = await buy(client);
    assert.equal(result.status(), 202);
    assert.equal((await result.json()).id, paymentOrder);
    fetchKey = (await result.request().allHeaders())['idempotency-key'];
    fetchBody = result.request().postDataJSON();
    await client.getByRole('button', { name: 'Reanudar compra' }).waitFor();
  });
  const observed = client.waitForResponse((response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST');
  await client.getByRole('button', { name: 'Reanudar compra' }).click();
  const recovered = await observed;
  assert.equal(recovered.status(), 200);
  assert.equal((await recovered.json()).id, paymentOrder);
  assert.equal((await recovered.request().allHeaders())['idempotency-key'], fetchKey);
  assert.deepEqual(recovered.request().postDataJSON(), fetchBody!);
  const altered = await client.request.post(origin + '/api/orders', {
    headers: { Authorization: 'Bearer ' + await token(client), 'Idempotency-Key': fetchKey! },
    data: { ...recovered.request().postDataJSON(), paymentCode: '4321' },
  });
  assert.equal(altered.status(), 409);

  for (const quantity of [0, 7, 1.5]) {
    assert.equal((await client.request.post(origin + '/api/orders', {
      headers: { Authorization: 'Bearer ' + await token(client), 'Idempotency-Key': randomUUID() },
      data: { ...recovered.request().postDataJSON(), quantity },
    })).status(), 400);
  }
  assert.equal(new URL(client.url()).pathname, '/eventos/' + eventId);
}
