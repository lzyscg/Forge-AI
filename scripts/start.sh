#!/bin/bash
# Forge AI Worker 启动脚本
# 用法: ./scripts/start.sh [fake|real]

set -e

MODE=${1:-fake}
DB_PATH=${DB_PATH:-./data/forge.db}
SCENARIO_PATH=${SCENARIO_PATH:-./scenarios/songwriting/scenario.yaml}

echo "=== Forge AI Worker ==="
echo "模式: $MODE"
echo "数据库: $DB_PATH"
echo "场景: $SCENARIO_PATH"
echo ""

if [ "$MODE" = "real" ]; then
  if [ -z "$DEEPSEEK_API_KEY" ]; then
    echo "错误: 真实模式需要设置 DEEPSEEK_API_KEY 环境变量"
    echo "请运行: export DEEPSEEK_API_KEY=your-api-key"
    exit 1
  fi
  PI_MODE=real DB_PATH="$DB_PATH" SCENARIO_PATH="$SCENARIO_PATH" npx tsx apps/worker/src/main.ts
else
  PI_MODE=fake DB_PATH="$DB_PATH" SCENARIO_PATH="$SCENARIO_PATH" npx tsx apps/worker/src/main.ts
fi
