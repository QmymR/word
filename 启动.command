#!/bin/bash
# 指尖绽放 · 一键启动脚本
# 双击本文件即可在本地启动静态服务并打开浏览器。
# 摄像头在 file:// 下无法使用，必须通过 http:// 访问。

cd "$(dirname "$0")"

# 自动找一个可用端口（从 8000 开始，逐个试）
PORT=8000
while lsof -ti :$PORT >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo "========================================"
echo "  指尖绽放 · 本地启动"
echo "  端口：$PORT"
echo "  地址：http://localhost:$PORT"
echo "  关闭此终端窗口即可停止服务"
echo "========================================"

# 启动静态服务（后台运行，但绑定到当前终端，关窗即停）
python3 -m http.server $PORT >/tmp/zhijian_server.log 2>&1 &
SERVER_PID=$!

# 等服务就绪
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null; then
    break
  fi
  sleep 0.3
done

# 用默认浏览器打开
open "http://localhost:$PORT"

# 保持终端窗口打开，显示日志；Ctrl+C 或关窗即停止服务
echo ""
echo "服务已启动，浏览器应已自动打开。"
echo "按 Ctrl+C 或关闭此窗口可停止服务。"
echo ""

# 捕获 Ctrl+C，清理服务
trap "kill $SERVER_PID 2>/dev/null; exit" INT TERM
http://localhost:8000/
# 前台等待，使窗口保持打开
wait $SERVER_PID
