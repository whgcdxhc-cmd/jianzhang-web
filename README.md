# 简账

个人记账 PWA，核心体验是“极速记录 + 自动记账 + 生活时间轴 + 搜索分析”。

## 当前能力

- 手动记账、快记、iOS 快捷指令 URL 自动记账
- 多账本、一二级分类、标签、图片、Mood、位置和不计入统计
- 修改、删除、退款、再记、左滑操作
- 日/周/月/季度/年统计、柱状图、饼图、日报表和周视图
- 预算、账本封面、深浅主题和字体设置
- 微信支付 Excel、支付宝 CSV 和 JSON 备份导入导出
- 独立邮箱账号、云端账本、云端图片和多设备同步
- PWA 安装与 Service Worker 离线外壳

## 技术结构

- 前端：`public/`
- 自动识别：`public/parser.js`
- 账单导入：`public/importers.js`
- 云端同步：`public/storage.js`
- 独立账号：`worker/auth.ts`
- 云端账本与图片接口：`worker/cloud-api.ts`
- 数据库结构和迁移：`db/`、`drizzle/`
- 部署：Cloudflare Workers + D1 + R2

正式账单只保存到 D1/R2；浏览器里的旧 IndexedDB 数据只用于一次性迁移，迁移成功后会删除。

## 本地开发

要求 Node.js `>=22.13.0`。

```bash
npm install
npm run build
npx wrangler d1 migrations apply jianzhang-db --local --config wrangler.jsonc
npm run dev
```

另开终端执行端到端云端流程测试：

```bash
node tests/local-cloud-e2e.mjs
```

完整自动测试：

```bash
npm test
```

## Cloudflare 免费部署

1. `npx wrangler login`
2. `npx wrangler d1 create jianzhang-db`
3. 把返回的 D1 `database_id` 写入 `wrangler.jsonc`
4. `npx wrangler r2 bucket create jianzhang-files`
5. `npx wrangler d1 migrations apply jianzhang-db --remote --config wrangler.jsonc`
6. `npm run build`
7. `npx wrangler deploy --config dist/server/wrangler.json`

首次访问正式网址时注册简账账号即可。生产环境使用 HttpOnly、Secure、SameSite Cookie；密码通过 PBKDF2-SHA256 加盐哈希存储。

## 自动记账 URL

```text
https://你的简账地址/?autobook=1&text=<URL编码后的屏幕识别文字>
```

该协议保留给 iOS 快捷指令、Android 分享和未来自动化入口使用。
