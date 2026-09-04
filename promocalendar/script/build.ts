import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

// Server deps that we want bundled into dist/index.cjs to reduce cold-start
// openat(2) syscalls. Everything else stays external and loads from
// node_modules at runtime.
// Kept small on purpose: better-sqlite3 is a native module and MUST stay
// external (esbuild can't bundle .node addons). Same for anything with a
// runtime require of dynamic paths.
const allowlist = [
  "cookie-parser",
  "cors",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "nanoid",
  "zod",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
