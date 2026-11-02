// Pixelgraphy 静态服务器
// 证书优先级：服务器上的 tinggg.live 正式证书 → 本地的 localhost.pem → 都没有就用 HTTP
const express = require("express");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4100;
const DOMAIN = process.env.DOMAIN || "tinggg.live";

const CERTS = [
  { key: `/etc/letsencrypt/live/${DOMAIN}/privkey.pem`, cert: `/etc/letsencrypt/live/${DOMAIN}/fullchain.pem`, host: DOMAIN },
  { key: path.join(__dirname, "localhost-key.pem"), cert: path.join(__dirname, "localhost.pem"), host: "localhost" },
];
const found = CERTS.find((c) => fs.existsSync(c.key) && fs.existsSync(c.cert));

if (found) {
  https
    .createServer({ key: fs.readFileSync(found.key), cert: fs.readFileSync(found.cert) }, app)
    .listen(PORT, () => console.log(`Pixelgraphy → https://${found.host}:${PORT}`));
} else {
  http.createServer(app).listen(PORT, () => console.log(`Pixelgraphy → http://localhost:${PORT}`));
}
