// Pixelgraphy 静态服务器
// 服务器上：有 tinggg.live 的 Let's Encrypt 证书就用 HTTPS；本地没有证书就用 HTTP
const express = require("express");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4100;
const DOMAIN = process.env.DOMAIN || "tinggg.live";
const keyPath = `/etc/letsencrypt/live/${DOMAIN}/privkey.pem`;
const certPath = `/etc/letsencrypt/live/${DOMAIN}/fullchain.pem`;

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  https
    .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
    .listen(PORT, () => console.log(`Pixelgraphy → https://${DOMAIN}:${PORT}`));
} else {
  http.createServer(app).listen(PORT, () => console.log(`Pixelgraphy → http://localhost:${PORT}`));
}
