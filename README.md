# Pixelgraphy

32×32 像素画板，从 [Predate](https://github.com/tinggg-yyy/Predate) 的兽人形象画板拆出来。

- 画笔：同一格反复划过会逐级加深（4 级）
- 输入文字后，用文字来画
- 橡皮擦 / 撤销（Cmd/Ctrl+Z）/ 清空
- 7 套配色
- 保存为 1024×1024 PNG

## 本地运行

```
npm install
npm start
```

打开 http://localhost:4100

## 服务器

```
npm install
pm2 start server.js --name pixelgraphy
```

有 `/etc/letsencrypt/live/tinggg.live/` 证书时自动用 HTTPS：https://tinggg.live:4100
