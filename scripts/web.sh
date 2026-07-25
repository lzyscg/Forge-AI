#!/bin/bash
# Forge AI Web 回放页面启动脚本
# 用法: ./scripts/web.sh

set -e

DB_PATH=${DB_PATH:-./data/forge.db}

echo "=== Forge AI Web 回放 ==="
echo "数据库: $DB_PATH"
echo ""

cd apps/web
DB_PATH="$DB_PATH" npm run dev
