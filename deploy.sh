#!/bin/bash
# 服务器上更新 Pixelgraphy：./deploy.sh
# 服务器上的代码永远以 GitHub 为准（Pixelgraphy 没有用户数据，覆盖掉也没关系）
set -e
cd "$(dirname "$0")"

echo "▶ 拉取 GitHub 最新代码"
git fetch origin
git reset --hard origin/main   # 丢掉服务器上的任何改动，和 GitHub 完全一致

echo "▶ 安装依赖"
npm ci --omit=dev              # 严格按 package-lock.json 装，不会再改动它

echo "▶ 重启"
pm2 restart pixelgraphy || pm2 start server.js --name pixelgraphy
pm2 save

echo "✓ 完成：$(git log -1 --format='%h %s')"
