# Criterios de aceptación

Preparar un cliente, un segundo cliente para comprobar propiedad, un organizador, otro organizador y un portero. Crear dos eventos publicados y un borrador. Usar sectores independientes para los escenarios que alteran cupos. Revisar cada resultado por la interfaz o por la API del componente.

| Caso | Ejecución | Resultado esperado | Trazabilidad |
| --- | --- | --- | --- |
| CA-01 | Arrancar los componentes siguiendo la guía y los README de implementación. Consultar sus chequeos de salud. Detener temporalmente PostgreSQL. | La web carga por Nginx. Los chequeos de los componentes consultados devuelven 200. Los backends con base pasan a 503 y se recuperan al restaurarla. | RNF-01, RNF-02, RNF-04, RNF-05, RNF-09 |
| CA-02 | Registrar un cliente, iniciar sesión e intentar duplicar correo, modificar un evento ajeno, descargar una entrada ajena y usar las rutas internas por Nginx. | El registro crea un cliente. El acceso protege el rol y la propiedad. El proxy deja las rutas internas y servicios privados fuera de la API pública. | RF-01, RF-02, RF-07, RNF-01, RNF-07 |
| CA-03 | Crear un borrador con un sector, publicarlo y después cancelarlo. Consultar cartelera antes y después de cada cambio. | El evento aparece solo mientras está publicado. El precio y cupo corresponden al sector. El servicio rechaza nuevas reservas después de cancelar. | RF-03, RF-04 |
| CA-04 | Comprar dos entradas con un código de pago distinto de 0000. Abrir el correo en Mailpit y descargar ambos PDF. Consultar historial y ventas. Escanear un QR e ingresar manualmente el código de la segunda entrada. | Hay una orden pagada, una transacción, dos PDF con códigos diferentes y un correo con enlace autenticado. El reporte suma dos entradas y el monto de la reserva. El portero registra dos ingresos. | RF-01, RF-05–RF-11 |
| CA-05 | Enviar compras concurrentes para el último cupo y probar cantidades 0, 7 y 1.5. | Solo una compra obtiene el último cupo. La otra muestra «Agotado». Se rechazan cantidades fuera de los enteros entre 1 y 6. | RF-04, RF-05, RNF-08 |
| CA-06 | Comprar con 0000 y repetir la solicitud con la misma clave. Comprar después con otra clave válida. | La primera orden es rechazada y se libera el cupo exactamente una vez. La segunda compra puede usarlo. | RF-05, RF-06, RNF-08 |
| CA-07 | Detener notifications y completar una compra válida. | El timeout o error se registra. La orden queda pagada, las entradas se descargan y el historial muestra el fallo del correo. | RF-07–RF-09, RNF-03, RNF-06 |
| CA-08 | Simular pérdida de respuesta de payments tras registrar una aprobación. Reenviar la compra con la misma clave y el mismo cuerpo, y luego con el mismo encabezado y cuerpo modificado. | La compra reanuda con el pago original y emite un solo lote. La modificación recibe 409. Se conserva una orden, una transacción y una reserva. | RF-04–RF-07, RNF-03, RNF-08 |
| CA-09 | Detener tickets después del pago y antes de la emisión. Restaurarlo y repetir el POST. | La orden permanece pagada durante el fallo, informa emisión pendiente y completa la emisión al reanudar, con el número correcto de entradas. | RF-05, RF-07, RNF-08 |
| CA-10 | Probar código inválido, entrada de otro evento y dos escaneos simultáneos de una entrada nueva. | Se muestran los motivos correspondientes. Solo un escaneo concurrente cuenta como ingreso. El otro devuelve la hora del primero. | RF-10, RF-11, RNF-08 |
| CA-11 | Detener tickets e intentar registrar un código. Restaurarlo y repetir. | Checkin devuelve 503 y conserva el conteo durante la caída. El primer intento posterior válido permite el ingreso. | RF-10, RF-11, RNF-03 |
| CA-12 | Revisar permisos de PostgreSQL, configuración y logs durante los casos anteriores. | Cada usuario de servicio accede a su base. Los valores de configuración provienen del entorno y los logs incluyen fecha, nivel y mensaje sin credenciales. | RNF-02, RNF-04, RNF-06, RNF-07 |

## Repetir la aceptación automatizada

Ejecuta estas pruebas desde la raíz. Además de las dependencias de [desarrollo local](desarrollo-local.md#preparar-la-base-local), necesitas Chrome o Chromium y `pdftotext` de Poppler.

```sh
npm run typecheck
npm run verify:base
npm run verify:web
```

`verify:base` cubre API, migraciones, aislamiento y logs. `verify:web` compila React, arranca Nginx y usa Chromium con perfiles separados para visitante, clientes, organizadores y portero. Las compras, correos, descargas y fallos usan las instancias temporales reales. La prueba de cámara usa una cámara virtual con un QR generado a partir del código de un PDF descargado. La prueba de entrada manual también simula permiso de cámara denegado.

Usa `CHROME_BIN` si Chrome o Chromium está fuera de la ruta predeterminada del script. `WEB_SCREENSHOT_DIR` guarda capturas de cartelera y organización solo cuando se define.
