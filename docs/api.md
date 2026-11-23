# Convenciones de la API

El [contrato OpenAPI](openapi.yaml) fija las rutas, los cuerpos y las respuestas. La API pública pasa por Nginx. Las operaciones `/internal/` y los chequeos de backend se invocan en sus puertos locales. Las acciones de la web usan rutas de interfaz como `/mis-entradas?orderId=<id>`.

## Acceso y formatos

- `auth` compara el digest hexadecimal MD5 de la contraseña y entrega un JWT HS256 de una hora con `sub` (ID de usuario), `role`, `iat` y `exp`. Los backends públicos validan firma y expiración con una clave de entorno y comprueban el rol y la propiedad aplicables. La web envía `Authorization: Bearer <token>`. En la compra, el cliente indica el correo que recibirá el enlace. La descarga siempre exige la sesión del titular.
- Las rutas internas exigen `X-Internal-Token`. Configurar un secreto distinto por destino y por consumidor cuando haya dos consumidores. Events, payments, tickets (emisión) y notifications aceptan únicamente la credencial de orders. Tickets (validación) acepta únicamente la de checkin.
- Los identificadores públicos son UUID. El código QR es un valor opaco y se transmite en un cuerpo JSON para validar. Las fechas usan ISO 8601 con zona horaria. `amountMinor`, `unitPriceMinor` y `revenueMinor` representan centavos de BOB. El precio del cliente se obtiene del catálogo y el precio definitivo lo fija la reserva.
- Los listados devuelven `items`. El contrato inicial contempla conjuntos pequeños en el entorno local.
- Los errores HTTP devuelven `{"code":"SOLD_OUT","message":"Agotado"}`. Los códigos son estables. La interfaz presenta el mensaje de negocio y usa el código para decidir la acción.

## Portadas de eventos

El organizador puede subir una portada desde el formulario. La web envía el contenido en base64 por JSON a `POST /api/events/images`, con JWT de organizador. El servicio acepta JPEG, PNG y WebP de hasta 5 MiB, comprueba que sean imágenes decodificables y las guarda en disco como WebP. La respuesta 201 devuelve `imagePath`. `GET /api/events/images/{imageId}` permite leer la imagen públicamente y responde 404 si no existe. La creación y edición de eventos siguen recibiendo `imageUrl`, con la URL local devuelta o una URL externa indicada por el organizador.

## Compra y resultados

En `POST /api/orders`, el navegador genera un UUID para `Idempotency-Key` y conserva la clave y el cuerpo del intento hasta obtener un resultado definitivo. Una repetición idéntica puede reanudar trabajo en curso. Una clave reutilizada con otro cuerpo devuelve 409 `IDEMPOTENCY_CONFLICT`. Una compra pagada con entradas listas devuelve 200. Un intento en curso o con una dependencia temporalmente indeterminada devuelve 202 y la representación actual de la orden. El cliente puede consultar `GET /api/orders/{orderId}` y repetir el POST original para reanudarlo.

Los rechazos definitivos de compra devuelven el error con `orderId` y quedan en el historial. Los casos incluyen 409 `SOLD_OUT` o `EVENT_UNAVAILABLE`, 404 `NOT_FOUND` para referencias inexistentes o incompatibles, y 422 `PAYMENT_DECLINED` una vez liberado el cupo. En `GET`, el rechazo se representa con `status` y `failureCode`. `notificationStatus` informa el resultado del correo independientemente de `status` y `ticketStatus`.

Las operaciones de reserva, liberación, pago y emisión usan `orderId` y devuelven el resultado existente para una repetición equivalente. En la reserva, el pago y la emisión, un cuerpo distinto para la misma orden devuelve 409. El pago recibe los cuatro dígitos de prueba `paymentCode`. El código 0000 produce el resultado de negocio `declined`, que payments devuelve con HTTP 200. La interfaz solo solicita los cuatro dígitos ficticios.

Si una respuesta interna incumple OpenAPI o trae datos que no corresponden a la orden, `orders` conserva el último avance confirmado. La emisión se confirma cuando el lote contiene exactamente la cantidad de entradas compradas, con IDs distintos y referencias a la orden y al evento.

## Ingreso y errores HTTP

Checkin devuelve 200 tanto al aceptar como al rechazar por regla de negocio. Los rechazos llevan `INVALID_CODE`, `WRONG_EVENT` o `ALREADY_USED`. Checkin transforma el 404 `NOT_FOUND` de tickets en `INVALID_CODE`. Solo `ALREADY_USED` incluye `firstAdmittedAt`. Un fallo técnico o una respuesta que incumple el contrato de tickets devuelve 503 `DEPENDENCY_UNAVAILABLE`.

Para el resto de las operaciones, 400 indica entrada inválida, 401 credenciales ausentes o inválidas, 403 rol o credencial interna insuficiente, 404 recurso inexistente o privado, 409 conflicto de estado y 503 indisponibilidad temporal. Una comprobación de salud fallida devuelve 503 con `status: unavailable`.
