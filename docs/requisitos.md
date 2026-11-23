# Requisitos de EntradasYa v1

## Fuente y alcance

El documento base es *EntradasYa v1 – Documento de requerimientos*, versión 1.0. Los apartados 1–8 y 11 describen las funciones, la operación y las pruebas de referencia. Las indicaciones del proyecto fijan React con TypeScript para `web`, TypeScript con Node.js y Express para los servicios, autenticación local con MD5 y ejecución en una sola máquina local. El criterio 11.4 del PDF se sustituye por un arranque local reproducible. Los acuerdos de API que siguen son decisiones de diseño de esta documentación.

Se aplican las exclusiones del apartado 9. Quedan fuera Docker, RabbitMQ, Redis, MinIO, S3, Kubernetes, Azure, AWS, el despliegue en la nube, los pagos reales y el envío real de correos. PostgreSQL, Nginx y Mailpit cumplen las funciones de apoyo descritas en el PDF y se ejecutan en local.

## Actores

| Actor | Acceso |
| --- | --- |
| Visitante | Consulta cartelera y detalle público. Puede registrarse como cliente. |
| Cliente | Hace compras y consulta sus propias órdenes y entradas. |
| Organizador | Administra sus eventos y sectores y consulta sus ventas e ingresos por evento. |
| Portero | Selecciona el evento de trabajo, valida entradas y consulta el total de ingresos del evento. |

## Requisitos funcionales

| ID | Responsable | Requisito verificable | Referencia |
| --- | --- | --- | --- |
| RF-01 | web | Interfaz común con vistas para registro, sesión, cartelera, compra, historial, entradas, administración de eventos, ventas e ingreso según el rol. | §2, §4.1 |
| RF-02 | auth | Registrar cliente con nombre, correo único y contraseña. Permitir inicio de sesión con correo y contraseña y emitir un token con identidad y rol. Crear cuentas de organizador y portero mediante datos iniciales locales. | §4.2 |
| RF-03 | events | Permitir al organizador crear y editar sus eventos con nombre, fecha, lugar, imagen y descripción. Permitir definir sectores con precio y cupo y gestionar estados borrador, publicado y cancelado. | §4.3 |
| RF-04 | events | Mostrar únicamente eventos publicados en la cartelera y el detalle público. Reservar y liberar cupos por orden sin sobreventa ni doble restitución. | §4.3, §5 |
| RF-05 | orders | Recibir evento, sector y de 1 a 6 entradas. Crear una orden pendiente y coordinar reserva, pago simulado, emisión de entradas y correo, en ese orden. Mostrar «Agotado» cuando falte cupo. | §4.4, §5 |
| RF-06 | payments, orders | Aprobar el pago simulado salvo para el código de prueba 0000. Registrar monto, fecha y resultado una sola vez por orden. Si se rechaza, liberar el cupo y marcar la orden rechazada. | §4.4–4.5 |
| RF-07 | tickets | Emitir una entrada por unidad comprada con código único y PDF con datos del evento y QR. Guardar los PDF en disco y permitir al titular listarlos y descargarlos. Validar códigos para checkin. | §4.6 |
| RF-08 | notifications | Enviar a Mailpit un correo con enlace a las entradas de la orden. Ante un fallo de correo, conservar la compra pagada y las entradas descargables. | §4.4, §4.7 |
| RF-09 | orders | Mostrar al cliente el historial y el detalle de sus órdenes. Permitir al organizador consultar entradas vendidas e ingresos de sus eventos. | §2, §4.1, §4.4 |
| RF-10 | checkin, web | Permitir al portero escanear el QR o escribir el código y validar el ingreso para el evento seleccionado. Registrar fecha, hora y portero si se acepta. Mostrar rechazo por código inválido, otro evento o uso previo, incluyendo la hora del primer ingreso en el último caso. | §4.8, §6 |
| RF-11 | checkin | Mostrar cuántas personas ingresaron al evento. Dos peticiones simultáneas para la misma entrada producen un solo ingreso. | §4.8, §6 |

El correo de bienvenida es opcional en el PDF y se omite en el arranque de la v1. El estado `cancelled` de una orden se usa para el rechazo por falta de cupo. La v1 carece de un flujo de cancelación de compra por el cliente o de reembolso.

## Requisitos no funcionales

| ID | Requisito | Comprobación |
| --- | --- | --- |
| RNF-01 | Cada componente arranca localmente. Nginx sirve la web y publica solo las rutas API públicas. | La UI y la API responden mediante Nginx. Payments, notifications y todas las rutas internas quedan fuera del proxy público. |
| RNF-02 | Cada servicio persistente usa su propia base PostgreSQL y su propio usuario. Web y notifications son servicios sin base de datos. | Cada usuario de base puede conectarse a su base y carece de acceso a las otras bases de la aplicación. |
| RNF-03 | Los servicios intercambian HTTP/JSON con un tiempo máximo por llamada. El navegador recibe los PDF como `application/pdf` y notifications se comunica con Mailpit por SMTP. | Las llamadas a dependencias caídas concluyen dentro del timeout configurado. Las respuestas distinguen fallos técnicos de rechazos de negocio. |
| RNF-04 | Puertos, conexiones, URLs, directorio de tickets y secretos se parametrizan con variables de entorno. | Se puede cambiar la configuración local sin editar el código. |
| RNF-05 | Cada backend ofrece `GET /health` y comprueba los recursos locales imprescindibles. La web tiene un chequeo equivalente en Nginx. | Se obtiene 200 en condiciones operativas y 503 con una dependencia obligatoria caída. |
| RNF-06 | Los servicios registran fecha, nivel y mensaje en consola. Las operaciones de compra e ingreso registran identificadores opacos para diagnóstico. | Los logs evitan contraseñas, tokens, códigos QR y credenciales de prueba. |
| RNF-07 | Auth almacena el digest MD5 de la contraseña y usa cuentas ficticias del entorno local. Los servicios validan el token y aplican rol y propiedad del recurso. | Una contraseña en texto plano no está en la base. Una cuenta carece de acceso a órdenes, entradas o eventos privados de otra cuenta. |
| RNF-08 | Cupos, pago, emisión e ingreso conservan consistencia ante concurrencia y reintentos. | Las comprobaciones de aceptación cubren compra repetida, pago rechazado y doble escaneo. |
| RNF-09 | Cada componente documenta requisitos, entorno y arranque. El desarrollo registra incidencias de instalación y ejecución. | Un integrante puede repetir el arranque siguiendo los README de implementación y la guía local. |
