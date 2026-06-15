const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const publicDist = path.join(publicDir, "dist");
const publicIcons = path.join(publicDir, "icons");

fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDist, { recursive: true });
fs.mkdirSync(publicIcons, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js", "manifest.webmanifest", "sw.js"]) {
  fs.copyFileSync(path.join(root, file), path.join(publicDir, file));
}

fs.copyFileSync(
  path.join(root, "dist", "authenticator.bundle.js"),
  path.join(publicDist, "authenticator.bundle.js"),
);

for (const file of fs.readdirSync(path.join(root, "icons"))) {
  fs.copyFileSync(path.join(root, "icons", file), path.join(publicIcons, file));
}
