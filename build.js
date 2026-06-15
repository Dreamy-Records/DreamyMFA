const esbuild = require("esbuild");
const path = require("path");

const cryptoShim = path.join(__dirname, "src", "browser-crypto.js");

esbuild
  .build({
    entryPoints: ["src/authenticator-browser.js"],
    bundle: true,
    format: "iife",
    globalName: "SharedAuthenticatorBundle",
    outfile: "dist/authenticator.bundle.js",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [
      {
        name: "crypto-shim",
        setup(build) {
          build.onResolve({ filter: /^crypto$/ }, () => ({
            path: cryptoShim,
          }));
        },
      },
    ],
  })
  .catch(() => process.exit(1));
