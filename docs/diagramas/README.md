# Diagramas PlantUML

Los archivos recrean las tres figuras del documento base. El límite de cada figura representa la máquina local. La arquitectura usa React con TypeScript y TypeScript con Node.js y Express.

| Figura del PDF | Archivo | Contenido |
| --- | --- | --- |
| Figura 1, página 2 | [Arquitectura general](01-arquitectura.puml) | Actores, Nginx, ocho componentes y recursos de apoyo. |
| Figura 2, página 5 | [Flujo de compra](02-compra.puml) | Cinco pasos desde el cliente hasta los PDF y el correo de prueba. |
| Figura 3, página 5 | [Flujo de ingreso](03-ingreso.puml) | Cuatro pasos desde el portero hasta la validación y el resultado. |

Los diagramas se pueden abrir en un visor PlantUML o exportar en local si PlantUML y Graphviz están disponibles.

```sh
plantuml -tsvg docs/diagramas/*.puml
```
