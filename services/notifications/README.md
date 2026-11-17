# notifications

Confirmación interna mediante Mailpit. Está escrito en TypeScript y usa Node.js 24.20.0 con Express.

Prepara [la base local](../../docs/desarrollo-local.md#preparar-la-base-local) desde la raíz. El arranque lee `.local/env/notifications.env` y permite sobrescribir sus valores mediante el entorno del proceso. Consulta [.env.example](.env.example) para las variables de este servicio.

Requiere Mailpit activo. El chequeo de salud verifica su conexión SMTP.

```sh
npm ci
npm start -- notifications
```

Desde otra terminal, comprueba que responde con HTTP 200 y `{"status":"ok"}`.

```sh
curl -fsS http://127.0.0.1:3006/health
```

Las operaciones de aplicación están en el [contrato OpenAPI](../../docs/openapi.yaml).
