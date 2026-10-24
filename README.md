# 黄瓜吧抖音模式

把黄瓜吧（huangguaba.com）列表页改造成抖音式全屏竖向刷屏体验的油猴脚本。

## 功能

- **全屏竖刷**：滚轮 / ↑↓ 方向键 / 触摸滑动逐条切换，随时可切回原模式（右下角按钮再进）
- **视频 / 图集 / 文字统一播放**：列表页缺视频源的帖子自动读详情页补齐；多图帖左右横滑，双击放大
- **长图缩放**：Ctrl+滚轮以光标为锚点连续缩放（1~4x），缩回 1x 自动退出
- **倍速播放**：1x / 1.5x / 2x / 3x 选择器，全局生效
- **评论抽屉**：侧滑评论区，支持预载与下拉关闭
- **进度恢复**：从头看 / 继续看按钮，跨次浏览自动回到上次位置
- **快捷键**：方向键翻页、`x` 评论区、`c` 切倍速等，右上角 ? 打开快捷键面板
- **兼容镜像站**：huangguaba.wnflb99.com、huanggua8.com

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 安装脚本（二选一）：
   - 直接点击安装：[huanggua-feed.user.js](https://raw.githubusercontent.com/banshanshenlou/huanggua-dy/main/huanggua-feed.user.js)
   - 或在 Tampermonkey 管理面板 → 「+」新建脚本 → 粘贴 [脚本源码](https://raw.githubusercontent.com/banshanshenlou/huanggua-dy/main/huanggua-feed.user.js) 全部内容 → Ctrl+S 保存
3. 打开黄瓜吧任意列表页，点击右下角按钮进入抖音模式

> raw.githubusercontent.com 直连打不开时，可换 jsDelivr 镜像（内容相同，有约 12 小时缓存）：
> [cdn.jsdelivr.net/gh/banshanshenlou/huanggua-dy@main/huanggua-feed.user.js](https://cdn.jsdelivr.net/gh/banshanshenlou/huanggua-dy@main/huanggua-feed.user.js)

## 更新

脚本内置 `@updateURL`，Tampermonkey 会自动检查更新；也可在管理面板对脚本右键 →「检查更新」手动触发。

## 许可

[MIT](LICENSE)
