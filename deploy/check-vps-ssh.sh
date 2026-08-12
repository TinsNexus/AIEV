#!/usr/bin/env bash
# Chẩn đoán lỗi SSH deploy "handshake failed: ... connection reset by peer".
# Chạy TAY trên VPS (không phải qua CI, lúc đó bạn đã có shell ở đó rồi):
#
#   sudo bash deploy/check-vps-ssh.sh
#
# In ra: sshd có đang chạy/lắng nghe đúng port không, firewall (ufw/iptables)
# đang chặn gì, fail2ban có đang ban IP nào không - ba nguyên nhân hay gặp
# nhất khiến GitHub Actions runner (IP đổi mỗi lần chạy) bị RST lúc handshake.
set -uo pipefail

hr() { printf '\n\033[36m== %s ==\033[0m\n' "$1"; }

hr "sshd: có đang chạy không, lắng nghe port nào"
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null || echo "không tìm thấy unit ssh/sshd"
fi
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | grep -E ':22\b|sshd' || echo "không thấy sshd listen ở port 22 (kiểm tra Port trong /etc/ssh/sshd_config nếu bạn đổi port khác)"
else
  netstat -tlnp 2>/dev/null | grep -E ':22\b|sshd' || echo "không có ss/netstat để kiểm tra port"
fi

hr "ufw (nếu có dùng)"
if command -v ufw >/dev/null 2>&1; then
  ufw status verbose
else
  echo "không cài ufw"
fi

hr "iptables - rule liên quan port 22 (hoặc port bạn đặt trong secret VPS_PORT)"
if command -v iptables >/dev/null 2>&1; then
  iptables -L -n --line-numbers | grep -E '22|REJECT|DROP' || echo "không thấy rule REJECT/DROP nào nhắc tới port 22"
else
  echo "không có iptables"
fi

hr "fail2ban - jail sshd, IP đang bị ban"
if command -v fail2ban-client >/dev/null 2>&1; then
  fail2ban-client status sshd 2>/dev/null || echo "không có jail tên 'sshd' - thử: fail2ban-client status"
  echo
  echo "Gỡ ban một IP cụ thể:  fail2ban-client set sshd unbanip <IP>"
else
  echo "không cài fail2ban"
fi

hr "Kết luận nhanh"
cat <<'EOF'
- Nếu sshd KHÔNG listen ở port khớp secret VPS_PORT     -> sửa secret hoặc sshd_config.
- Nếu ufw/iptables có rule DENY/REJECT/DROP cho port đó
  và không allow theo IP cụ thể                          -> IP runner GitHub Actions (in ở
                                                             bước "Print runner IP" trong log
                                                             workflow) không nằm trong whitelist.
                                                             IP này đổi mỗi lần chạy nên
                                                             allowlist tĩnh không thực tế -
                                                             cân nhắc mở port cho 0.0.0.0/0 và
                                                             dựa vào key-based auth + fail2ban
                                                             để chặn brute-force thay vì chặn
                                                             theo nguồn IP.
- Nếu fail2ban đang ban đúng IP đó                        -> fail2ban-client set sshd unbanip <IP>,
                                                             sau đó chạy lại workflow.
- Nếu tất cả đều sạch mà vẫn reset by peer                -> có thể là firewall/security group
                                                             ở TẦNG CLOUD PROVIDER (dashboard
                                                             Vultr/DigitalOcean/Hetzner...),
                                                             tách biệt với ufw/iptables trong OS -
                                                             kiểm tra ở đó.
EOF
