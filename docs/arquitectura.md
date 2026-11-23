# Arquitectura y servicios

Nginx sirve la compilación de React y reenvía la API pública a procesos Express independientes escritos en TypeScript, enlazados a loopback. `orders` coordina la compra por HTTP. `checkin` consulta a `tickets` antes de aceptar el ingreso. Las bases PostgreSQL pertenecen a un solo servicio cada una. Los procesos pueden compartir una instancia de PostgreSQL.

| Componente | Responsabilidad | Datos y restricciones | Llamadas salientes |
| --- | --- | --- | --- |
| web | Pantallas de los tres roles y cartelera. | Sin persistencia propia. | API pública por Nginx. |
| auth | Registro, inicio de sesión y roles. | `auth_db` guarda usuario, correo normalizado único, digest MD5 y rol. | Ninguna. |
| events | Catálogo, sectores, precios y cupos. | `events_db` guarda eventos, sectores y reservas únicas por orden. El evento guarda `organizerId` y cada sector pertenece a un evento. | Ninguna. |
| orders | Compra, historial y ventas. | `orders_db` guarda órdenes, avance y la clave de idempotencia única por cliente. Conserva el precio reservado, monto y propietario del evento como instantánea. | events, payments, tickets, notifications. |
| payments | Simulador determinista. | `payments_db` guarda una transacción por `orderId` con monto, moneda, fecha y resultado. | Ninguna. |
| tickets | Emisión, descarga y validación de códigos. | `tickets_db` guarda una entrada por par `(orderId, ordinal)`, un código único opaco por entrada y referencia al PDF local. | Ninguna. |
| notifications | Confirmación de compra. | Logs de entrega durante la ejecución. | Mailpit por SMTP. |
| checkin | Registro de ingresos y conteo por evento. | `checkin_db` guarda un ingreso único por `ticketId`, con evento, portero y hora. | tickets. |

## Eventos y cupos

- Estados de evento `draft`, `published` y `cancelled`. Transiciones `draft → published`, `draft → cancelled` y `published → cancelled`. La publicación requiere al menos un sector con precio y cupo positivos. El organizador propietario puede editar eventos y sectores mientras el evento siga activo.
- Cancelar retira el evento de la cartelera y bloquea nuevas reservas. Las reservas ya concedidas pueden completar su compra y las entradas emitidas siguen siendo válidas para checkin. La cancelación de un evento es terminal.
- El cupo disponible es el cupo del sector menos las cantidades de reservas activas, incluidas las compras pagadas. Bloquear y actualizar evento, sector y reserva de manera transaccional al comprobar publicación, reservar, liberar o editar el cupo. Prohibir editar el cupo por debajo de las reservas activas.
- La primera reserva exitosa guarda cantidad, precio unitario, datos descriptivos del evento y propietario. Una repetición con los mismos datos devuelve esa instantánea. La liberación revierte los cupos una sola vez y conserva el registro de la reserva. Una repetición posterior de la reserva liberada se rechaza. El monto se calcula con el precio de la reserva multiplicado por la cantidad.

## Orquestación de compra

1. Crear una orden `pending` vinculada a `(customerId, Idempotency-Key)`. Vincular la clave al contenido de la compra. Un intento concurrente con la misma clave puede observar el progreso, pero solo un ejecutor avanza la orden. Una implementación inicial puede usar un bloqueo por orden en una conexión dedicada de PostgreSQL y escrituras breves para guardar cada paso.
2. Reservar cupo en `events` con el identificador de la orden. Si falta cupo, el evento no admite compras o el evento y el sector no forman una pareja válida, guardar `cancelled` y un código de negocio. Presentar «Agotado» para `SOLD_OUT`.
3. Solicitar el pago simulado con la misma referencia. Ante rechazo definitivo, guardar el resultado, liberar la reserva y pasar a `rejected` cuando la liberación se confirme. Ante aprobación, marcar `paid` y guardar el paso de emisión pendiente. Los datos de prueba del cobro se usan en la petición y se vuelven a proporcionar si se reanuda. Payments devuelve el resultado original por orden.
4. Pedir a `tickets` que emita exactamente la cantidad comprada. Generar códigos opacos aleatorios y escribir cada PDF mediante archivo temporal y cambio de nombre en el mismo directorio. Conservar las identidades de las entradas al reintentar. Exponer el lote para listado, descarga y validación cuando todos sus PDF estén listos. Guardar en la orden que la emisión terminó.
5. Guardar `unknown` antes de llamar a `notifications`. Marcar `sent` tras la confirmación de Mailpit, o `failed` si se confirma un fallo de entrega o de conexión. Ante un timeout o una interrupción con resultado indeterminado, conservar `unknown` y evitar un segundo intento automático. El correo enlaza a la vista de entradas y las descargas funcionan a partir de la emisión, incluso si Mailpit falla.

Timeouts, conexión fallida y 5xx indican un resultado técnico indeterminado. Un fallo antes de conocer el resultado del pago conserva la reserva y la orden pendiente. Un fallo después de pagar conserva la orden pagada. El cliente puede repetir el POST con la misma clave y el mismo cuerpo para continuar desde el último paso confirmado. La consulta de una orden devuelve su último avance guardado sin ejecutar pasos. Una compra pendiente conserva el cupo hasta su resolución manual mediante el mismo intento, o su rechazo definitivo. El arranque v1 no incluye un proceso de expiración.

Los reportes de ventas suman cantidades y montos de órdenes pagadas, incluso si la emisión está en curso. `orders` filtra las órdenes del reporte por evento y por `organizerId` de la instantánea. Si aún no hay ventas para ese organizador y evento devuelve totales cero. Los montos se almacenan como enteros en centavos de BOB y se exponen en el mismo formato.

## Validación de ingreso

`checkin` valida el rol del token y pide a `tickets` identificar el código. Solo las entradas emitidas de una orden aprobada pueden validarse. `checkin` compara el evento devuelto con el evento seleccionado. La restricción única sobre `ticketId` decide el primer ingreso, incluso bajo concurrencia. Ante conflicto consulta ese ingreso y devuelve su hora. Una caída de `tickets` produce un error técnico y deja el ingreso sin registrar.

La selección de evento del portero se hace sobre la cartelera. La API también acepta un identificador conocido de un evento cuyas entradas se emitieron antes de su cancelación. La v1 permite a cualquier portero autenticado operar en el evento que indique. Los horarios de ingresos, pagos y eventos se intercambian en ISO 8601 con zona horaria.
