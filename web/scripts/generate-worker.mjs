import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [template, htmlSource, core] = await Promise.all([
  readFile(resolve(root, "worker/index.template.js"), "utf8"),
  readFile(resolve(root, "source/index.html"), "utf8"),
  readFile(resolve(root, "source/agropredict-core-v26-beta.js"), "utf8"),
]);

const favicon = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 64 64\'%3E%3Crect width=\'64\' height=\'64\' rx=\'14\' fill=\'%231b5e3b\'/%3E%3Cpath d=\'M14 42c15-1 25-10 36-27 1 17-8 31-25 34-5 1-9-1-11-7Z\' fill=\'%23f4c95d\'/%3E%3Cpath d=\'M20 46c6-10 13-17 25-24\' fill=\'none\' stroke=\'%23fff\' stroke-width=\'4\' stroke-linecap=\'round\'/%3E%3C/svg%3E">';
const html = htmlSource.replace("</head>", `${favicon}\n</head>`);
const generated = template
  .replace("__HTML_BASE64__", Buffer.from(html).toString("base64"))
  .replace("__CORE_BASE64__", Buffer.from(core).toString("base64"));
await writeFile(resolve(root, "worker/index.js"), generated);
