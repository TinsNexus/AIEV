#!/usr/bin/env bash
# Deploy Tisorr Studio lên VPS - tự kiểm tra môi trường đã setup chưa (Node,
# ffmpeg, dep Chrome headless, systemd unit, .env), làm nốt phần còn thiếu,
# rồi checkout đúng tag release, rebuild, restart. Gọi lại bao nhiêu lần cũng
# được - mỗi bước tự kiểm tra trước khi làm, lần đầu setup hết, lần sau chỉ
# còn checkout + build + restart (vài giây).
#
# Gọi bởi .github/workflows/deploy.yml qua SSH, hoặc chạy tay trên VPS:
#   sudo bash deploy/deploy.sh v1.2.0
#
# Yêu cầu DUY NHẤT không tự lo được: repo phải đã tồn tại ở đường dẫn này
# (deploy.yml tự git clone nếu thiếu, xem "SSH deploy" step) - còn lại (gói hệ
# thống, systemd, .env, build, restart) script này tự làm hết.
#
# VÌ SAO checkout tag chứ không git pull như update/update.sh: update.sh phục vụ
# máy cá nhân bám nhánh main (hoặc kênh do người dùng chọn) và phải backup dữ
# liệu người dùng vì đó là nơi Style Design/sound-effects/skills của họ sống.
# VPS thì khác - deploy đúng một tag cố định, dữ liệu runtime (assets/styles,
# assets/sound-effects, .env...) đều nằm trong .gitignore nên `git checkout`
# không đụng tới, không cần vòng backup/restore phức tạp đó.
set -euo pipefail

SERVICE="${DEPLOY_SERVICE:-tisorr-studio}"
TAG="${1:?Thiếu tag - dùng: deploy.sh v1.2.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[deploy] %s\n' "$1"; }
IS_ROOT=false
[ "$(id -u)" -eq 0 ] && IS_ROOT=true

# ---------- 0. Môi trường hệ thống - chỉ làm phần CHƯA có ----------

ensure_system_deps() {
  if command -v node >/dev/null 2>&1 \
     && [ "$(node --version | cut -d. -f1 | tr -d v)" -ge 22 ] \
     && command -v ffmpeg >/dev/null 2>&1 \
     && dpkg -s libnss3 >/dev/null 2>&1; then
    return 0
  fi
  log "cài gói hệ thống còn thiếu (Node 22, ffmpeg, build tools, dep Chrome headless)..."
  apt-get update -y
  apt-get install -y --no-install-recommends \
    curl ca-certificates git build-essential python3 python3-pip ffmpeg sudo
  # Danh sách chuẩn Puppeteer/Chromium - HyperFrames/Remotion render qua đây,
  # thiếu gói nào thì lỗi "error while loading shared libraries" rất khó đoán.
  apt-get install -y --no-install-recommends \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils libu2f-udev \
    libvulkan1 libasound2t64 || apt-get install -y --no-install-recommends libasound2
  if ! command -v node >/dev/null 2>&1 || [ "$(node --version | cut -d. -f1 | tr -d v)" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
}

ensure_env_file() {
  if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    log ".env chưa có - đã tạo từ .env.example. Điền GEMINI_API_KEY/ANTHROPIC_API_KEY"
    log "  vào $ROOT/.env rồi restart lại: systemctl restart $SERVICE"
  fi
}

ensure_systemd_unit() {
  local unit="/etc/systemd/system/$SERVICE.service"
  if ! cmp -s "$ROOT/deploy/tisorr-studio.service" "$unit" 2>/dev/null; then
    log "cài/cập nhật systemd unit $SERVICE"
    cp "$ROOT/deploy/tisorr-studio.service" "$unit"
    systemctl daemon-reload
    systemctl enable "$SERVICE" >/dev/null
  fi
}

if $IS_ROOT; then
  ensure_system_deps
  ensure_systemd_unit
else
  # Không phải root thì không tự apt/systemctl daemon-reload được - giả định
  # máy đã setup sẵn (vd qua deploy/vps-setup.sh trước đó với user riêng).
  log "không chạy bằng root - bỏ qua bước cài gói hệ thống/systemd unit"
fi
ensure_env_file

# ---------- 1. Checkout đúng tag ----------
log "repo: $ROOT"
log "fetch tags"
git fetch origin --tags --force --prune

log "checkout $TAG"
# --force: bỏ mọi thay đổi cục bộ trong file TRACKED (không đụng file gitignore
# như .env, assets/styles - xem ghi chú đầu file). Detached HEAD là đúng ý ở
# đây: VPS phải chạy đúng snapshot của bản release, không bám nhánh nào cả.
git checkout --force "$TAG"

# ---------- 2. Build ----------
log "npm ci"
npm ci --no-audit --no-fund

log "build (server + web)"
npm run build

# Sau checkout, unit file trong repo có thể đã đổi theo tag mới - kiểm lại.
$IS_ROOT && ensure_systemd_unit

# ---------- 3. Restart ----------
log "restart $SERVICE"
if $IS_ROOT; then
  systemctl restart "$SERVICE"
else
  sudo systemctl restart "$SERVICE"
fi

# ---------- 4. Health check ----------
log "health check"
OK=false
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS -o /dev/null "http://127.0.0.1:6868" && curl -fsS -o /dev/null "http://127.0.0.1:6869/api/health"; then
    OK=true
    break
  fi
done

if [ "$OK" = true ]; then
  log "OK - dashboard + backend đang chạy bản $TAG"
  exit 0
fi

log "LỖI: hệ thống không phản hồi sau khi restart - xem: journalctl -u $SERVICE -n 100 --no-pager"
exit 1
