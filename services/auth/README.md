# auth

Registro e inicio de sesión. Está escrito en TypeScript y usa Node.js 24.20.0 con Express.

Prepara [la base local](../../docs/desarrollo-local.md#preparar-la-base-local) desde la raíz. El arranque lee `.local/env/auth.env` y permite sobrescribir sus valores mediante el entorno del proceso. Consulta [.env.example](.env.example) para las variables de este servicio.

Las migraciones se ejecutan en `auth_db` con el rol `auth_app`. PostgreSQL exige correo normalizado en minúsculas y digest MD5 hexadecimal. La carga inicial es repetible. Las cuentas ficticias son `organizador@example.test` y `portero@example.test`, ambas con contraseña `demo-entradasya`.

```sh
npm ci
npm run migrate -- auth
npm run seed:auth
npm start -- auth
```

Desde otra terminal, comprueba que responde con HTTP 200 y `{"status":"ok"}`.

```sh
curl -fsS http://127.0.0.1:3001/health
```

Las operaciones de aplicación están en el [contrato OpenAPI](../../docs/openapi.yaml).
