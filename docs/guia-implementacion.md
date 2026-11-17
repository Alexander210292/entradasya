# Guía de implementación de EntradasYa v1

Esta lista registra el avance real de la implementación. Los siete backends usan TypeScript con Node.js y Express y la aplicación web usa React con TypeScript. El sistema se ejecuta en una máquina local con PostgreSQL, Nginx y Mailpit. Mantén [el alcance de la v1](requisitos.md#fuente-y-alcance) en todas las etapas.

## Cómo trabajar con esta lista

1. Identifica los ítems del componente que vas a implementar. Lee sus reglas en [arquitectura](arquitectura.md), sus operaciones en [OpenAPI](openapi.yaml) y [convenciones de la API](api.md), y sus variables, puertos y recursos en [desarrollo local](desarrollo-local.md). Usa los identificadores `operationId` de esta guía para localizar cada operación exacta.
2. Implementa y ejecuta las comprobaciones del ítem por la ruta real del servicio. Consulta [aceptación](aceptacion.md) para los pasos y resultados esperados. Para un ítem que cubra varias operaciones, comprueba todas antes de cerrarlo.
3. Cambia `[ ]` a `[x]` en el mismo cambio que entrega el ítem verificado. Añade debajo una línea de **Evidencia** con el comando, caso de aceptación o pasos ejecutados y su resultado. Si algo queda pendiente o no pudo comprobarse, conserva la casilla vacía y anota el bloqueo.
4. Sigue este orden para integrar los componentes: base local → auth y events → payments, tickets y notifications → orders y checkin → web y Nginx → aceptación integral.

## Base local y convenciones transversales

Aplica la configuración y las comprobaciones de esta sección a cada componente según corresponda. Cierra cada ítem global al haberlo verificado en todos sus componentes aplicables.

- [x] **BASE-00 · Recursos locales.** Preparar los entornos por servicio, el directorio de PDF, el clúster PostgreSQL y el buzón SMTP de prueba.
  - **Evidencia** · `node scripts/local.ts db:init` arrancó PostgreSQL 18.3 y se repitió sobre el mismo clúster. Mailpit 1.33.1 recibió un correo ficticio por SMTP y la bandeja HTTP lo devolvió. (2026-11-16)
- [x] **BASE-01 · Arranque reproducible.** Documentar en cada README la versión de Node.js, instalación, variables, migraciones y carga inicial cuando apliquen, arranque o compilación y una forma de comprobar el resultado. Proveer ejemplos de configuración sin secretos. Registrar incidencias en la [bitácora](desarrollo-local.md#bitácora). (RNF-04, RNF-09, CA-01, CA-12)
  - **Evidencia** · Instalación con `npm ci`, chequeo estricto con `npm run typecheck`, salida estática con `npm run build:web` y arranque de siete backends con `npm run verify:base`. (2026-11-16)
- [x] **BASE-02 · Aislamiento de datos.** Preparar las seis bases y usuarios de la guía local. Ejecutar las migraciones con contexto de su propio servicio. Verificar que cada cuenta de aplicación puede acceder a su base y que una conexión a otra base de aplicación se rechaza. Web y notifications carecen de base propia. (RNF-02, CA-12)
  - **Evidencia** · `npm run verify:base` comprobó el rol efectivo de las seis migraciones, 6 escrituras en bases propias y 30 accesos cruzados denegados. Las seis migraciones se aplicaron también en el clúster del proyecto. (2026-11-16)
- [x] **BASE-03 · Procesos y salud.** Configurar backends en loopback mediante las variables de entorno acordadas. Implementar `getHealth` (`GET /health`) en los siete backends. Verificar 200 operativo y 503 con `status: unavailable` ante caída del recurso obligatorio: base propia en servicios persistentes, también directorio de PDF en tickets, y SMTP en notifications. Comprobar la recuperación. La salud de la compilación web se verifica en WEB-08. (RNF-01, RNF-04, RNF-05, CA-01)
  - **Evidencia** · `npm run verify:base` observó 200 en los siete procesos, 503 durante la indisponibilidad de PostgreSQL, el directorio de PDF y SMTP, y 200 tras recuperarlos. (2026-11-16)
- [x] **BASE-04 · Validación y errores.** Ajustar parámetros, cuerpos, códigos y esquemas al contrato OpenAPI. Usar UUID, fechas ISO 8601 con zona, enteros en centavos de BOB y `items` en listados. Devolver `code` y `message` para errores JSON y distinguir fallos de negocio de indisponibilidad. (RNF-03, CA-05, CA-11)
  - **Evidencia** · `npm run verify:base` ejercitó las 25 operaciones de OpenAPI. Comprobó formato de respuestas, rechazo de JSON, UUID y cantidades inválidas, y códigos distintos para agotado, pago rechazado e indisponibilidad. (2026-11-16)
- [x] **BASE-05 · Control de acceso.** Validar firma y expiración del JWT en las rutas protegidas y comprobar rol y propiedad en cada backend público aplicable. Exigir `X-Internal-Token` con el secreto del consumidor autorizado en cada operación interna. Comprobar credenciales ausentes o inválidas, rol incorrecto, acceso a recursos ajenos y una credencial interna empleada en una ruta de otro consumidor. (RNF-07, CA-02)
  - **Evidencia** · `npm run verify:base` verificó JWT expirado o ausente, rol incorrecto, acceso a un evento, una orden y un PDF ajenos, y rechazo de tokens internos fuera de su destino. (2026-11-16)
- [x] **BASE-06 · Llamadas y logs.** Parametrizar URLs y timeouts HTTP y SMTP. Usar HTTP/JSON entre backends y comprobar que las llamadas a dependencias caídas terminan dentro del tiempo configurado. Escribir logs de consola con fecha, nivel y mensaje, identificando compras e ingresos con identificadores opacos. Verificar que los logs excluyen contraseñas, tokens, códigos QR y credenciales de prueba. (RNF-03, RNF-04, RNF-06, CA-07, CA-11, CA-12)
  - **Evidencia** · `npm run verify:base` simuló endpoints HTTP y SMTP sin respuesta, verificó timeouts, reanudó la compra tras perder la respuesta de pago y comprobó los campos de logs y la exclusión de datos sensibles de prueba. (2026-11-16)

## auth

- [x] **AUTH-01 · Usuarios.** Crear la migración de usuarios con ID, nombre, correo normalizado único, digest hexadecimal MD5 y rol. Preparar una carga inicial idempotente con cuentas ficticias de organizador y portero. (RF-02, RNF-07, CA-02)
  - **Evidencia** · `npm run verify:base` leyó el digest MD5 de la cuenta de prueba en `auth_db` y confirmó que la carga inicial repetida conserva los IDs y roles de ambas cuentas. `npm run migrate -- auth` actualizó la base local y una segunda ejecución quedó al día.
- [x] **AUTH-02 · Registro.** Implementar `register` con validación de nombre, correo y contraseña. Asignar siempre rol cliente. Verificar registro, correo duplicado tras normalizar y rechazo de un rol enviado en el cuerpo. (RF-02, CA-02)
  - **Evidencia** · `npm run verify:base` verificó registro como cliente, normalización de mayúsculas, 409 por duplicado y 400 por campos inválidos o rol enviado en el cuerpo.
- [x] **AUTH-03 · Sesión.** Implementar `login` comparando el digest MD5 y emitir JWT HS256 de una hora con `sub`, `role`, `iat` y `exp`. Verificar sesión válida, credenciales incorrectas, token expirado y respuestas sin contraseña ni digest. (RF-02, RNF-07, CA-02)
  - **Evidencia** · `npm run verify:base` verificó firma, identidad, rol y duración de 3600 segundos, validó la respuesta pública contra OpenAPI y comprobó 401 con contraseña incorrecta, JWT expirado o firma inválida.

## events

- [x] **EVT-01 · Datos.** Migrar eventos con propietario, campos descriptivos y estado, sectores con precio y capacidad, y reservas con `orderId` único, cantidad, estado e instantánea. Mantener la pertenencia del sector al evento y calcular el cupo disponible a partir de reservas activas. (RF-03, RF-04, CA-03, CA-05)
  - **Evidencia** · `npm run verify:base` confirmó que PostgreSQL rechaza una reserva cuyo sector pertenece a otro evento y verificó el cupo antes y después de liberar. `npm run migrate -- events` actualizó la base local y una segunda ejecución quedó al día.
- [x] **EVT-02 · Consultas.** Implementar `listPublishedEvents`, `getPublishedEvent` y `listOwnEvents`. Verificar que la API pública muestra únicamente publicados y que el organizador ve sus eventos en cualquier estado. (RF-03, RF-04, CA-02, CA-03)
  - **Evidencia** · `npm run verify:base` verificó cartelera y detalle público, exclusión de borradores y cancelados y consulta del propietario en los tres estados.
- [x] **EVT-03 · Edición y ciclo de vida.** Implementar `createEvent`, `updateEvent`, `createSector`, `updateSector` y `updateEventStatus`. Aplicar propiedad, precio y cupo positivos, publicación con al menos un sector, transiciones acordadas y cancelación terminal. Impedir reducir el cupo por debajo de las reservas activas. (RF-03, RF-04, CA-02, CA-03)
  - **Evidencia** · `npm run verify:base` comprobó edición del propietario, rechazo a otro organizador, precios y cupos inválidos, publicación con sector, cancelación terminal y rechazo de una reducción por debajo de lo reservado.
- [x] **EVT-04 · Reserva y liberación.** Implementar `reserveCapacity` y `releaseCapacity` para orders. Aplicar las comprobaciones de estado, sector y cupo en transacción con los cambios de capacidad y cancelación. Conservar precio, datos del evento y propietario en la primera reserva. Devolver la misma instantánea a un reintento equivalente, rechazar cambios de solicitud y reservas ya liberadas, y liberar una sola vez aunque se repita la petición. Verificar último cupo concurrente y que cancelar bloquea reservas nuevas mientras se pueden completar las existentes. (RF-04, RNF-08, CA-03, CA-05, CA-06, CA-08)
  - **Evidencia** · `npm run verify:base` confirmó un solo éxito en la carrera por el último cupo, reintentos concurrentes del mismo UUID con distinta capitalización, conservación de la instantánea tras cambios y cancelación, rechazo de reservas nuevas en cancelados y liberación única.

## payments

- [x] **PAY-01 · Simulador interno.** Migrar transacciones con `orderId` único, monto, moneda, fecha y resultado. Implementar `processPayment` solo para orders. Validar cuatro dígitos, devolver HTTP 200 con `declined` para `0000` y `approved` para los demás códigos válidos. (RF-06, CA-04, CA-06)
  - **Evidencia** · `npm run verify:base` comprobó pago aprobado y rechazado, 400 para datos inválidos, 401 y 403 para credenciales internas y los campos persistidos en `payments_db`. La migración local está al día.
- [x] **PAY-02 · Reintento.** Persistir y devolver el resultado original ante repetición equivalente, incluso con solicitudes concurrentes o si se perdió la primera respuesta. Devolver 409 si el cuerpo cambia para la misma orden. Comprobar que queda una sola transacción. (RF-06, RNF-08, CA-08)
  - **Evidencia** · `npm run verify:base` comprobó solicitudes concurrentes, una sola fila con fecha y resultado originales, 409 al cambiar el monto o código y recuperación tras perder la respuesta de un pago cursado.

## tickets

- [x] **TKT-01 · Identidad y emisión.** Migrar lotes y entradas de modo que cada par `(orderId, ordinal)` y cada código opaco sean únicos. Implementar `issueTickets` para orders con una entrada por unidad comprada y un PDF por entrada con datos del evento y QR. Persistir las identidades y el estado de emisión. (RF-07, CA-04)
  - **Evidencia** · `npm run verify:base` comprobó dos entradas y códigos distintos para una compra de dos unidades. Se renderizó un PDF descargado, se verificó el texto del evento y se decodificó el QR para compararlo con el código de `tickets_db`. La migración local está al día.
- [x] **TKT-02 · Publicación del lote.** Escribir cada PDF en un archivo temporal y renombrarlo dentro de `TICKETS_PDF_DIR`. Reanudar con los mismos códigos después de un fallo parcial. Publicar el lote cuando todos los PDF estén disponibles. Verificar emisión repetida sin duplicados y 409 si el cuerpo cambia para la misma orden. (RF-07, RNF-08, CA-08, CA-09)
  - **Evidencia** · `npm run verify:base` bloqueó la escritura del segundo PDF, comprobó la limpieza de temporales y reintentó en paralelo. El lote conservó IDs y códigos, y una solicitud con otra cantidad devolvió 409.
- [x] **TKT-03 · Descarga del titular.** Implementar `listOwnTickets` con filtro opcional por orden y `downloadOwnTicket` con respuesta `application/pdf`. Verificar que solo el titular puede listar y descargar sus entradas y que las entradas del lote incompleto quedan fuera. (RF-07, RNF-07, CA-02, CA-04, CA-09)
  - **Evidencia** · `npm run verify:base` comprobó listado con y sin filtro, PDF del titular, rechazo de acceso sin sesión o con otra cuenta y ocultación de entradas durante un fallo parcial.
- [x] **TKT-04 · Validación.** Implementar `lookupTicket` para checkin. Devolver el ID de entrada y su evento únicamente para códigos de entradas emitidas. Devolver 404 para códigos inexistentes o todavía sin emitir. Verificar que la credencial de emisión no habilita esta operación. (RF-07, RF-10, CA-10)
  - **Evidencia** · `npm run verify:base` verificó ID y evento después de publicar el lote, rechazo del código antes de publicar, rechazo de códigos desconocidos a través de checkin y 403 con la credencial de emisión.

## notifications

- [x] **NTF-01 · Correo local.** Implementar `sendConfirmation` para orders. Enviar por SMTP a Mailpit usando remitente y timeout del entorno. Incluir enlace a la vista `/mis-entradas?orderId=<id>` de `WEB_BASE_URL`. Devolver 204 tras la confirmación de Mailpit y comprobar que el correo es visible y el enlace exige la sesión del titular. (RF-08, CA-04)
  - **Evidencia** · `npm run verify:web` abrió el correo en Mailpit, comprobó que su enlace exige sesión y descargó las entradas al identificarse el titular. Una segunda cuenta obtuvo una lista vacía y 404 al pedir el PDF ajeno.
- [x] **NTF-02 · Fallos de entrega.** Registrar el resultado operativo en consola y devolver indisponibilidad cuando corresponda. Verificar el timeout con SMTP inaccesible y el comportamiento de orders cuando falla el correo. (RF-08, RNF-03, RNF-06, CA-07)
  - **Evidencia** · `npm run verify:base` comprobó 503 con códigos distintos para timeout y conexión rechazada, logs de éxito y fallo, y una compra que siguió pagada con el PDF descargable durante la caída de SMTP.

## orders

- [x] **ORD-01 · Datos e idempotencia.** Migrar órdenes, avance y unicidad de `(customerId, Idempotency-Key)`. Vincular la clave al cuerpo y guardar la instantánea devuelta por events. Implementar `purchaseTickets` para clientes con evento, sector, correo de destino, código de prueba y cantidad entera entre 1 y 6. Derivar el titular del token. Serializar el avance por orden y comprobar 409 `IDEMPOTENCY_CONFLICT` al reutilizar la clave con otro cuerpo. (RF-05, RNF-08, CA-05, CA-08)
  - **Evidencia** · `npm run verify:base` comprobó cantidades inválidas, una orden y una llamada de pago con solicitudes concurrentes, y 409 al cambiar el cuerpo. La migración de `orders_db` está al día.
- [x] **ORD-02 · Reserva.** Persistir `pending` antes de pedir cupos. Si el rechazo de events es definitivo, guardar `cancelled` y `failureCode` y devolver la respuesta contractual con `orderId`. Mostrar «Agotado» para `SOLD_OUT`. Calcular el monto a partir de la cantidad y el precio de la reserva. (RF-04, RF-05, CA-05)
  - **Evidencia** · `npm run verify:base` comprobó monto y precio persistidos, historial de rechazos por cupo agotado y referencias inválidas, y bloqueo de compras en un evento cancelado. El precio de la primera reserva se conservó tras editar el sector.
- [x] **ORD-03 · Pago y compensación.** Cobrar por `orderId` tras confirmar la reserva. Guardar la aprobación y pasar a `paid` con emisión pendiente. Si el pago se rechaza, guardar el resultado, liberar los cupos y marcar `rejected` y devolver 422 solo después de confirmar esa liberación. Si la respuesta del pago se pierde, conservar orden pendiente y reserva hasta recuperar el resultado. (RF-05, RF-06, CA-06, CA-08)
  - **Evidencia** · `npm run verify:base` perdió la respuesta de un pago aprobado y reanudó la misma orden. También simuló una liberación indisponible. La orden quedó pendiente y el cupo reservado hasta confirmar la liberación, tras lo cual devolvió 422 y el cupo permitió otra compra.
- [x] **ORD-04 · Emisión.** Solicitar el lote a tickets después de confirmar el pago. Conservar `paid` durante fallos de emisión y marcar `ticketStatus: ready` al confirmar el lote. Verificar recuperación con la misma referencia. (RF-05, RF-07, CA-08, CA-09)
  - **Evidencia** · `npm run verify:base` simuló una respuesta 200 con lote vacío. La orden conservó `paid` y emisión pendiente. Al volver a tickets, la misma orden pasó a emisión lista.
- [x] **ORD-05 · Correo.** Guardar `notificationStatus: unknown` antes del intento de correo. Guardar `sent` o `failed` con un resultado confirmado y conservar `unknown` si es indeterminado. Comprobar que un reintento de compra evita duplicar el correo y que las descargas están disponibles aunque falle. (RF-08, CA-04, CA-07)
  - **Evidencia** · `npm run verify:base` confirmó los estados `sent`, `failed` y `unknown`. Simuló que Mailpit recibiera el mensaje sin que orders recibiera respuesta. Los reintentos dejaron un solo correo y el PDF descargable.
- [x] **ORD-06 · Reanudación y consultas.** Reanudar el POST original desde el último paso confirmado y devolver 202 en progreso y 200 para compra pagada con lote listo. Comprobar que `listOwnOrders` y `getOwnOrder` devuelven solo órdenes del titular con su último avance persistido, sin desencadenar pasos. (RF-05, RF-09, RNF-08, CA-04, CA-08, CA-09)
  - **Evidencia** · `npm run verify:base` comprobó 202 y 200 para la misma orden en distintos pasos, acceso exclusivo del titular y consultas de avance e historial sin nuevas llamadas de pago o liberación.
- [x] **ORD-07 · Ventas.** Implementar `getSales` para organizadores filtrando por evento y propietario de la instantánea. Sumar cantidades y montos de las órdenes pagadas aunque la emisión siga pendiente. Verificar totales cero cuando no hay ventas para esa pareja de organizador y evento. (RF-09, CA-04)
  - **Evidencia** · `npm run verify:base` comprobó cantidades e ingresos del propietario, cero para otro organizador y contabilización de una orden pagada con emisión pendiente.

## checkin

- [x] **CHK-01 · Validación.** Implementar `registerCheckin` para porteros. Consultar `lookupTicket` con la credencial de checkin. Devolver 200 con `INVALID_CODE` si tickets responde 404 y `WRONG_EVENT` si pertenece a otro evento. Ante fallo técnico devolver 503 `DEPENDENCY_UNAVAILABLE` y verificar que no se registró ingreso. (RF-10, CA-10, CA-11)
  - **Evidencia** · `npm run verify:base` comprobó credenciales, código inexistente, entrada de otro evento y 503 sin incrementar el conteo ante un timeout o una respuesta interna inválida.
- [x] **CHK-02 · Primer ingreso y conteo.** Migrar ingresos con `ticketId` único, evento, portero obtenido del JWT y hora de ingreso. Implementar el registro atómico y `getAttendance` para porteros. Verificar que dos escaneos simultáneos producen un solo registro y que el segundo devuelve `ALREADY_USED` con `firstAdmittedAt`. Comprobar el total por evento y la validación de entradas emitidas antes de la cancelación si se indica el ID del evento. (RF-10, RF-11, RNF-08, CA-04, CA-10)
  - **Evidencia** · `npm run verify:base` comprobó un solo ingreso ante dos escaneos, hora original en el rechazo, portero persistido a partir del JWT, conteo por evento y aceptación de una entrada emitida antes de cancelar el evento. La migración de `checkin_db` está al día.

## web y Nginx

- [x] **WEB-01 · Sesión y navegación.** Implementar registro, inicio de sesión y vistas según rol. Enviar el Bearer token al consultar la API y manejar expiración y acceso denegado. (RF-01, RF-02, CA-02)
  - **Evidencia** · `npm run verify:web` comprobó registro, correo duplicado, ingreso por rol, pantalla restringida y regreso a inicio de sesión tras un 401.
- [x] **WEB-02 · Cartelera.** Mostrar catálogo publicado, detalle, sectores, precios y cupos. Dejar la consulta pública y exigir sesión de cliente para comprar. (RF-01, RF-04, CA-03, CA-04)
  - **Evidencia** · `npm run verify:web` comprobó cartelera pública, búsqueda por evento, detalle y visibilidad de eventos según su estado.
- [x] **WEB-03 · Compra.** Solicitar evento, sector, cantidad, correo de destino y cuatro dígitos ficticios. Generar y reutilizar `Idempotency-Key` con el mismo cuerpo, permitir reanudar desde 202, mostrar estados persistidos y presentar «Agotado» o pago rechazado cuando corresponda. (RF-01, RF-05, CA-04–CA-09)
  - **Evidencia** · `npm run verify:web` comprobó compra, «Agotado», pago rechazado y reanudación con el mismo cuerpo y clave tras recargar o perder la respuesta de pago.
- [x] **WEB-04 · Historial y entradas.** Mostrar órdenes propias y su detalle, estado de emisión y correo. Implementar `/mis-entradas?orderId=<id>` con filtro y descarga PDF autenticada, incluso si el correo falla. (RF-01, RF-07–RF-09, CA-02, CA-04, CA-07)
  - **Evidencia** · `npm run verify:web` recorrió historial, detalles, filtro por orden desde Mailpit, autorización del titular y descarga de PDF con o sin correo. Reanudó una emisión desde el detalle.
- [x] **WEB-05 · Organizador.** Implementar listado de eventos propios, creación, edición, gestión de sectores, publicación, cancelación y reporte por evento. (RF-01, RF-03, RF-09, CA-03, CA-04)
  - **Evidencia** · `npm run verify:web` creó y editó un evento y un sector, publicó y canceló eventos, verificó propiedad y comprobó cantidades e ingresos.
- [x] **WEB-06 · Portero.** Permitir seleccionar el evento publicado, escanear por cámara o ingresar el código manualmente. Mostrar permiso, motivo de rechazo, hora del primer ingreso cuando aplique y conteo. Verificar el modo manual con cámara denegada y mostrar un fallo técnico como tal. (RF-01, RF-10, RF-11, CA-04, CA-10, CA-11)
  - **Evidencia** · `npm run verify:web` escaneó un código con cámara virtual, simuló permiso denegado y validó el modo manual, motivos, hora del primer ingreso y conteo.
- [x] **WEB-07 · Proxy.** Servir la compilación de React mediante Nginx con fallback para rutas de interfaz. Enrutar solo la API pública manteniendo rutas completas y cabeceras de JWT e idempotencia. Verificar que payments, notifications y las rutas `/internal/` quedan fuera del proxy público. (RNF-01, CA-01, CA-02)
  - **Evidencia** · `npm run verify:web` sirvió React y rutas profundas desde Nginx, conservó JWT y clave de idempotencia, y obtuvo 404 para rutas internas y servicios privados.
- [x] **WEB-08 · Salud web.** Configurar `GET /health` en Nginx para comprobar que la compilación puede servirse. Verificar 200 con compilación disponible y 503 si falta. (RNF-05, CA-01)
  - **Evidencia** · `npm run verify:web` comprobó 200 con la compilación, 503 al retirar el bundle y 200 al restaurarlo.

## Aceptación integral

Marca cada caso tras ejecutarlo con los componentes reales en local y registra su evidencia. Restaura las dependencias que detengas para probar fallos.

- [x] **CA-01** · Arranque reproducible y salud.
  - **Evidencia** · `verify:web` verificó Nginx, dependencias y recuperación. `verify:base` comprobó los siete backends y sus dependencias.
- [x] **CA-02** · Registro, sesión, roles, propiedad y rutas internas.
  - **Evidencia** · `verify:web` verificó registro, roles, evento y PDF ajenos, expiración de sesión y rutas internas inaccesibles.
- [x] **CA-03** · Borrador, publicación y cancelación.
  - **Evidencia** · `verify:web` comprobó cambios de visibilidad y edición. `verify:base` comprobó que cancelar bloquea nuevas reservas.
- [x] **CA-04** · Compra, PDF, correo, ventas y checkin de extremo a extremo.
  - **Evidencia** · `verify:web` compró dos entradas, abrió el correo de Mailpit, se autenticó desde el enlace, descargó dos PDF distintos, consultó ventas y registró dos ingresos.
- [x] **CA-05** · Último cupo concurrente y cantidades inválidas.
  - **Evidencia** · `verify:web` envió compras simultáneas desde dos perfiles. Una obtuvo el último cupo y la otra mostró «Agotado». Nginx retransmitió el rechazo de cantidades 0, 7 y 1.5.
- [x] **CA-06** · Pago rechazado y liberación única.
  - **Evidencia** · `verify:web` repitió el pago rechazado con la misma clave y compró después el único cupo del mismo sector.
- [x] **CA-07** · Compra con notifications caído y PDF descargable.
  - **Evidencia** · `verify:web` mantuvo la orden pagada con notifications detenido, mostró el fallo en el historial y descargó el PDF.
- [x] **CA-08** · Respuesta de pago perdida, reintento y conflicto de idempotencia.
  - **Evidencia** · `verify:web` perdió la respuesta de payments, reanudó con la misma clave y cuerpo, y recibió 409 al alterarlo. `verify:base` comprobó la persistencia y la idempotencia de las dependencias.
- [x] **CA-09** · Interrupción y reanudación de emisión.
  - **Evidencia** · `verify:web` detuvo tickets, observó orden pagada con emisión pendiente y descargó la entrada tras reanudar desde el detalle.
- [x] **CA-10** · Código inválido, evento distinto y doble escaneo concurrente.
  - **Evidencia** · `verify:web` mostró los tres rechazos y comprobó un solo ingreso ante dos peticiones simultáneas.
- [x] **CA-11** · Indisponibilidad de tickets y recuperación de checkin.
  - **Evidencia** · `verify:web` envió un código válido con tickets detenido, comprobó el mensaje técnico y el conteo, y admitió la entrada al restaurar el servicio.
- [x] **CA-12** · Aislamiento de bases, configuración y logs.
  - **Evidencia** · `verify:base` y `verify:web` verificaron 30 accesos cruzados denegados, roles de migración y configuración por entorno. `verify:base` verificó el contenido y privacidad de los logs.
