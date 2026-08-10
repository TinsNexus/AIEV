#!/usr/bin/env node
/**
 * Đổi tên & thương hiệu toàn repo — một lượt, có xem trước.
 *
 *   node scripts/rebrand.mjs --config rebrand.config.json            # DRY RUN
 *   node scripts/rebrand.mjs --config rebrand.config.json --apply    # ghi thật
 *
 * VÌ SAO KHÔNG DÙNG sed: "tên dự án" trong repo này là NĂM chuỗi khác nhau,
 * lồng vào nhau (AIEV_API_TOKEN chứa AIEV), và ba trong số đó là ĐỊNH DANH
 * GIAO THỨC (biến .env, header, cookie) chứ không phải chữ hiển thị. Thay sai
 * thứ tự là hỏng: `AIEV → Xyz` chạy trước sẽ biến AIEV_API_TOKEN thành
 * Xyz_API_TOKEN thay vì XYZ_API_TOKEN. Bảng RULES dưới đây CỐ Ý xếp từ cụ thể
 * nhất tới chung nhất - đừng sắp xếp lại cho "gọn".
 *
 * KHÔNG đụng tới:
 *  - apps/web/src/lib/brand.ts   → file SINH RA, chạy lại build-brand.mjs
 *  - package-lock.json           → chạy lại `npm install`
 *  - assets/brand-logos/**       → logo của bên thứ ba, không phải của mình
 *  - file nhị phân, .git, node_modules, .next, dist
 *
 * Các file trong REVIEW_MANUAL bị BỎ QUA cố ý và in ra cuối - chúng chứa chuỗi
 * thương hiệu mang ý nghĩa chức năng, phải người đọc rồi sửa tay.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const configPath = args[args.indexOf("--config") + 1];

if (!configPath || !existsSync(configPath)) {
  console.error(`Thiếu file cấu hình. Dùng: node scripts/rebrand.mjs --config rebrand.config.json [--apply]

Mẫu rebrand.config.json:
{
  "fullName":   "Xyz Video Studio",   // thay "AI Edit Video"
  "shortName":  "XVS",                // thay "AIEV" (chữ hiển thị)
  "slug":       "xvs",                // thay "aiev" trong header/cookie (chữ thường, a-z0-9-)
  "pkgName":    "xyz-video-studio",   // thay "ai-edit-video" trong package.json
  "vendor":     "xyz.vn",             // thay "noti.vn"
  "vendorSlug": "xyz",                // thay tiền tố "noti-" của 3 thư mục skill
  "repoPath":   "xyzco/XVS"           // thay "notivn/AIEV" trong badge/link
}`);
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(configPath, "utf8"));
for (const k of ["fullName", "shortName", "slug", "pkgName", "vendor", "vendorSlug", "repoPath"]) {
  if (!cfg[k]) {
    console.error(`Cấu hình thiếu khóa: ${k}`);
    process.exit(2);
  }
}
if (!/^[a-z0-9-]+$/.test(cfg.slug) || !/^[a-z0-9-]+$/.test(cfg.vendorSlug)) {
  console.error("slug và vendorSlug phải là chữ thường a-z0-9-");
  process.exit(2);
}

const SLUG_UPPER = cfg.slug.toUpperCase().replace(/-/g, "_");

/** THỨ TỰ QUAN TRỌNG - cụ thể nhất trước. Xem ghi chú đầu file. */
const RULES = [
  ["notivn/AIEV", cfg.repoPath],
  ["AIEV_API_TOKEN", `${SLUG_UPPER}_API_TOKEN`],
  ["x-aiev-token", `x-${cfg.slug}-token`],
  ["aiev_api_token", `${cfg.slug}_api_token`],
  ["aiev_token", `${cfg.slug}_token`],
  ["AI Edit Video", cfg.fullName],
  ["ai-edit-video", cfg.pkgName],
  ["AIEV", cfg.shortName],
  ["noti-tiktok-full-text", `${cfg.vendorSlug}-tiktok-full-text`],
  ["noti-tiktok-vn", `${cfg.vendorSlug}-tiktok-vn`],
  ["noti-youtube-edit", `${cfg.vendorSlug}-youtube-edit`],
  ["noti.vn", cfg.vendor],
];

const SKILL_RENAMES = [
  ["noti-tiktok-full-text", `${cfg.vendorSlug}-tiktok-full-text`],
  ["noti-tiktok-vn", `${cfg.vendorSlug}-tiktok-vn`],
  ["noti-youtube-edit", `${cfg.vendorSlug}-youtube-edit`],
];

const SKIP = [
  "apps/web/src/lib/brand.ts", // sinh ra từ build-brand.mjs
  "package-lock.json", // chạy lại npm install
  // CHÍNH NÓ: bảng RULES chứa đủ cả 5 chuỗi thương hiệu cũ. Không loại ra thì
  // lượt chạy đầu tiên biến RULES thành ["Tisorr Studio" -> "Tisorr Studio"],
  // và công cụ tự vô hiệu hóa mình - lần chạy sau không tìm thấy gì nữa.
  "scripts/rebrand.mjs",
  "rebrand.config.json",
];
const SKIP_DIR = ["assets/brand-logos/"];

/**
 * Chuỗi thương hiệu ở đây MANG NGHĨA CHỨC NĂNG, không phải nhãn hiển thị.
 * Thay máy móc là hỏng hành vi, nên bỏ qua và bắt người đọc sửa tay.
 */
const REVIEW_MANUAL = {
  "apps/server/src/ttsTypes.ts":
    'PREVIEW_TEXT viết "noi ti chấm vn" theo LỐI PHÁT ÂM để TTS đọc đúng. ' +
    "Tên mới cần một cách phiên âm riêng, không phải thay chuỗi.",
  "apps/server/src/gemini.ts":
    "Ghi chú về việc Gemini tự vẽ monogram khi thấy tên thương hiệu trong prompt - đọc lại xem còn đúng với tên mới không.",
  LICENSE: "Dòng bản quyền - đổi hay giữ là quyết định pháp lý, không phải đổi tên.",
};

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|wav|mp4|mov|zip|pdf)$/i;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !BINARY.test(f))
  .filter((f) => !SKIP.includes(f))
  .filter((f) => !SKIP_DIR.some((d) => f.startsWith(d)))
  .filter((f) => !(f in REVIEW_MANUAL));

let touched = 0;
let total = 0;
const report = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // nhị phân lọt lưới đuôi file
  }
  let out = text;
  let n = 0;
  for (const [from, to] of RULES) {
    const parts = out.split(from);
    if (parts.length > 1) {
      n += parts.length - 1;
      out = parts.join(to);
    }
  }
  if (n === 0) continue;
  touched++;
  total += n;
  report.push([n, file]);
  if (APPLY) writeFileSync(file, out, "utf8");
}

report.sort((a, b) => b[0] - a[0]);
console.log(`${APPLY ? "ĐÃ GHI" : "XEM TRƯỚC (dry run)"} — ${total} thay thế trong ${touched} file\n`);
for (const [n, f] of report) console.log(`  ${String(n).padStart(3)}  ${f}`);

// --- Đổi tên thư mục skill ---
console.log("\nThư mục skill:");
for (const [from, to] of SKILL_RENAMES) {
  const src = path.join(".claude", "skills", from);
  const dst = path.join(".claude", "skills", to);
  if (!existsSync(src)) {
    console.log(`  bỏ qua  ${from} (không có)`);
    continue;
  }
  console.log(`  ${from}  ->  ${to}`);
  if (APPLY) execFileSync("git", ["mv", src, dst]);
}

console.log("\n⚠️  SỬA TAY (cố ý không đụng tới):");
for (const [file, why] of Object.entries(REVIEW_MANUAL)) console.log(`  ${file}\n      ${why}`);

console.log(`
Sau khi chạy --apply:
  1. Thay 3 file PNG trong apps/web/public/brand/ rồi:
       cd apps/web && node scripts/build-brand.mjs
  2. Đổi màu thương hiệu trong assets/brand/brand-tokens.css (nếu có)
  3. npm install            # cập nhật tên package trong package-lock.json
  4. npm run typecheck && npm run build
  5. .env của bạn: đổi AIEV_API_TOKEN thành ${SLUG_UPPER}_API_TOKEN
     (hoặc xóa dòng đó đi, server tự sinh token mới lúc khởi động)
  6. Xóa cookie cũ trong trình duyệt rồi mở lại dashboard
  7. node scripts/security-smoke.mjs   # xác nhận lớp xác thực vẫn nguyên vẹn
`);

if (!APPLY) console.log("Chưa ghi gì cả. Thêm --apply để thực hiện.");
