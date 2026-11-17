# EntradasYa web

La interfaz React con TypeScript usa la misma URL para la cartelera, los tres perfiles y la API. Nginx sirve la compilación estática y reenvía las rutas públicas.

Instala las dependencias con `npm ci` la primera vez. Desde la raíz, arranca y detén el entorno con estos comandos.

```sh
npm run start:local
npm run stop:local
```

El arranque queda en segundo plano e imprime la URL de EntradasYa. Usa 8080 si está libre y 8088 como alternativa. Abre también [Mailpit](http://localhost:8025/) para ver las confirmaciones. El enlace de cada correo usa el puerto elegido.

- Registra una cuenta desde la pantalla de ingreso para comprar y descargar entradas.
- Usa `organizador@example.test` para crear un evento, agregar sectores, publicarlo y consultar ventas.
- Usa `portero@example.test` para validar entradas por QR o código manual y consultar asistencia. Ambas cuentas de prueba usan la contraseña `demo-entradasya`.

La cámara requiere permiso del navegador. Desde localhost puede escanearse el QR de una entrada. Si no hay cámara disponible, el código al pie del PDF permite hacer el ingreso manual.

El cliente conserva la clave y el cuerpo de una compra pendiente en la pestaña donde la inició. Puede reanudar desde el evento o, cuando ya conoce la referencia de la orden, desde su detalle en **Mis compras**. El enlace de Mailpit abre **Mis entradas** y pide la sesión del cliente cuando hace falta.

La compilación queda en `web/dist/`. Consulta la [guía local](../docs/desarrollo-local.md#arranque-de-los-componentes) para ejecutar los componentes por separado y la [matriz de aceptación](../docs/aceptacion.md) para repetir las pruebas en el navegador.

## Eventos de demostración

Con EntradasYa en ejecución, compila la web y publica los nueve eventos ficticios en la cartelera. El seed asigna los eventos al organizador de prueba y usa fotografías de Wikimedia Commons guardadas como WebP. La ficha de cada evento enlaza la foto y su licencia. Cada evento incluye dos sectores con precios y cupos. Ejecutarlo de nuevo en la misma instancia conserva los eventos existentes sin duplicarlos.

```sh
npm run build:web
npm run seed:events
```

Si EntradasYa corre en el puerto 8088, usa `WEB_PORT=8088 npm run seed:events` después de compilar.

## Portadas y carrusel

El formulario de creación y edición permite seleccionar una imagen JPEG, PNG o WebP de hasta 5 MB y muestra una vista previa antes de guardar. Las portadas subidas se conservan en el directorio local de events.

El carrusel de destacados avanza cada cinco segundos. Puedes pausarlo o usar las flechas y los indicadores para seleccionar un evento. El avance automático se pausa mientras el cursor o el foco están dentro del carrusel.
