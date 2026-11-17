# events

Cartelera, sectores y reservas de cupo. Está escrito en TypeScript y usa Node.js 24.20.0 con Express.

Prepara [la base local](../../docs/desarrollo-local.md#preparar-la-base-local) desde la raíz. El arranque lee `.local/env/events.env` y permite sobrescribir sus valores mediante el entorno del proceso. Consulta [.env.example](.env.example) para las variables de este servicio.

Las migraciones se ejecutan en `events_db` con el rol `events_app`. Una clave foránea compuesta garantiza que el sector de una reserva pertenece al evento indicado.

```sh
npm ci
npm run migrate -- events
npm start -- events
```

Desde otra terminal, comprueba que responde con HTTP 200 y `{"status":"ok"}`.

```sh
curl -fsS http://127.0.0.1:3002/health
```

Las operaciones de aplicación están en el [contrato OpenAPI](../../docs/openapi.yaml).

Los organizadores pueden subir portadas con `POST /api/events/images`. El cuerpo JSON contiene `content` con el archivo en base64. El servicio admite JPEG, PNG y WebP de hasta 5 MiB, los decodifica y guarda como WebP en `EVENTS_IMAGES_DIR`. El directorio se prepara en `.local/event-images/` al arrancar el proyecto y su acceso se comprueba en `/health`. La respuesta devuelve `imagePath`, una ruta pública que la web convierte en URL para crear o editar el evento.
