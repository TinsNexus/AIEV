#!/usr/bin/env bash
# Setup lần đầu cho VPS Ubuntu/Debian trống - chạy MỘT LẦN bằng tay (sudo), không
# phải một phần của workflow deploy tự động (đó là deploy/deploy.sh).
#
# Sau khi script này chạy xong, .github/workflows/deploy.yml chỉ còn việc SSH
# vào gọi deploy/deploy.sh mỗi khi bạn publish Release - không cần làm lại các
# bước ở đây nữa.
#
#   sudo bash deploy/vps-setup.sh
#
# Đã test trên giả định Ubuntu 22.04/24.04. Distro khác (Debian, Rocky...) thì
# đọc qua từng bước, đổi `apt` cho khớp trình quản lý gói của bạn.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tinnt-truman/AIEV.git}"
REPO_PATH="${REPO_PATH:-/opt/tisorr-studio}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
GIT_REF="${GIT_REF:-main}"   # nhánh/tag để checkout lần đầu - deploy.sh sẽ tự đổi theo tag release sau này

if [ "$(id -u)" -ne 0 ]; then
  echo "Chạy script này bằng sudo/root: sudo bash deploy/vps-setup.sh" >&2
  exit 1
fi

log() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

log "1/8 apt update + gói hệ thống"
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates git build-essential python3 python3-pip \
  ffmpeg \
  sudo

log "2/8 Chrome headless deps (Puppeteer dùng để render HyperFrames/Remotion)"
# Danh sách chuẩn Puppeteer/Chromium trên Debian/Ubuntu - thiếu gói nào thì
# render scene HTML sẽ lỗi "error while loading shared libraries" rất khó đoán.
apt-get install -y --no-install-recommends \
  fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
  libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils libu2f-udev \
  libvulkan1 libasound2t64 || apt-get install -y --no-install-recommends libasound2

log "3/8 Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

log "4/8 Tạo user chạy dịch vụ ($DEPLOY_USER, không có quyền login shell nguy hiểm)"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$DEPLOY_USER"
fi
# Home thật lấy từ /etc/passwd, KHÔNG đoán theo mẫu /home/<user> - root có home
# là /root chứ không phải /home/root, đoán sai là ghi nhầm chỗ, SSH vẫn 401.
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
mkdir -p "$DEPLOY_HOME/.ssh"
touch "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 700 "$DEPLOY_HOME/.ssh"
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
echo "  -> Dán PUBLIC KEY của cặp khóa deploy (GitHub Actions dùng private key tương ứng) vào:"
echo "     $DEPLOY_HOME/.ssh/authorized_keys"

log "5/8 Clone repo vào $REPO_PATH"
if [ ! -d "$REPO_PATH/.git" ]; then
  git clone --branch "$GIT_REF" "$REPO_URL" "$REPO_PATH"
else
  # Repo đã có sẵn (vd bạn tự clone tay trước khi chạy script này) - vẫn đảm
  # bảo đang đứng đúng GIT_REF, không thì deploy/ có thể chưa tồn tại ở nhánh
  # hiện tại (deploy/ mới chỉ có trên develop, chưa merge main).
  git -C "$REPO_PATH" fetch origin "$GIT_REF"
  git -C "$REPO_PATH" checkout "$GIT_REF"
  git -C "$REPO_PATH" merge --ff-only "origin/$GIT_REF" 2>/dev/null || true
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_PATH"

log "6/8 Cài dependencies + build lần đầu (chạy dưới quyền $DEPLOY_USER)"
su - "$DEPLOY_USER" -c "cd '$REPO_PATH' && npm ci --no-audit --no-fund && npm run build"

if [ ! -f "$REPO_PATH/.env" ]; then
  su - "$DEPLOY_USER" -c "cp '$REPO_PATH/.env.example' '$REPO_PATH/.env'"
  echo "  -> Đã tạo $REPO_PATH/.env từ .env.example - ĐIỀN GEMINI_API_KEY / ANTHROPIC_API_KEY"
  echo "     trước khi các tính năng AI dùng được (Chat/AI vẫn cần đăng nhập Claude Code"
  echo "     dưới user $DEPLOY_USER, hoặc set ANTHROPIC_API_KEY trong .env)."
fi

log "7/8 Cài systemd service"
cp "$REPO_PATH/deploy/tisorr-studio.service" /etc/systemd/system/tisorr-studio.service
# Service file mặc định User=deploy WorkingDirectory=/opt/tisorr-studio - nếu
# bạn đổi DEPLOY_USER/REPO_PATH ở trên thì sửa lại 2 dòng đó trong file service.
systemctl daemon-reload
systemctl enable tisorr-studio
systemctl restart tisorr-studio

log "8/8 Cho phép $DEPLOY_USER restart service KHÔNG cần mật khẩu (deploy.sh gọi sudo systemctl restart)"
cat > /etc/sudoers.d/tisorr-deploy <<EOF
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart tisorr-studio, /usr/bin/systemctl status tisorr-studio
EOF
chmod 440 /etc/sudoers.d/tisorr-deploy
visudo -cf /etc/sudoers.d/tisorr-deploy

echo ""
echo "==================================================================="
echo " Xong. Kiểm tra:"
echo "   systemctl status tisorr-studio"
echo "   curl -I http://127.0.0.1:6868"
echo ""
echo " CẢNH BÁO (giống README): dashboard chưa có đăng nhập - KHÔNG mở port"
echo " 6868/6869 thẳng ra internet. Dùng Cloudflare Tunnel + Cloudflare Access,"
echo " hoặc reverse proxy có auth, hoặc chỉ truy cập qua VPN/SSH tunnel riêng."
echo ""
echo " Việc còn lại để GitHub Actions deploy được:"
echo "   1. Thêm PUBLIC key vào $DEPLOY_HOME/.ssh/authorized_keys (đã nhắc ở bước 4)"
echo "   2. Thêm 4 secret trong GitHub repo -> Settings -> Secrets and variables -> Actions:"
echo "        VPS_HOST  = IP hoặc domain VPS"
echo "        VPS_USER  = $DEPLOY_USER"
echo "        VPS_SSH_KEY = PRIVATE key tương ứng (dán nguyên file, kể cả dòng BEGIN/END)"
echo "        VPS_PORT  = cổng SSH (thường 22)"
echo "      (tuỳ chọn) VPS_PATH = $REPO_PATH nếu bạn KHÔNG dùng đúng đường dẫn mặc định"
echo "   3. Publish một GitHub Release với tag dạng v* -> workflow deploy tự chạy."
echo "==================================================================="
