import { copyFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const file = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));
await build({
  entryPoints: [file("../web/src/main.tsx")],
  outfile: file("../web/dist/assets/main.js"),
  tsconfig: file("../web/tsconfig.json"),
  bundle: true,
  minify: true,
  external: ["/concierto.webp"],
  loader: { ".woff2": "file", ".woff": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(file("../web/index.html"), file("../web/dist/index.html"));

await cp(file("../web/public/"), file("../web/dist/"), { recursive: true });
