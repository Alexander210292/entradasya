# payments

Pago simulado interno. Está escrito en TypeScript y usa Node.js 24.20.0 con Express.

Prepara [la base local](../../docs/desarrollo-local.md#preparar-la-base-local) desde la raíz. El arranque lee `.local/env/payments.env` y permite sobrescribir sus valores mediante el entorno del proceso. Consulta [.env.example](.env.example) para las variables de este servicio.

La migración inicial pertenece a `payments_db` y se ejecuta con el rol `payments_app`.

```sh
npm ci
npm run migrate -- payments
npm start -- payments
```

Desde otra terminal, comprueba que responde con HTTP 200 y `{"status":"ok"}`.

```sh
curl -fsS http://127.0.0.1:3004/health
```

Las operaciones de aplicación están en el [contrato OpenAPI](../../docs/openapi.yaml).
