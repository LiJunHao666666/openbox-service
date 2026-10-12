'use strict';
/**
 * HTTP 中间件 · 静态文件
 *
 * 安全模型：默认拒绝，显式放行。
 *  - 根目录只放行 ROOT_FILES 里列出的少数几个文件；
 *  - 其余只允许 assets/ 目录下白名单扩展名的文件（最多两层）。
 *
 * 绝不能改成「按扩展名放行」—— 那样根目录的 server.js / package.json
 * 会被直接下载，等于把源码和依赖清单公之于众。
 */

const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');

/** 允许直接访问的根目录文件（显式白名单，新增必须手动加进来） */
const ROOT_FILES = new Set([
  'index.html',
  'admin.html',
  'favicon.ico',
  'robots.txt',
  'manifest.webmanifest',
]);

/** 唯一允许承载静态资源的目录，及其下允许的扩展名 */
const ASSET_DIR = 'assets';
const ALLOWED_EXT = new Set([
  '.css', '.js', '.mjs',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.json', '.txt', '.webmanifest',
]);

/** assets/ 下最多允许的目录层数（assets/a/b/x.png = 3 段） */
const MAX_ASSET_DEPTH = 4;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 解析请求路径到磁盘上的真实文件。
 * @returns {{ file: string, mime: string } | null}
 */
function resolve(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // 非法百分号编码
  }

  if (decoded.includes('\0')) return null;
  if (decoded === '/' || decoded === '') decoded = '/index.html';

  // 归一化后必须仍以 / 开头，否则视为穿越
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith('/')) return null;

  const rel = normalized.slice(1);
  if (!rel) return null;

  // 任何一段以 . 开头都拒绝（.env / .git / .genie 等）
  const segments = rel.split('/');
  if (segments.some((s) => s.startsWith('.'))) return null;

  if (segments.length === 1) {
    /* 根目录：只认显式白名单 */
    if (!ROOT_FILES.has(rel)) return null;
  } else {
    /* 其余：只认 assets/ 下的白名单扩展名 */
    if (segments[0] !== ASSET_DIR) return null;
    if (segments.length > MAX_ASSET_DEPTH) return null;
    const ext = path.extname(rel).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return null;
  }

  const ext = path.extname(rel).toLowerCase();
  const abs = path.resolve(config.root, rel);
  // 最终前缀校验：必须仍在项目根之内
  if (abs !== config.root && !abs.startsWith(config.root + path.sep)) return null;

  return { file: abs, mime: MIME[ext] || 'application/octet-stream' };
}

/**
 * 尝试发送静态文件。
 * @returns {boolean} 是否已处理
 */
function send(req, res, urlPath) {
  const hit = resolve(urlPath);
  if (!hit) return false;

  let stat;
  try {
    stat = fs.statSync(hit.file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': hit.mime,
    'Content-Length': stat.size,
    ETag: etag,
    // HTML 不缓存，保证改成即时生效；静态资源短缓存
    'Cache-Control': hit.mime.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(hit.file).pipe(res);
  return true;
}

module.exports = { send, resolve, ROOT_FILES, ALLOWED_EXT, ASSET_DIR };
