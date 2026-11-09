/// <reference types="vitest/config" />
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { playwright } from "@vitest/browser-playwright";
import stylex from "@stylexswc/unplugin/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { crawlFiles, doorHtml, headTags } from "./src/front/door-static.ts";

const port = Number(process.env.ZIPSCOPE_PORT ?? 4173);
// A fixed port, so that `tailscale serve` always points to this server.
const devPort = Number(process.env.ZIPSCOPE_DEV_PORT ?? 5391);

/**
 * Vite injects `<style>` elements in development, and the CSP in `_headers`
 * blocks them. This plugin adds `style-src 'unsafe-inline'` to the CSP of
 * the development server only. Build and preview use `_headers` as it is.
 */
function devInlineStyles(): Plugin {
  return {
    name: "zipscope:dev-inline-styles",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        // The Cloudflare plugin sends all headers in one `writeHead` call.
        const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
        res.writeHead = ((...args: unknown[]) => {
          const headers = args.at(-1);
          if (typeof headers === "object" && headers !== null && !Array.isArray(headers)) {
            const record = headers as Record<string, unknown>;
            const csp = record["content-security-policy"];
            if (typeof csp === "string") {
              record["content-security-policy"] = `${csp}; style-src 'self' 'unsafe-inline'`;
            }
          }
          return writeHead(...args);
        }) as typeof res.writeHead;
        next();
      });
    },
  };
}

/**
 * Returns the git commit of the build, as 12 hex digits. The Archive panel
 * footer shows it, so a bug report identifies the deploy. A CI build can
 * give it in `ZIPSCOPE_BUILD_SHA` or `GITHUB_SHA`. Without git, it is
 * "unknown".
 */
function buildSha(): string {
  const given = process.env.ZIPSCOPE_BUILD_SHA ?? process.env.GITHUB_SHA;
  if (given !== undefined && given !== "") {
    return given.slice(0, 12);
  }
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Puts the static front door in `index.html`, around the root element, so
 * the served page has it before any script runs. The plugin also adds the
 * head tags of the page. With `ZIPSCOPE_ORIGIN`, it adds the tags that need the
 * production origin, and writes `sitemap.xml` and `robots.txt`. Without it,
 * it adds a `noindex` tag, so a preview deploy stays out of search results.
 * `mise run build:production` gives the value.
 */
function staticDoor(): Plugin {
  const origin = process.env.ZIPSCOPE_ORIGIN;
  return {
    name: "zipscope:static-door",
    transformIndexHtml(html) {
      const body = html.replace('<div id="root"></div>', doorHtml());
      const tags = headTags(origin).map((tag) => ({
        ...tag,
        injectTo: "head" as const,
      }));
      return { html: body, tags };
    },
    generateBundle() {
      if (origin === undefined || origin === "") return;
      const files = crawlFiles(origin);
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: files.sitemap });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: files.robots });
    },
  };
}

/**
 * The entry module loads the app chunk (`src/start.tsx`) only after the
 * browser check (see `src/main.ts`). This plugin adds a `modulepreload`
 * link for that chunk and its static imports to `index.html`, so the
 * browser loads the app at the same time as the entry module. A preload
 * does not run the code, so a browser that cannot run the app only loads
 * it.
 */
function preloadApp(): Plugin {
  return {
    name: "zipscope:preload-app",
    apply: "build",
    enforce: "post",
    transformIndexHtml(_html, context) {
      const bundle = context.bundle;
      if (bundle === undefined) return [];
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      const start = chunks.find((chunk) => chunk.facadeModuleId?.endsWith("/src/start.tsx"));
      if (start === undefined) {
        throw new Error("The build has no chunk for src/start.tsx");
      }
      // The chunks that the entry module loads already need no link.
      const loaded = new Set([context.chunk?.fileName, ...(context.chunk?.imports ?? [])]);
      const files: string[] = [];
      const add = (fileName: string) => {
        if (loaded.has(fileName) || files.includes(fileName)) return;
        files.push(fileName);
        const chunk = chunks.find((next) => next.fileName === fileName);
        for (const imported of chunk?.imports ?? []) add(imported);
      };
      add(start.fileName);
      return files.map((fileName) => ({
        tag: "link",
        attrs: { rel: "modulepreload", crossorigin: true, href: `/${fileName}` },
        injectTo: "head" as const,
      }));
    },
  };
}

/** The files of `public/` that the app shell needs. The social image, the
 *  pictures of the front door (`door/`) and `_headers` are not part of it:
 *  the door shows their text equivalent when they are not in the cache. */
const SHELL_PUBLIC = [
  "app-icon.svg",
  "door-boot.js",
  "favicon.svg",
  "fonts/archivo-black-latin.woff2",
  "manifest.webmanifest",
];

/**
 * Gives the service worker the files of the app shell and a version. After
 * the build wrote its files, this plugin reads `index.html` (as `/`), the
 * files of `SHELL_PUBLIC` and all files of `assets/`, the lazy chunks and
 * all wasm too. The version is a hash of their names and content. The
 * plugin puts both in `sw.js` in place of the string `__ZIPSCOPE_SHELL__`.
 * Thus a change to any file of the shell gives a new `sw.js`, and the
 * browser installs the new version.
 */
function shellList(): Plugin {
  return {
    name: "zipscope:shell",
    apply: "build",
    enforce: "post",
    writeBundle(options) {
      const dir = options.dir ?? "dist";
      const assets = readdirSync(path.join(dir, "assets")).sort();
      const files = ["/", ...SHELL_PUBLIC.map((name) => `/${name}`)].concat(
        assets.map((name) => `/assets/${name}`),
      );
      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(`${file}\n`);
        hash.update(readFileSync(path.join(dir, file === "/" ? "index.html" : file.slice(1))));
      }
      const shell = { version: hash.digest("hex").slice(0, 16), files };
      const worker = path.join(dir, "sw.js");
      // The minifier can put the text in any kind of quotes.
      const parts = readFileSync(worker, "utf8").split(/(["'`])__ZIPSCOPE_SHELL__\1/);
      if (parts.length !== 3) {
        throw new Error("sw.js must have the text __ZIPSCOPE_SHELL__ one time");
      }
      writeFileSync(worker, `${parts[0]}${JSON.stringify(JSON.stringify(shell))}${parts[2]}`);
    },
  };
}

export default defineConfig({
  define: {
    __ZIPSCOPE_BUILD_SHA__: JSON.stringify(buildSha()),
  },
  plugins: [
    staticDoor(),
    preloadApp(),
    shellList(),
    stylex({ useCssPlaceholder: true }),
    solid(),
    // Serves the app as Cloudflare does, with the headers from `_headers`.
    // Vitest starts its own server, which the Cloudflare plugin does not
    // support, and the unit tests do not need it.
    ...(process.env.VITEST === undefined
      ? [
          devInlineStyles(),
          cloudflare({
            // Zipscope is assets only, with no Worker code, so nothing needs the
            // inspector. The plugin picks its port with a check and then a bind,
            // and that races across the whole machine: of two servers that start
            // at one time, one can accept connections and never answer.
            inspectorPort: false,
            experimental: { headersAndRedirectsDevModeSupport: true },
          }),
        ]
      : []),
  ],
  server: {
    // If the port is in use, the server stops. It does not move to a
    // different port.
    port: devPort,
    strictPort: true,
    // Lets you open the development server through `tailscale serve`. The
    // page must have HTTPS to use SharedArrayBuffer, and `tailscale serve`
    // gives a certificate for the `ts.net` name of the machine.
    allowedHosts: [".ts.net"],
    // In development, Vite serves the modules itself, and the Cloudflare
    // plugin applies `_headers` only to the page. A worker script without
    // these headers cannot load in an isolated page.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: { port, strictPort: true },
  worker: {
    // The parse worker is a module worker. It imports the wasm bindings.
    format: "es",
  },
  build: {
    // The browser floor from the spec.
    target: ["chrome125", "firefox147", "safari26"],
    // The StyleX plugin renames the stylesheet after it adds its rules. It
    // can do this only when one stylesheet holds all CSS.
    cssCodeSplit: false,
    rolldownOptions: {
      // The service worker is a second entry. It must be at the root with
      // a fixed name, so that its scope is the whole app.
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        sw: fileURLToPath(new URL("src/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "node/*.test.ts", "bench/reader/*.test.ts"],
          setupFiles: ["vitest.setup.ts"],
          // The UI formats numbers in the default locale. Node reads it
          // from the environment when the test process starts, so the
          // tests do not depend on the locale of the machine.
          env: { LC_ALL: "en_US.UTF-8" },
          // `door.test.ts` reads this stylesheet. Vitest makes other CSS empty.
          css: { include: [/door\.css/] },
          // The wasm tests decode many MiB and take up to 3 s on an idle
          // machine. The tests check counts and memory, not time, so a
          // machine under load must not make them fail. A test that hangs
          // still fails.
          testTimeout: 60_000,
        },
      },
      {
        // Tests of worker code that need a real browser. The server sends
        // the isolation headers, so SharedArrayBuffer is available.
        extends: true,
        test: {
          name: "browser",
          include: ["browser/*.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            // The tests do not depend on the locale of the machine.
            provider: playwright({ contextOptions: { locale: "en-US" } }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
