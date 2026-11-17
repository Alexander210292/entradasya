import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { connect, transaction } from "../shared/db.ts";

import { editorialEvents } from "../shared/editorial-events.ts";

const demos = editorialEvents.map((event) => ({
  ...event,
  sectors: [
    { name: event.category === "Deportes" ? "Tribuna general" : "General", unitPriceMinor: event.prices[0], capacity: 250 },
    { name: "Preferencia", unitPriceMinor: event.prices[1], capacity: 80 },
  ],
}));

async function main() {
  const localDir = process.env.ENTRADASYA_LOCAL_DIR ?? fileURLToPath(new URL("../.local/", import.meta.url));
  process.loadEnvFile(resolve(localDir, "env", "events.env"));
  const stackPath = resolve(localDir, "stack.json");
  const running: { url?: string; ready?: boolean } = existsSync(stackPath)
    ? JSON.parse(readFileSync(stackPath, "utf8")) : {};
  const web = new URL(process.env.WEB_BASE_URL
    ?? (process.env.WEB_PORT ? `http://localhost:${process.env.WEB_PORT}` : undefined)
    ?? (running.ready ? running.url : undefined)
    ?? "http://localhost:8080");
  if (!["http:", "https:"].includes(web.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(web.hostname)) {
    throw new Error("El seed requiere una instancia local de EntradasYa.");
  }

  const headers = { "Content-Type": "application/json" };
  const login = await fetch(new URL("/api/auth/login", web), {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "organizador@example.test", password: "demo-entradasya" }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!login.ok) throw new Error("No se pudo iniciar sesión con el organizador de prueba.");
  const { user }: { user: { id: string; role: string } } = await login.json();
  if (user.role !== "organizador") throw new Error("La cuenta de prueba debe tener el rol organizador.");

  const events = await Promise.all(demos.map(async (event) => {
    const imageUrl = new URL("/eventos-demo/" + event.image, web);
    const cover = await fetch(imageUrl, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!cover.ok || cover.headers.get("content-type") !== "image/webp") {
      throw new Error(`Portada no disponible para ${event.name}. Ejecuta npm run build:web.`);
    }
    return { ...event, imageUrl: imageUrl.href };
  }));

  const pool = connect();
  try {
    const inserted = await transaction(pool, async (client) => {
      const names: string[] = [];
      for (const event of events) {
        const created = await client.query(
          `INSERT INTO events (id, organizer_id, name, date, venue, image_url, description, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'published') ON CONFLICT (id) DO NOTHING`,
          [event.id, user.id, event.name, event.date, event.venue, event.imageUrl, event.description],
        );
        if (!created.rowCount) continue;
        for (const sector of event.sectors) {
          await client.query(
            "INSERT INTO sectors (event_id, name, unit_price_minor, capacity) VALUES ($1,$2,$3,$4)",
            [event.id, sector.name, sector.unitPriceMinor, sector.capacity],
          );
        }
        names.push(event.name);
      }
      return names;
    });
    console.log(inserted.length ? `Eventos ficticios publicados · ${inserted.join(", ")}` : "El seed ya está aplicado.");
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
