# Desarrollo local

## Dependencias y puertos propuestos

Para preparar Windows con WSL2 y Ubuntu, sigue el [arranque del README](../README.md#arranque-en-windows). El instalador `bash scripts/setup-wsl.sh` prepara las dependencias y deja la aplicación activa con sus eventos de demostración.

Instalar Node.js con npm, Nginx, PostgreSQL y Mailpit en el equipo. Usar el navegador del mismo equipo para la demo, incluido el permiso de cámara para el QR. La entrada manual de código permite completar el flujo sin cámara.

| Componente | Dirección local | Base o recurso |
| --- | --- | --- |
| Nginx y web | `http://localhost:8080` | Compilación estática de React con TypeScript. |
| auth | `http://127.0.0.1:3001` | `auth_db` / `auth_app` |
| events | `http://127.0.0.1:3002` | `events_db` / `events_app` |
| orders | `http://127.0.0.1:3003` | `orders_db` / `orders_app` |
| payments | `http://127.0.0.1:3004` | `payments_db` / `payments_app` |
| tickets | `http://127.0.0.1:3005` | `tickets_db` / `tickets_app` y directorio local de PDF. |
| notifications | `http://127.0.0.1:3006` | Mailpit por SMTP. |
| checkin | `http://127.0.0.1:3007` | `checkin_db` / `checkin_app` |
| PostgreSQL | `127.0.0.1:5432` | Seis bases y seis usuarios de aplicación. |
| Mailpit | `127.0.0.1:1025` (SMTP) y `http://localhost:8025` (bandeja) | Correo de prueba. |

Nginx debe conservar la ruta completa y las cabeceras de autorización e idempotencia al enviar peticiones API. Enrutar `/api/auth/`, `/api/events` y subrutas, `/api/orders` y subrutas, `/api/tickets` y subrutas, y `/api/checkins` y subrutas al backend correspondiente. Reservar las rutas de interfaz para el frontend. Configurar `GET /health` de la web para comprobar que se puede servir la compilación. Cada backend expone `/health` en su puerto local y comprueba su propia base o carpeta donde corresponda. Notifications comprueba SMTP.

## Variables de entorno acordadas

| Componentes | Variables |
| --- | --- |
| Backends | `HOST` (`127.0.0.1`), `PORT` y `LOG_LEVEL` (`info`). |
| Servicios con persistencia | `DATABASE_URL` para la base y el usuario propios. |
| auth, events, orders, tickets, checkin | `JWT_SECRET` compartido para firmar o validar JWT. |
| orders | `EVENTS_URL`, `PAYMENTS_URL`, `TICKETS_URL`, `NOTIFICATIONS_URL` y `HTTP_TIMEOUT_MS`. |
| checkin | `TICKETS_URL`, `TICKETS_CHECKIN_TOKEN` y `HTTP_TIMEOUT_MS`. |
| orders y cada destino interno | `EVENTS_ORDERS_TOKEN`, `PAYMENTS_ORDERS_TOKEN`, `TICKETS_ORDERS_TOKEN` o `NOTIFICATIONS_ORDERS_TOKEN`, según corresponda. Tickets también recibe `TICKETS_CHECKIN_TOKEN`. |
| tickets | `TICKETS_PDF_DIR` con ruta absoluta y permisos de lectura y escritura. |
| events | `EVENTS_IMAGES_DIR` con ruta absoluta y permisos de lectura y escritura para las portadas subidas. |
| notifications | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_TIMEOUT_MS` y `WEB_BASE_URL`. |
| web y Nginx | Base API relativa `/api` en la web. Puerto de escucha, directorio estático y destinos de proxy parametrizados en la configuración local de Nginx. |

Usar como valores iniciales 3000 ms para HTTP y 2000 ms para SMTP. Dejar al proxy tiempo suficiente para la secuencia de llamadas internas. Mantener las credenciales locales en el entorno y documentar los nombres de variables en ejemplos sin valores secretos.

## Preparar la base local

Desde la raíz del proyecto, usa la versión de Node.js de `.nvmrc` y ejecuta estos comandos como tu usuario normal. Para PostgreSQL se necesitan `initdb`, `pg_ctl` y `psql`. Si están fuera de `PATH`, indica el directorio que los contiene con `PG_BIN`.

```sh
node scripts/local.ts db:init
node scripts/local.ts db:verify
```

`db:init` crea y arranca el clúster del proyecto en `.local/postgres/`, prepara seis roles y bases y verifica sus permisos. Cada rol debe poder crear una tabla dentro de una transacción que se revierte en su propia base, y debe recibir una denegación explícita al acceder a cada una de las otras cinco. El comando se puede repetir y conserva los datos y las credenciales. El log del clúster queda en `.local/postgres.log`.

El clúster se administra mediante un socket privado. Al preparar una instalación nueva, `npm run start:local` elige el puerto 5432 o, si está ocupado, 5433. La elección queda guardada para los siguientes arranques. Al ejecutar `db:init` directamente, el puerto inicial es 5432; puedes elegir otro con `ENTRADASYA_PG_PORT`. Para cambiar el puerto del clúster del proyecto mientras está activo, detenlo primero con `node scripts/local.ts db:stop`.

El comando también genera `.local/env/<servicio>.env` para cada backend y crea `.local/tickets-pdf/`. `node scripts/local.ts prepare` genera esos recursos sin arrancar PostgreSQL. Cada backend carga su archivo de entorno al iniciar y acepta valores del entorno del proceso con prioridad. Los archivos generados y las credenciales quedan excluidos de Git.

Descarga el binario de Mailpit desde su [guía oficial de instalación](https://mailpit.axllent.org/docs/install/) y colócalo en `PATH` o en `.local/bin/`. Arráncalo en otra terminal y consulta la bandeja en [localhost:8025](http://localhost:8025).

```sh
PATH="$PWD/.local/bin:$PATH" mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --disable-version-check
```

En la estación Fedora donde se verificó la base, PostgreSQL 18.3 se extrajo de los RPM a `.local/tools/pgsql/` y el binario de Mailpit se dejó en `.local/bin/mailpit`. Para usar esa copia de PostgreSQL desde una terminal nueva, define estas variables desde la raíz del proyecto.

```sh
export PG_BIN="$PWD/.local/tools/pgsql/usr/bin"
export LD_LIBRARY_PATH="$PWD/.local/tools/pgsql/usr/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

## Arranque de los componentes

Instala las dependencias de Node.js una vez con `npm ci`. Para el trabajo diario ejecuta estos comandos desde la raíz.

```sh
npm run start:local
npm run stop:local
```

El arranque prepara PostgreSQL, aplica migraciones, carga las cuentas de prueba, compila la web e inicia Mailpit, los siete backends y Nginx en segundo plano. Devuelve el control cuando los chequeos de salud pasan. Si ya está en ejecución, muestra la URL del proceso existente. Los logs quedan en `.local/app.log` y puedes seguirlos con `tail -f .local/app.log`.

El apagado detiene el clúster PostgreSQL del proyecto y los procesos iniciados por el lanzador. Conserva bases, PDF, eventos ficticios y la bandeja de Mailpit del proyecto. Si ya había una instancia de Mailpit disponible fuera del lanzador, se reutiliza y sigue activa.

El lanzador imprime la URL web efectiva y la de [Mailpit](http://localhost:8025/). Usa el puerto 8080 cuando está disponible y prueba 8088 si está ocupado. Puedes elegir otro con `WEB_PORT=8090 npm run start:local`. El enlace del correo usa el puerto elegido. `WEB_BASE_URL` permite indicar otro origen local para las confirmaciones. El lanzador usa `flock` de util-linux y `/proc` en Linux para coordinar el arranque y el apagado.

### Arranque por separado

1. Ejecuta `npm ci`, prepara PostgreSQL y arranca Mailpit.
2. Ejecuta `npm run migrate -- <servicio>` para auth, events, payments, tickets, orders y checkin. Luego ejecuta `npm run seed:auth`.
3. Ejecuta `npm start -- <servicio>` en una terminal por backend y comprueba su puerto con `GET /health`.
4. Ejecuta `npm run build:web`, valida la configuración con `npm run start:web -- --check` y arranca Nginx con `npm run start:web`. Si eliges otro puerto, ajusta `WEB_PORT` para Nginx y `WEB_BASE_URL` para notifications.

Nginx escucha en loopback y carga su configuración en `.local/nginx/`. Usa el binario en `PATH` o el especificado por `NGINX_BIN`. En la estación Fedora también funciona la copia local en `.local/tools/nginx/usr/bin/nginx`. Los puertos de proxy pueden sobrescribirse con `AUTH_PORT`, `EVENTS_PORT`, `ORDERS_PORT`, `TICKETS_PORT` y `CHECKIN_PORT` al iniciar Nginx por separado.

Consulta el README de [auth](../services/auth/README.md), [events](../services/events/README.md), [payments](../services/payments/README.md), [tickets](../services/tickets/README.md), [notifications](../services/notifications/README.md), [orders](../services/orders/README.md), [checkin](../services/checkin/README.md) o [web](../web/README.md) para ver sus comandos y variables.

## Verificar la base

`npm run typecheck` verifica los backends, los scripts y React con TypeScript estricto. Node.js ejecuta directamente los archivos `.ts` de los backends y scripts. `npm run build:web` genera los archivos estáticos del navegador.

`npm run verify:base` arranca PostgreSQL, Mailpit y los siete backends en un directorio y puertos desechables. Usa las herramientas PostgreSQL que estén en `PATH` o `PG_BIN` y encuentra Mailpit en `MAILPIT_BIN`, `.local/bin/mailpit` o `PATH`. Comprueba migraciones y permisos, rutas del contrato, roles y propiedad, salud frente a caídas, timeouts y logs. También prueba reanudación de compra y doble escaneo. Complementa esa prueba con `npm run verify:web` para recorrer la interfaz por Nginx. La [matriz de aceptación integral](aceptacion.md) describe ambos comandos y sus comprobaciones.

## Bitácora

Agregar una fila por incidencia durante el desarrollo y el arranque local.

| Fecha | Componente | Versión o entorno | Síntoma | Diagnóstico | Resolución y comprobación |
| --- | --- | --- | --- | --- | --- |
| 2026-11-16 | PostgreSQL y Mailpit | Fedora 45, Node.js 24.20.0 | Las herramientas no estaban disponibles en `PATH`. | El entorno requería binarios locales. | Se usaron PostgreSQL 18.3 y Mailpit 1.33.1 desde `.local/`. Se comprobó el aislamiento de las seis bases y la recepción de un correo SMTP ficticio en la bandeja. |
| 2026-11-16 | Compilación web | Node.js 24.20.0, npm 11.19.0 | El postinstall de esbuild recibió EPERM bajo el sandbox de Codex. | El sandbox restringía la ejecución del binario durante la instalación. | La instalación y compilación se verificaron con acceso local autorizado. |
