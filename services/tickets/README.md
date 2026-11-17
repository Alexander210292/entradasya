# tickets

Emisión, descarga y validación de entradas. Está escrito en TypeScript y usa Node.js 24.20.0 con Express.

Prepara [la base local](../../docs/desarrollo-local.md#preparar-la-base-local) desde la raíz. El arranque lee `.local/env/tickets.env` y permite sobrescribir sus valores mediante el entorno del proceso. Consulta [.env.example](.env.example) para las variables de este servicio.

La migración inicial pertenece a `tickets_db` y se ejecuta con el rol `tickets_app`. El proceso comprueba acceso al directorio de PDF configurado en `TICKETS_PDF_DIR`.

```sh
npm ci
npm run migrate -- tickets
npm start -- tickets
```

Desde otra terminal, comprueba que responde con HTTP 200 y `{"status":"ok"}`.

```sh
curl -fsS http://127.0.0.1:3005/health
```

Las operaciones de aplicación están en el [contrato OpenAPI](../../docs/openapi.yaml).
