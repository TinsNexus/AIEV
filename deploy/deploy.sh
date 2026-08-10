#!/usr/bin/env bash
# Deploy Tisorr Studio lên VPS - checkout đúng tag release, rebuild, restart
# systemd service. Gọi bởi .github/workflows/deploy.yml qua SSH, hoặc chạy tay:
#   bash deploy/deploy.sh v1.2.0
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

log "repo: $ROOT"
log "fetch tags"
git fetch origin --tags --force --prune

log "checkout $TAG"
# --force: bỏ mọi thay đổi cục bộ trong file TRACKED (không đụng file gitignore
# như .env, assets/styles - xem ghi chú đầu file). Detached HEAD là đúng ý ở
# đây: VPS phải chạy đúng snapshot của bản release, không bám nhánh nào cả.
git checkout --force "$TAG"

log "npm ci"
npm ci --no-audit --no-fund

log "build (server + web)"
npm run build

log "restart $SERVICE"
sudo systemctl restart "$SERVICE"

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
