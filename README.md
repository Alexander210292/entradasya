# EntradasYa

Aplicación local de venta de entradas para eventos. Permite publicar eventos con sectores y cupos, comprar con un pago simulado, recibir la confirmación en Mailpit, descargar un PDF con QR y registrar un único ingreso por entrada.

La web usa React con TypeScript. Los siete servicios usan TypeScript, Node.js y Express. PostgreSQL guarda los datos en seis bases independientes. Las imágenes subidas y los PDF se guardan en el equipo.

## Arranque en Windows

El recorrido preparado para Windows usa **WSL2 con Ubuntu**. Ejecuta los comandos del proyecto dentro de la terminal Ubuntu y abre la aplicación en tu navegador de Windows.

### 1. Instalar Ubuntu una vez

En **PowerShell como administrador**, ejecuta:

```powershell
wsl --install -d Ubuntu
```

Reinicia Windows si lo solicita. Abre **Ubuntu** desde Inicio y crea el usuario y la contraseña que pide la primera vez. Si ya tienes Ubuntu en WSL2 puedes continuar con el siguiente paso. [Guía oficial de WSL](https://learn.microsoft.com/windows/wsl/install/).

### 2. Clonar el repositorio y preparar todo

En la **terminal Ubuntu**, instala Git, entra en tu carpeta personal y clona el repositorio. Sustituye `URL_DEL_REPOSITORIO` por la URL de GitHub que aparece en **Code → HTTPS**.

```bash
sudo apt-get update && sudo apt-get install -y git
mkdir -p ~/proyectos
cd ~/proyectos
git clone URL_DEL_REPOSITORIO entradas-ya
cd entradas-ya
bash scripts/setup-wsl.sh
```

El instalador pide la contraseña de Ubuntu para instalar dependencias. Descarga Node.js y Mailpit de sus fuentes oficiales con comprobación SHA-256, instala PostgreSQL y Nginx, ejecuta `npm ci`, prepara las bases y sus credenciales, aplica migraciones y carga las cuentas de prueba. Al terminar deja la aplicación activa con **nueve eventos de demostración y sus fotografías**.

El primer arranque requiere Internet y puede tardar unos minutos. Clona dentro de `~/proyectos`, en el sistema de archivos de Ubuntu. [Recomendaciones de Microsoft para desarrollar con WSL](https://learn.microsoft.com/windows/wsl/setup/environment).

### 3. Abrir la aplicación

Usa la URL que muestra el comando de arranque, normalmente [http://localhost:8080](http://localhost:8080/). Si ese puerto está ocupado, el lanzador usa [http://localhost:8088](http://localhost:8088/). La bandeja de correos de prueba está en [http://localhost:8025](http://localhost:8025/).

| Cuenta | Correo | Contraseña |
| --- | --- | --- |
| Organizador | `organizador@example.test` | `demo-entradasya` |
| Portero | `portero@example.test` | `demo-entradasya` |
| Cliente | Créala con **Crear una cuenta** en la web. | La que elijas al registrarte. |

Los eventos del seed pertenecen al organizador de prueba. Las compras y los correos son simulados.

## Uso diario

Abre **Ubuntu** y ejecuta:

```bash
cd ~/proyectos/entradas-ya
npm run start:local
```

El comando inicia todo en segundo plano y muestra la URL cuando está listo. Si ya está activo, devuelve la URL existente. Para detener la web, los servicios y el PostgreSQL del proyecto:

```bash
npm run stop:local
```

Las bases, imágenes, entradas y eventos se conservan al detenerlo. El lanzador comprueba los puertos. Para una instalación nueva usa PostgreSQL en 5432 o, si está ocupado, en 5433 y recuerda la elección.

Para actualizar después de que tu compañero suba cambios:

```bash
npm run stop:local
git pull
npm ci
npm run start:local
```

Para volver a ejecutar el seed de eventos usa `npm run seed:events`. Es repetible y detecta el puerto web activo.

## Si algo falla

- **`npm` o `node` no se encuentran**. Cierra y vuelve a abrir Ubuntu después del instalador. Si la preparación se interrumpió, ejecuta de nuevo `bash scripts/setup-wsl.sh`.
- **El arranque devuelve un error**. Revisa `tail -n 60 .local/app.log`. Para ver el log en vivo usa `tail -f .local/app.log`.
- **La web no abre en Windows**. Comprueba que usas la URL que imprime el lanzador. Si tu configuración de WSL bloquea el acceso por localhost, consulta la [guía de red de WSL](https://learn.microsoft.com/windows/wsl/networking).
- **Un puerto está ocupado**. Elige otro puerto web con `WEB_PORT=8090 npm run start:local`. La variable `ENTRADASYA_PG_PORT` permite elegir el puerto del clúster del proyecto durante su preparación.
- **La cámara no tiene permiso**. Puedes escribir el código que aparece al pie del PDF para registrar el ingreso.

## Archivos que se suben a GitHub

Incluye el código, `package.json`, `package-lock.json`, `.nvmrc`, `.gitattributes`, los scripts, `docs/` y las imágenes de `web/public/`. El archivo `.gitignore` ya excluye `.local/`, los archivos de entorno privados, `node_modules/` y `web/dist/`.

Cada equipo genera sus propias bases y credenciales al preparar el proyecto. El seed crea los datos de demostración en el equipo que hace el clon.

## Desarrollo y documentación

En Linux con Node.js 24, PostgreSQL, Mailpit y Nginx disponibles puedes ejecutar `npm ci` y `npm run start:local`. El instalador `scripts/setup-wsl.sh` también prepara Ubuntu local. La [guía de desarrollo local](docs/desarrollo-local.md) detalla los comandos por componente.

| Documento | Contenido |
| --- | --- |
| [Requisitos](docs/requisitos.md) | Alcance y requisitos funcionales y no funcionales. |
| [Arquitectura](docs/arquitectura.md) | Límites de servicios, estados y coordinación. |
| [Convenciones de API](docs/api.md) | Acceso, errores, archivos y reintentos. |
| [OpenAPI](docs/openapi.yaml) | Contratos de operaciones y respuestas. |
| [Guía de implementación](docs/guia-implementacion.md) | Tareas y evidencia de verificación. |
| [Aceptación](docs/aceptacion.md) | Escenarios de prueba. |
| [PlantUML](docs/diagramas/README.md) | Diagramas de arquitectura y flujos. |

`npm run typecheck` comprueba TypeScript. `npm run verify:base` ejecuta las pruebas de servicios y `npm run verify:web` recorre la web en Chromium. Las pruebas de navegador requieren Chrome o Chromium y Poppler (`pdftotext`).
