import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, "..", "statics", "vendor", "synapse-browser.mjs");

await esbuild.build({
  entryPoints: [path.join(__dirname, "entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: outFile,
  legalComments: "none",
  logLevel: "info",
});

console.log("wrote", outFile);
