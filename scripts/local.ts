import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { services } from "../shared/config.ts";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.ENTRADASYA_LOCAL_DIR
  ? resolve(process.env.ENTRADASYA_LOCAL_DIR)
  : fileURLToPath(new URL("../.local/", import.meta.url));
const envDir = join(root, "env");
const dataDir = join(root, "postgres");
const socketDir = join(root, "pg-socket");
const pdfDir = join(root, "tickets-pdf");
const secretsFile = join(root, "secrets.json");
const savedConfig = join(dataDir, "entradasya.conf");
const savedPort = existsSync(savedConfig)
  ? readFileSync(savedConfig, "utf8").match(/^port = (\d+)$/m)?.[1] : undefined;
const databasePort = process.env.ENTRADASYA_PG_PORT ?? savedPort ?? "5432";
const databaseServices = services.filter(
  (service) => service !== "notifications",
);
const orderTargets = ["events", "payments", "tickets", "notifications"];

function secret() {
  return randomBytes(32).toString("hex");
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function makeSecrets() {
  const names = [
    "JWT_SECRET",
    "TICKETS_CHECKIN_TOKEN",
    ...orderTargets.map((service) => `${service.toUpperCase()}_ORDERS_TOKEN`),
    ...databaseServices.map((service) => `${service}_password`),
  ];
  return Object.fromEntries(names.map((name) => [name, secret()]));
}

function prepareDirectories() {
  for (const directory of [root, envDir, socketDir, pdfDir, join(root, 'event-images')]) {
    privateDirectory(directory);
  }
}

function prepare() {
  prepareDirectories();
  if (!existsSync(secretsFile)) {
    writeFileSync(secretsFile, JSON.stringify(makeSecrets(), null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  const secrets: Record<string, string> = JSON.parse(
    readFileSync(secretsFile, "utf8"),
  );
  const ports = Object.fromEntries(
    services.map((service, index) => [service, 3001 + index]),
  );
  const orderTokens = orderTargets.map(
    (service) => `${service.toUpperCase()}_ORDERS_TOKEN`,
  );
  const url = (service: string) => `http://127.0.0.1:${ports[service]}`;
  const specific: Record<string, Record<string, string | number>> = {
    events: { EVENTS_ORDERS_TOKEN: secrets.EVENTS_ORDERS_TOKEN, EVENTS_IMAGES_DIR: join(root, 'event-images') },
    orders: {
      HTTP_TIMEOUT_MS: 3000,
      ...Object.fromEntries(
        orderTargets.map((service) => [
          `${service.toUpperCase()}_URL`,
          url(service),
        ]),
      ),
      ...Object.fromEntries(orderTokens.map((name) => [name, secrets[name]])),
    },
    payments: { PAYMENTS_ORDERS_TOKEN: secrets.PAYMENTS_ORDERS_TOKEN },
    tickets: {
      TICKETS_ORDERS_TOKEN: secrets.TICKETS_ORDERS_TOKEN,
      TICKETS_CHECKIN_TOKEN: secrets.TICKETS_CHECKIN_TOKEN,
      TICKETS_PDF_DIR: pdfDir,
    },
    notifications: {
      NOTIFICATIONS_ORDERS_TOKEN: secrets.NOTIFICATIONS_ORDERS_TOKEN,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: 1025,
      SMTP_FROM: "entradasya@example.test",
      SMTP_TIMEOUT_MS: 2000,
      WEB_BASE_URL: "http://localhost:8080",
    },
    checkin: {
      TICKETS_URL: url("tickets"),
      TICKETS_CHECKIN_TOKEN: secrets.TICKETS_CHECKIN_TOKEN,
      HTTP_TIMEOUT_MS: 3000,
    },
  };

  for (const service of services) {
    const variables: Record<string, string | number> = {
      HOST: "127.0.0.1",
      PORT: ports[service],
      LOG_LEVEL: "info",
    };
    if (databaseServices.includes(service)) {
      variables.DATABASE_URL = `postgresql://${service}_app:${secrets[`${service}_password`]}@127.0.0.1:${databasePort}/${service}_db`;
    }
    if (["auth", "events", "orders", "tickets", "checkin"].includes(service)) {
      variables.JWT_SECRET = secrets.JWT_SECRET;
    }
    const entries = Object.entries({ ...variables, ...specific[service] });
    const contents = entries
      .map(([key, value]) => `${key}=${dotenvValue(value)}\n`)
      .join("");
    writeFileSync(join(envDir, `${service}.env`), contents, { mode: 0o600 });
  }
  console.log(
    `Entornos de servicio y directorio de PDF preparados en ${root}.`,
  );
  return secrets;
}

function dotenvValue(value: string | number) {
  const text = String(value);
  if (text.includes("\n") || text.includes("\r")) {
    throw new Error("Las rutas locales deben ocupar una sola línea.");
  }
  const quote = ['"', "'", "`"].find((candidate) => !text.includes(candidate));
  if (!quote)
    throw new Error("La ruta local contiene los tres tipos de comillas.");
  return `${quote}${text}${quote}`;
}

function postgres(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
) {
  const executable = process.env.PG_BIN
    ? join(process.env.PG_BIN, command)
    : command;
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    ...options,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) {
  const result = postgres(command, args, options);
  if (result.status !== 0)
    throw new Error(`${command} terminó con estado ${result.status}.`);
}

function sqlLiteral(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function startDatabase() {
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    requireSuccess("initdb", [
      "-D",
      dataDir,
      "--auth-local=peer",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
    ]);
  }

  const config =
    [
      "listen_addresses = '127.0.0.1'",
      `port = ${databasePort}`,
      `unix_socket_directories = ${sqlLiteral(socketDir)}`,
      "unix_socket_permissions = 0700",
      "password_encryption = 'scram-sha-256'",
    ].join("\n") + "\n";
  const configFile = join(dataDir, "entradasya.conf");
  const control = ["-D", dataDir];
  const result = postgres("pg_ctl", [...control, "status"], {
    stdio: "ignore",
  });
  if (result.status === 0) {
    if (readFileSync(configFile, "utf8") !== config) {
      throw new Error(
        "Detén PostgreSQL con db:stop antes de cambiar su configuración.",
      );
    }
    return;
  }
  if (result.status !== 3) {
    throw new Error(
      "No se pudo consultar el estado del clúster PostgreSQL local.",
    );
  }

  writeFileSync(configFile, config);
  const mainConfig = join(dataDir, "postgresql.conf");
  const include = "include = 'entradasya.conf'";
  const original = readFileSync(mainConfig, "utf8");
  if (!original.split("\n").includes(include)) {
    writeFileSync(mainConfig, `${original}\n${include}\n`);
  }

  requireSuccess("pg_ctl", [
    ...control,
    "-l",
    join(root, "postgres.log"),
    "-w",
    "start",
  ]);
}

function provisionDatabases(secrets: Record<string, string>) {
  const statements = databaseServices.map((service) => {
    const role = `${service}_app`;
    const database = `${service}_db`;
    const password = sqlLiteral(secrets[`${service}_password`]);
    return `SELECT 'CREATE ROLE ${role} LOGIN' WHERE NOT EXISTS (
  SELECT FROM pg_roles WHERE rolname = '${role}'
) \\gexec
ALTER ROLE ${role} WITH LOGIN PASSWORD ${password} NOSUPERUSER NOCREATEDB NOCREATEROLE;
SELECT 'CREATE DATABASE ${database} OWNER ${role}' WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = '${database}'
) \\gexec
REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;`;
  });
  const input = [
    "SET log_min_error_statement TO PANIC;",
    ...statements,
    "",
  ].join("\n");
  const result = postgres(
    "psql",
    [
      "-X",
      "--no-password",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      socketDir,
      "-p",
      databasePort,
      "-U",
      userInfo().username,
      "-d",
      "postgres",
    ],
    { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      "Falló la preparación de roles y bases. Revisa el clúster y el puerto local.",
    );
  }
  console.log("Seis bases y roles de aplicación preparados.");
}

function verifyDatabases() {
  const secrets: Record<string, string> = JSON.parse(
    readFileSync(secretsFile, "utf8"),
  );
  for (const service of databaseServices) {
    for (const target of databaseServices) {
      const ownDatabase = target === service;
      const sql = ownDatabase
        ? "BEGIN; CREATE TABLE public.__entradasya_local_probe (id integer); ROLLBACK;"
        : "SELECT 1;";
      const result = postgres(
        "psql",
        [
          "-X",
          "--no-password",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-h",
          "127.0.0.1",
          "-p",
          databasePort,
          "-U",
          `${service}_app`,
          "-d",
          `${target}_db`,
          "-c",
          sql,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            LC_ALL: "C",
            PGCONNECT_TIMEOUT: "3",
            PGPASSWORD: secrets[`${service}_password`],
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const expectedDenial =
        result.status === 2 &&
        result.stderr.includes("permission denied for database");
      if (ownDatabase ? result.status !== 0 : !expectedDenial) {
        throw new Error(
          `Resultado inesperado de ${service}_app en ${target}_db: ${result.stderr.trim()}`,
        );
      }
    }
    console.log(
      `OK ${service}_app: escritura en su base y acceso denegado a las otras cinco.`,
    );
  }
}

function stopDatabase() {
  if (!existsSync(join(dataDir, "PG_VERSION"))) return;
  const cluster = ["-D", dataDir];
  const status = postgres("pg_ctl", [...cluster, "status"], { stdio: "ignore" }).status;
  if (status === 3) return;
  if (status !== 0) throw new Error("No se pudo consultar el clúster PostgreSQL local.");
  requireSuccess("pg_ctl", [...cluster, "-m", "fast", "-w", "stop"]);
}

function main() {
  if (
    !/^\d+$/.test(databasePort) ||
    Number(databasePort) < 1 ||
    Number(databasePort) > 65535
  ) {
    throw new Error("ENTRADASYA_PG_PORT debe estar entre 1 y 65535.");
  }
  switch (process.argv[2]) {
    case "prepare":
      prepare();
      break;
    case "db:init": {
      prepareDirectories();
      startDatabase();
      provisionDatabases(prepare());
      verifyDatabases();
      break;
    }
    case "db:verify":
      verifyDatabases();
      break;
    case "db:stop":
      stopDatabase();
      break;
    default:
      throw new Error(
        "Uso: node scripts/local.ts [prepare | db:init | db:verify | db:stop]",
      );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
