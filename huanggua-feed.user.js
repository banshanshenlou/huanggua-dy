// ==UserScript==
// @name         黄瓜吧抖音模式
// @namespace    huanggua-dy
// @version      1.31.1
// @description  把黄瓜吧列表页改造成抖音式全屏竖向刷屏，可随时切回原模式
// @updateURL    https://raw.githubusercontent.com/banshanshenlou/huanggua-dy/main/huanggua-feed.user.js
// @downloadURL  https://raw.githubusercontent.com/banshanshenlou/huanggua-dy/main/huanggua-feed.user.js
// @match        https://www.huangguaba.com/*
// @match        https://huangguaba.com/*
// @match        http://www.huangguaba.com/*
// @match        http://huangguaba.com/*
// @match        https://huangguaba.wnflb99.com/*
// @match        https://www.huangguaba.wnflb99.com/*
// @match        http://huangguaba.wnflb99.com/*
// @match        http://www.huangguaba.wnflb99.com/*
// @match        https://huanggua8.com/*
// @match        https://www.huanggua8.com/*
// @match        http://huanggua8.com/*
// @match        http://www.huanggua8.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 设计要点与边界：
 *
 * 1. 翻页解析列表 HTML；列表只提供封面的疑似微博视频帖，在激活时读取详情页补视频。
 *    详情请求与评论共用缓存，保留图片并允许左右切换，不批量抓取详情。
 *
 * 2. 视频元素最多同时存在 3 个。每张卡片一个 <video> 会耗尽解码器，
 *    长列表下表现为卡顿与黑屏；这里用固定的三个元素轮转复用。
 *
 * 3. 原模式必须零残留。关闭浮层时移除根节点、样式、事件监听，恢复 html/body 的
 *    overflow 与原页面滚动位置。仅保留右下角启动按钮，这是再次进入的入口。
 *
 * 4. 未登录时不调用站点的点赞/收藏接口，只做本地标记。站点接口要求登录，
 *    直接调用会跳转到注册页，打断浏览。
 *
 * 5. 图标全部内联 SVG，不加载任何图标库（受 @grant none 与离线可用约束）。
 *    除下方列出的 4 个定制图，其余均复制 lucide（ISC）官方 path，
 *    不凭记忆临摹：自拟形状在单个简单图形上勉强能看，一到复合图形就崩（如横屏）。
 *    定制图：iconJumpToTop / iconJumpToBottom（回到顶部、跳向底部语义）
 *           iconClean / iconRestore（抖音清屏角标）。
 */

(function () {
  'use strict';

  if (window.__dyfLoaded) return;
  window.__dyfLoaded = true;

  // ---------------------------------------------------------------- 配置

  const VERSION = '1.31.1';

  const CONFIG = {
    sel: {
      list: '.post-list',
      card: '.post-card',
      authorName: '.author-name',
      authorLink: 'a.post-author',
      time: '.post-time',
      title: '.post-title a',
      pin: '.pin-badge',
      mediaWrap: '.post-image-wrap',
      videoWrap: '.post-image-wrap.is-video',
      video: 'video[data-video-src]',
      fallbackImage: '.post-images:not(.post-media-grid)',
      detailCard: '.post-card.detail-card',
      weiboVideo: '.post-content .weibo-video-embed video[data-video-src]',
      excerpt: '.post-content-excerpt',
      embed: '.bilibili-embed-card iframe',
      tag: '.post-tags a, a[href*="tag="]',
      likeCount: '.vote-count',
      commentCount: '.comment-count-num',
      loggedInNav: 'nav a[href*="logout.php"]',
      pageLike: '.vote-btn.upvote',
      pageBookmark: 'button[onclick*="toggleBookmark"]',
      pagerNext: '.pagination .page-next'
    },
    // 浮层内保留视频元素的上限，超过会导致解码器不足
    videoPoolSize: 3,
    videoLoadTimeoutMs: 10000,
    // 卡顿自愈：waiting/stalled 持续这么久仍无进展就原地重新拉流一次
    videoStallRecoverMs: 5000,
    // 距列表末尾多少条开始自动翻页
    loadAhead: 5,
    // 主动切换时的锁定时长，避免一次滚轮手势连跳多条
    wheelLockMs: 500,
    // 触控板一次手势会发多个小增量，累计到该值才翻页
    wheelThreshold: 50,
    storePrefix: 'dyf:'
  };

  const DEFAULT_SETTINGS = {
    autoplay: true,
    muted: true,
    autoEnter: true,
    autoNext: true,
    playbackRate: 1,
    blockTags: '',
    blockAuthors: ''
  };

  // ---------------------------------------------------------------- 存储

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  const store = {
    get(key, fallback) {
      try {
        if (hasGM) {
          const v = GM_getValue(key, undefined);
          return v === undefined ? fallback : v;
        }
        const raw = localStorage.getItem(CONFIG.storePrefix + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (hasGM) { GM_setValue(key, value); return; }
        localStorage.setItem(CONFIG.storePrefix + key, JSON.stringify(value));
      } catch (e) { /* 存储不可用时静默降级，不影响浏览 */ }
    },
    remove(key) {
      try {
        if (hasGM) { GM_setValue(key, undefined); return; }
        localStorage.removeItem(CONFIG.storePrefix + key);
      } catch (e) { /* 同上 */ }
    }
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  if (settings.muted) {
    // 浏览器自动播放策略要求初始静音，未静音时 play() 会被拒绝
    settings.muted = true;
  }

  const likedIds = new Set(store.get('liked', []));
  const favIds = new Set(store.get('fav', []));

  function saveLiked() { store.set('liked', [...likedIds]); }
  function saveFav() { store.set('fav', [...favIds]); }

  // ------------------------------------------------------------ 阅读位置

  /**
   * 阅读位置只按帖子 ID 记，不再保存已看过的整批 ID：
   * 帖子 ID 在站内稳定，列表索引会随新增帖与排序漂移，只作本地定位加速。
   * - last：最近一次阅读位置，进入浮层按它恢复；
   * - farthest：最靠后的阅读进度，单调不回退，回翻顶部不覆盖。
   * 按 (sort, tag) 各存一份，切分类回来位置不丢；最多保留 5 份防止累积。
   */
  const MARK_LIMIT = 5;

  const markKey = (sort, tag) => String(sort || '') + '|' + String(tag || '');
  const markStamp = entry => Math.max(entry?.last?.at || 0, entry?.farthest?.at || 0);

  /** 读取全部阅读位置，顺手迁移旧数据：单槽 progress 转 last，全量 seen 集合删除。 */
  function readMarks() {
    let map = store.get('bookmarks', null);
    if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
    const legacy = store.get('progress', null);
    if (legacy && legacy.postId) {
      const key = markKey(legacy.sort, legacy.tag);
      if (!map[key] || !map[key].last) {
        map[key] = Object.assign({}, map[key], {
          last: { postId: legacy.postId, at: legacy.at || Date.now() }
        });
        store.set('bookmarks', map);
      }
      store.remove('progress');
    }
    if (store.get('seen', null) != null) store.remove('seen');
    return map;
  }

  /** 写回某个 (sort, tag) 的位置；entry 为空表示清除该分类的进度 */
  function writeMarks(sort, tag, entry) {
    const map = readMarks();
    if (entry) map[markKey(sort, tag)] = entry;
    else delete map[markKey(sort, tag)];
    const keys = Object.keys(map).filter(key => map[key] && typeof map[key] === 'object');
    if (keys.length > MARK_LIMIT) {
      keys.sort((a, b) => markStamp(map[b]) - markStamp(map[a]));
      for (const key of keys.slice(MARK_LIMIT)) delete map[key];
    }
    store.set('bookmarks', map);
    return map;
  }

  // ---------------------------------------------------------------- 工具

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function textOf(root, selector) {
    const node = root.querySelector(selector);
    return node ? node.textContent.trim() : '';
  }

  /**
   * 站点把部分图片地址写在 openLightbox 的 JS 字符串里，`&` 被转义成字面
   * `\u0026`。这种地址直接请求会失败（返回错误页而不是图片），必须先还原。
   * 只处理 URL 会出现的转义形式，不引入 eval。
   */
  function decodeUrlEscapes(url) {
    if (!url) return '';
    let out = String(url);
    if (out.indexOf('\\u') >= 0) {
      out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (out.indexOf('\\/') >= 0) out = out.split('\\/').join('/');
    return out;
  }

  /** 图片地址归一化：还原转义并按当前页解析成绝对地址，失败返回空串 */
  function imageUrl(raw) {
    const decoded = decodeUrlEscapes(raw).trim();
    if (!decoded) return '';
    try {
      const url = new URL(decoded, location.origin);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (e) {
      return '';
    }
  }

  function toInt(value) {
    const n = parseInt(String(value || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** 优先使用站点登录标记；标记尚未提供时读取服务端渲染的退出入口。 */
  function isLoggedIn() {
    const navLoggedIn = !!document.querySelector(CONFIG.sel.loggedInNav);
    if (typeof window.isLoggedIn === 'boolean') return window.isLoggedIn || navLoggedIn;
    return navLoggedIn;
  }

  /** 沿用站点会话和 CSRF 校验；只把接口明确成功视为账号操作完成。 */
  async function requestAccountAction(action, postId) {
    if (typeof window.CSRF_TOKEN !== 'string' || !window.CSRF_TOKEN) {
      throw new Error('页面加载不完整，请刷新后重试');
    }
    const body = new URLSearchParams({ post_id: postId, csrf_token: window.CSRF_TOKEN });
    if (action === 'vote') body.set('vote_type', '1');
    const response = await fetch('/api/' + action + '.php', {
      method: 'POST', credentials: 'same-origin', body, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('请求失败（HTTP ' + response.status + '）');
    const text = await response.text();
    let data;
    // 站点现有逻辑允许 JSON 前出现 PHP 提示，但仍必须确认 success。
    try { data = JSON.parse(text.slice(text.indexOf('{'))); }
    catch (e) { throw new Error('服务器响应无效，请重试'); }
    if (!data || data.success !== true) throw new Error(data?.message || '操作失败，请重试');
    return data;
  }

  // ---------------------------------------------------------------- 解析

  /**
   * 把一条列表卡片解析为统一结构。
   * 返回 null 表示该卡片缺少 id，无法定位原帖，直接丢弃。
   */
  function parseCard(card) {
    const S = CONFIG.sel;
    const id = (card.getAttribute('data-id') || '').trim();
    if (!id) return null;

    const titleA = card.querySelector(S.title);
    const authorA = card.querySelector(S.authorLink);

    // 一条帖子可能挂多个视频，必须全部取到；只取第一个会漏掉后面的。
    // grid-cover 布局的卡片不渲染内层 <video>，源与封面直接挂在
    // .post-image-wrap.is-video 的 data-video-src / data-poster 属性上，需兜底读取。
    const videos = [...card.querySelectorAll(S.videoWrap)]
      .map(wrap => {
        const v = wrap.querySelector(S.video);
        if (v) {
          return {
            src: decodeUrlEscapes(v.getAttribute('data-video-src') || ''),
            poster: imageUrl(v.getAttribute('poster') || ''),
            vid: v.getAttribute('data-video-vid') || ''
          };
        }
        return {
          src: decodeUrlEscapes(wrap.getAttribute('data-video-src') || ''),
          poster: imageUrl(wrap.getAttribute('data-poster') || ''),
          vid: wrap.getAttribute('data-video-vid') || ''
        };
      })
      .filter(v => v.src);

    // 视频卡片的媒体区同样使用 .post-image-wrap，但带 is-video 类，
    // 其中的图片只是封面，不能计入图集。
    const imageWraps = [...card.querySelectorAll(S.mediaWrap)]
      .filter(wrap => !wrap.classList.contains('is-video'));

    // 图片地址：data-original 是站点自己的大图属性，值未转义，首选；
    // openLightbox 的 onclick 含转义字符，只作兜底；img.src 是缩略图，最后兜底。
    const images = imageWraps.map(wrap => {
      const img = wrap.querySelector('img');
      const original = img ? img.getAttribute('data-original') || img.getAttribute('data-src') : '';
      const fromOriginal = imageUrl(original);
      if (fromOriginal) return fromOriginal;
      const onclick = wrap.getAttribute('onclick') || '';
      const matched = onclick.match(/openLightbox\(\s*['"]([^'"]+)['"]/);
      if (matched) {
        const fromLightbox = imageUrl(matched[1]);
        if (fromLightbox) return fromLightbox;
      }
      return img ? imageUrl(img.getAttribute('src') || '') : '';
    }).filter(Boolean);

    // 每张图是否带 GIF 标记，保存时据此决定扩展名；与 images 同源同序，
    // 地址解析失败的条目两边一起剔除，否则索引会错位
    const imageGif = imageWraps
      .map((wrap, i) => ({ gif: !!wrap.querySelector('.gif-badge'), url: images[i] }))
      .filter(item => item.url)
      .map(item => item.gif);

    const excerptEl = card.querySelector(S.excerpt);
    const embedEl = card.querySelector(S.embed);

    const tags = [...card.querySelectorAll(S.tag)]
      .map(a => a.textContent.trim())
      .filter(t => t.startsWith('#'));

    let type = 'text';
    if (videos.length && images.length) type = 'mixed';
    else if (videos.length) type = 'video';
    else if (images.length) type = 'image';
    else if (embedEl) type = 'embed';

    // GIF 只能靠 .gif-badge 判断：图片全部走搜狗代理，地址后缀统一是 .jpg
    const hasGifBadge = !!card.querySelector('.post-image-wrap .gif-badge');
    let kind = '图文';
    if (type === 'mixed') kind = '图+视频';
    else if (type === 'video') kind = videos.length > 1 ? '视频 ' + videos.length : '视频';
    else if (images.length > 1) kind = '图集 ' + images.length + (hasGifBadge ? ' · GIF' : '');
    else if (images.length === 1 && hasGifBadge) kind = 'GIF';
    else if (images.length === 1) kind = '图片';
    else if (type === 'embed') kind = '站外视频';

    return {
      id,
      url: titleA ? titleA.href : location.origin + '/detail.php?id=' + id,
      title: titleA ? titleA.textContent.trim() : '',
      author: textOf(card, S.authorName),
      authorUrl: authorA ? authorA.href : '',
      time: textOf(card, S.time),
      pinned: !!card.querySelector(S.pin),
      type,
      kind,
      videos,
      images,
      imageGif,
      // 列表没有可靠的视频标记；线索只决定是否读取详情，有无视频由详情 DOM 确认。
      needsDetailMedia: !videos.length && !embedEl && images.length <= 1 &&
        (!!card.querySelector(S.fallbackImage) || tags.includes('#微博') ||
          /来源\s*[:：]|weibo\.com|微博/.test(excerptEl ? excerptEl.textContent : '')),
      excerpt: excerptEl ? excerptEl.textContent.trim() : '',
      embed: embedEl ? embedEl.src : '',
      tags,
      likes: toInt(textOf(card, S.likeCount)),
      comments: toInt(textOf(card, S.commentCount))
    };
  }

  /**
   * 从详情页 HTML 中提取评论。
   * 站点没有评论列表接口，只能解析服务端渲染的 .comment-list。
   * depth-N 类名决定嵌套层级，必须保留，否则楼中楼会被拍平。
   */
  function parseComments(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const list = doc.querySelector('.comment-list');
    if (!list) return [];

    return [...list.querySelectorAll('.comment-item')].map(item => {
      const depthMatch = item.className.match(/depth-(\d+)/);
      const avatarImg = item.querySelector('.comment-avatar img');
      // .act-badge 内部有编号与称号两段，直接取 textContent 会粘成「37王牌黄瓜 Lv.37」
      const tierEl = item.querySelector('.act-badge .act-tier-inline');
      const badgeEl = item.querySelector('.act-badge');
      const text = textOf(item, '.comment-text');
      // 部分评论只有表情贴纸，正文为空。
      // 只认 .comment-sticker；正文里的 twemoji 表情图仅在整条没有文字时才作为图片兜底。
      const stickerEl = item.querySelector('.comment-text img.comment-sticker') ||
        (!text ? item.querySelector('.comment-text img') : null);
      return {
        id: item.getAttribute('data-comment-id') || item.id || '',
        depth: depthMatch ? Number(depthMatch[1]) : 0,
        author: textOf(item, '.comment-author'),
        level: tierEl ? tierEl.textContent.trim()
          : (badgeEl ? (badgeEl.getAttribute('title') || '').replace(/^活跃度\s*\d+\s*·\s*/, '') : ''),
        avatar: avatarImg ? avatarImg.src : '',
        time: textOf(item, '.comment-time'),
        text,
        sticker: stickerEl ? new URL(stickerEl.getAttribute('src'), location.origin).href : '',
        likes: toInt(textOf(item, '.comment-actions'))
      };
    });
  }

  /** 只读取主帖正文中的微博视频，避免把评论或推荐帖的媒体并入当前帖。 */
  function parseDetail(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const card = doc.querySelector(CONFIG.sel.detailCard);
    if (!card) throw new Error('详情页未返回帖子内容');
    const videos = [...card.querySelectorAll(CONFIG.sel.weiboVideo)].map(video => {
      const src = new URL(decodeUrlEscapes(video.getAttribute('data-video-src') || ''), location.origin);
      // 镜像站也通过当前站点的中转接口播放，保持同源与站点正常的 Referer。
      if (src.pathname === '/api/weibo_video.php') src.host = location.host;
      src.protocol = src.host === location.host ? location.protocol : src.protocol;
      return {
        src: src.href,
        poster: imageUrl(video.getAttribute('poster') || ''),
        vid: video.getAttribute('data-video-vid') || ''
      };
    }).filter(video => /^https?:/.test(video.src));
    return { videos, comments: parseComments(html) };
  }

  // ---------------------------------------------------------------- 数据源
  class FeedSource {
    constructor() {
      const params = new URLSearchParams(location.search);
      this.sort = params.get('sort') || 'latest';
      this.tag = params.get('tag') || '0';
      this.page = toInt(params.get('page')) || 1;
      this.posts = [];
      this.seen = new Set();
      this.loading = false;
      this.error = null;
      // 各分页在 posts 中的起始索引：pageRanges[i] 表示第 page 页的条目从 start 开始。
      // 退出浮层时按当前条目反查所在分页，直接跳到那一页而不是详情页
      this.pageRanges = [{ page: this.page, start: 0 }];

      const next = document.querySelector(CONFIG.sel.pagerNext);
      if (next && next.getAttribute('href')) {
        this.nextUrl = next.getAttribute('href');
        this.hasMore = true;
      } else {
        this.nextUrl = `?sort=${encodeURIComponent(this.sort)}&tag=${encodeURIComponent(this.tag)}&page=${this.page + 1}`;
        // 没有下一页链接说明已是最后一页
        this.hasMore = false;
      }
    }

    addFromDocument() {
      const cards = [...document.querySelectorAll(CONFIG.sel.card)];
      return this.addCards(cards.map(parseCard));
    }

    /** 按 id 去重后追加；置顶公告会在每页重复出现，必须过滤 */
    addCards(list) {
      const added = [];
      for (const post of list) {
        if (!post || this.seen.has(post.id)) continue;
        this.seen.add(post.id);
        this.posts.push(post);
        added.push(post);
      }
      return added;
    }

    async fetchNext() {
      if (this.loading || !this.hasMore || !this.nextUrl) return [];
      this.loading = true;
      this.error = null;
      try {
        const requestUrl = this.nextUrl;
        const res = await fetch(requestUrl, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

        const next = doc.querySelector(CONFIG.sel.pagerNext);
        this.nextUrl = next ? next.getAttribute('href') : null;
        if (!this.nextUrl) this.hasMore = false;

        // 记录本次抓取页的起始索引；页码优先取请求 URL 的 page 参数
        const pageParam = toInt(new URLSearchParams(requestUrl.split('?')[1] || '').get('page'));
        const lastRange = this.pageRanges[this.pageRanges.length - 1];
        this.pageRanges.push({
          page: pageParam > 0 ? pageParam : lastRange.page + 1,
          start: this.posts.length
        });

        const cards = [...doc.querySelectorAll(CONFIG.sel.card)];
        return this.addCards(cards.map(parseCard));
      } catch (e) {
        this.error = e;
        throw e;
      } finally {
        this.loading = false;
      }
    }

    /** 反查条目索引所在的列表分页页码 */
    pageOf(index) {
      let page = this.pageRanges[0] ? this.pageRanges[0].page : this.page;
      for (const range of this.pageRanges) {
        if (index >= range.start) page = range.page;
      }
      return page;
    }
  }

  // ---------------------------------------------------------------- 样式

  const CSS = `
#dyf-root{position:fixed;inset:0;z-index:2147483000;background:#000;display:none;color:#fff;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
#dyf-root.dyf-open{display:block}
#dyf-root *{box-sizing:border-box}

.dyf-scroller{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none;}
.dyf-scroller::-webkit-scrollbar{display:none}

/* 手势全部自己处理：原生吸附会在快速滑动时多跳一屏，与程序化滚动互相抢夺 */
.dyf-slide{position:relative;height:100vh;height:100dvh;overflow:hidden;background:#000;
  touch-action:none;user-select:none;-webkit-user-select:none;}

.dyf-media{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
.dyf-media img,.dyf-media video{max-width:100%;max-height:100%;object-fit:contain;display:block;}
/* 图片平移/缩放由 transform 控制，拖动中不加过渡，松手吸附时再加 */
.dyf-media img.dyf-single-image{will-change:transform;touch-action:none;-webkit-user-drag:none;user-select:none;}
.dyf-media img.dyf-single-image.dyf-anim{transition:transform .22s ease-out;}
.dyf-media video{background:#000;}
/* 视频双指缩放：同样靠 transform，加过渡只在收手时补一帧动画 */
.dyf-media video.dyf-video{will-change:transform;touch-action:none;}
.dyf-media video.dyf-video.dyf-anim{transition:transform .22s ease-out;}

/* 横屏：把媒体层换成“宽=屏高、高=屏宽”再转 90°。
   容器变高后视频 contain 的可用长边变成屏幕高度，旋转后横向视频才能铺满。 */
.dyf-slide.is-landscape .dyf-media{inset:auto;top:50%;left:50%;
  width:100vh;width:100dvh;height:100vw;
  transform:translate(-50%,-50%) rotate(90deg);}
/* 旋转后容器是「屏高 × 屏宽」，16:9 视频 contain 只占屏高 82%，两侧留黑边；
   铺满需要 cover：裁掉少量边缘，与抖音横屏一致 */
.dyf-slide.is-landscape .dyf-media video{width:100%;height:100%;max-width:none;max-height:none;
  object-fit:cover;}
/* 横屏态的退出条：全屏沉浸时只留它 */
.dyf-landscape-bar{position:absolute;top:0;right:0;display:none;padding:14px;}
#dyf-root.dyf-landscape .dyf-landscape-bar{display:flex;}
#dyf-root.dyf-landscape .dyf-counter,#dyf-root.dyf-landscape .dyf-hud,
#dyf-root.dyf-landscape .dyf-actions,#dyf-root.dyf-landscape .dyf-caption,
#dyf-root.dyf-landscape .dyf-progress,#dyf-root.dyf-landscape .dyf-time,
#dyf-root.dyf-landscape .dyf-media-tip{opacity:0;pointer-events:none;}
/* 横滑轮播预览层：挂在 slide 上（在 .dyf-media 之前），object-fit:contain
   铺满容器与主图 contain 后的视觉一致，平移量独立于媒体容器计算 */
.dyf-slide-preview{position:absolute;left:0;top:0;width:100%;height:100%;
  object-fit:contain;max-width:none;max-height:none;pointer-events:none;}

.dyf-loading{position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;
  border-radius:50%;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;
  animation:dyf-spin .8s linear infinite;display:none;z-index:1;pointer-events:none;}
.dyf-loading.dyf-show{display:block}
@keyframes dyf-spin{to{transform:rotate(360deg)}}

.dyf-media-tip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.16);border-radius:12px;
  padding:16px 20px;text-align:center;display:none;z-index:2;backdrop-filter:blur(6px);}
.dyf-media-tip.dyf-show{display:block}
.dyf-tip-text{font-size:13.5px;color:rgba(255,255,255,.85);margin-bottom:10px;}
.dyf-tip-btn{background:#fe2c55;border:0;color:#fff;padding:8px 20px;border-radius:20px;
  font-size:13px;cursor:pointer;}
.dyf-tip-btn:hover{opacity:.88}

.dyf-textbox{max-width:680px;max-height:100%;overflow-y:auto;padding:48px 28px;
  font-size:19px;line-height:1.75;white-space:pre-wrap;word-break:break-word;
  text-align:left;color:#e9e9ea;scrollbar-width:thin;touch-action:pan-y;}

.dyf-caption{position:absolute;left:0;right:0;bottom:0;padding:64px 92px 26px 22px;
  background:linear-gradient(to top,rgba(0,0,0,.6),rgba(0,0,0,.26) 55%,transparent);
  pointer-events:none;}
.dyf-title{font-size:16px;font-weight:600;line-height:1.45;margin-bottom:6px;
  text-shadow:0 1px 3px rgba(0,0,0,.8);
  pointer-events:auto;cursor:pointer;display:inline-block;}
.dyf-title:hover{text-decoration:underline;}
.dyf-meta{display:flex;gap:12px;font-size:12.5px;color:rgba(255,255,255,.72);margin-bottom:8px;}
.dyf-tags{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;}
.dyf-tags span{background:rgba(255,255,255,.13);padding:2px 8px;border-radius:10px;
  color:rgba(255,255,255,.86);}
.dyf-excerpt{font-size:13px;color:rgba(255,255,255,.78);margin-top:8px;max-height:3.2em;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
/* 展开态改为块级滚动容器：-webkit-box 下内部滚动表现不稳定；
   可交互（pointer-events:auto）才能接收滚轮与触摸，超出部分内部翻看 */
.dyf-excerpt.is-expanded{display:block;-webkit-line-clamp:normal;max-height:42vh;
  overflow-y:auto;pointer-events:auto;touch-action:pan-y;scrollbar-width:thin;
  padding-right:4px;}
.dyf-excerpt-toggle{display:inline-block;background:transparent;border:0;padding:3px 0 0;
  color:rgba(255,255,255,.55);font-size:12.5px;cursor:pointer;pointer-events:auto;}
.dyf-excerpt-toggle:hover{color:rgba(255,255,255,.85)}

/* 毛玻璃圆底与反色图标拆成两层，互不干扰：
   ::before 单独承载 backdrop-filter，它自己不需要混合；
   图标与文字用 mix-blend-mode:difference 与「圆底 + 画面」混合，
   白底变黑、深底变白，无需描边，也不采样画面。
   前提：本元素与 .dyf-actions 都不能创建层叠上下文，否则混合看不到画面。 */
.dyf-actions{position:absolute;right:12px;bottom:110px;display:flex;flex-direction:column;
  gap:16px;align-items:center;}
/* 倾斜换边：哪侧低就把整列按钮放到哪侧（设置开启、传感器有数据时） */
#dyf-root.dyf-actions-left .dyf-actions{right:auto;left:12px;}
/* 底部文案的右侧内边距是为右列按钮留的，按钮换到左侧后要镜像，否则文字被盖 */
#dyf-root.dyf-actions-left .dyf-caption{padding:64px 22px 26px 92px;}
.dyf-act{position:relative;background:transparent;border:0;color:#fff;width:46px;height:46px;
  border-radius:50%;cursor:pointer;font-size:11px;line-height:1.1;display:flex;
  flex-direction:column;align-items:center;justify-content:center;gap:2px;
  transition:transform .15s;}
.dyf-act::before{content:'';position:absolute;inset:0;border-radius:50%;
  background:rgba(255,255,255,.12);
  backdrop-filter:blur(6px) saturate(1.1);
  box-shadow:0 1px 5px rgba(0,0,0,.22),inset 0 0 0 1px rgba(255,255,255,.18);}
.dyf-act:hover::before{background:rgba(255,255,255,.24)}
/* 按下不用 transform：会给按钮自身创建层叠上下文，使子元素反色在按压瞬间失效 */
.dyf-act:active::before{background:rgba(255,255,255,.32)}
/* 图标要压在圆底之上：::before 是定位元素，不提升子元素就会被盖住（is-on 深色底尤其明显） */
.dyf-act>svg,.dyf-act>span{position:relative;mix-blend-mode:difference;}
/* 点亮态不参与反色：深色实心底 + 强调色 */
.dyf-act.is-on::before{background:rgba(0,0,0,.6);box-shadow:0 0 0 1px rgba(255,255,255,.18);}
.dyf-act.is-on>svg,.dyf-act.is-on>span{mix-blend-mode:normal;color:#ffd23f;}
.dyf-act.is-local::before{outline:1px dashed rgba(255,255,255,.55);outline-offset:-1px;}
/* 清屏模式：隐藏全部叠加控件只留媒体画面与清屏按钮；隐藏与恢复同速淡入淡出 */
#dyf-root .dyf-counter,#dyf-root .dyf-hud,#dyf-root .dyf-progress,#dyf-root .dyf-time,
#dyf-root .dyf-caption,#dyf-root .dyf-actions .dyf-act,#dyf-root .dyf-actions .dyf-speed-group{transition:opacity .2s,transform .15s;}
#dyf-root.dyf-clean .dyf-counter,#dyf-root.dyf-clean .dyf-hud,#dyf-root.dyf-clean .dyf-progress,
#dyf-root.dyf-clean .dyf-time,#dyf-root.dyf-clean .dyf-caption,
#dyf-root.dyf-clean .dyf-actions .dyf-act:not([data-act="clean"]),
#dyf-root.dyf-clean .dyf-actions .dyf-speed-group{opacity:0;pointer-events:none;}
/* 点亮状态：实心深底 + 强调色，白底也看得清 */
.dyf-act.is-on{color:#ffd23f;background:rgba(0,0,0,.6);
  box-shadow:0 0 0 1px rgba(255,255,255,.18);}
.dyf-act.is-local{border:1px dashed rgba(255,255,255,.55);}

.dyf-heart{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.4);
  font-size:110px;line-height:1;color:#fe2c55;opacity:0;pointer-events:none;z-index:3;
  animation:dyf-heart-pop .8s ease-out forwards;text-shadow:0 4px 24px rgba(254,44,85,.55);}
@keyframes dyf-heart-pop{
  0%{opacity:0;transform:translate(-50%,-50%) scale(.3)}
  25%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}
  55%{opacity:1;transform:translate(-50%,-50%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-60%) scale(1.25)}
}
.dyf-speed-group{position:relative;display:flex;}
.dyf-speed-group .dyf-act{font-size:10px;gap:1px;}
.dyf-speed-group .dyf-act svg{width:17px;height:17px;}
.dyf-speed-label{font-weight:600;letter-spacing:.2px;}
.dyf-speed-menu{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);
  display:none;gap:2px;background:rgba(0,0,0,.66);padding:4px 6px;border-radius:16px;
  backdrop-filter:blur(6px);}
.dyf-speed-group.is-open .dyf-speed-menu{display:flex;}
.dyf-speed-item{background:transparent;border:0;color:rgba(255,255,255,.82);
  font-size:12px;padding:5px 9px;border-radius:12px;cursor:pointer;white-space:nowrap;
  font-family:inherit;}
.dyf-speed-item:hover{background:rgba(255,255,255,.14)}
.dyf-speed-item.is-active{background:#fe2c55;color:#fff;}

.dyf-pause-icon{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:74px;height:74px;border-radius:50%;background:rgba(0,0,0,.46);
  display:none;align-items:center;justify-content:center;z-index:2;
  pointer-events:none;backdrop-filter:blur(2px);}
.dyf-pause-icon.dyf-show{display:flex}
.dyf-pause-icon svg{width:34px;height:34px;fill:#fff;}
.dyf-act svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round;}

/* HUD 与计数器一律不设 z-index：设了会创建独立层叠上下文，
   内部图标的 difference 混合就只与空容器生效，反色失效。
   不设置时靠 DOM 顺序（在 scroller 之后）就能盖在媒体之上。 */
.dyf-hud{position:absolute;top:0;right:0;display:flex;gap:8px;padding:14px;}
/* 圆底与图标分两层：::before 只承载毛玻璃；图标自己用 difference 与「圆底 + 画面」混合，
   白底变黑、深底变白，无需描边。按下不用 transform（会给按钮建层叠上下文）。 */
.dyf-hud-btn{position:relative;background:transparent;border:0;color:#fff;
  border-radius:50%;width:36px;height:36px;padding:0;cursor:pointer;
  display:flex;align-items:center;justify-content:center;}
.dyf-hud-btn::before{content:'';position:absolute;inset:0;border-radius:50%;box-sizing:border-box;
  background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);
  box-shadow:0 1px 6px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.18);
  backdrop-filter:blur(6px) saturate(1.1);}
.dyf-hud-btn:hover::before{background:rgba(255,255,255,.26)}
.dyf-hud-btn:active::before{background:rgba(255,255,255,.34)}
.dyf-hud-btn>svg{position:relative;mix-blend-mode:difference;}
.dyf-hud-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round;}
/* 窄屏折叠：默认只显示展开箭头，点击后展开全部按钮 */
.dyf-hud-toggle{display:none;}
@media (max-width:640px){
  .dyf-hud > .dyf-hud-btn{display:none;}
  .dyf-hud > .dyf-hud-toggle{display:flex;}
  .dyf-hud.is-expanded > .dyf-hud-btn{display:flex;}
  .dyf-hud.is-expanded > .dyf-hud-toggle svg{transform:rotate(180deg);}
}
.dyf-hud-toggle svg{transition:transform .2s;}

.dyf-toast{position:absolute;left:50%;bottom:120px;transform:translateX(-50%);
  background:rgba(0,0,0,.8);color:#fff;padding:9px 18px;border-radius:8px;
  font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:5;
  max-width:70vw;text-align:center;}
.dyf-toast.dyf-show{opacity:1}

/* 从头看 / 回到进度：嵌入左上角计数器胶囊右侧，常驻显示。
   计数器胶囊底色与毛玻璃也挪到 ::before，这样胶囊内的文字与按钮图标
   能继续看到下方画面并做 difference 反色（胶囊自身带 backdrop-filter 会
   形成层叠上下文，内部混合只与胶囊背景算，反色就失去意义）。
   按钮组的圆底保持透明，不叠加第二层色块。 */
.dyf-counter{position:absolute;top:16px;left:18px;font-size:12.5px;
  color:#fff;padding:4px 6px 4px 11px;border-radius:20px;
  display:flex;align-items:center;gap:8px;}
.dyf-counter::before{content:'';position:absolute;inset:0;border-radius:20px;
  background:rgba(255,255,255,.12);
  box-shadow:0 1px 6px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.16);
  backdrop-filter:blur(6px) saturate(1.1);}
.dyf-counter-text,.dyf-jumpbar .dyf-hud-btn>svg{position:relative;mix-blend-mode:difference;}
.dyf-jumpbar{position:relative;display:flex;flex-direction:row;gap:4px;align-items:center;}
.dyf-jumpbar .dyf-hud-btn{width:26px;height:26px;}
.dyf-jumpbar .dyf-hud-btn::before{background:transparent;border:0;backdrop-filter:none;}
.dyf-jumpbar .dyf-hud-btn:hover::before{background:rgba(255,255,255,.18);}
.dyf-jumpbar .dyf-hud-btn>svg{width:14px;height:14px;}

.dyf-progress{position:absolute;left:0;right:0;bottom:0;height:4px;
  background:rgba(255,255,255,.22);z-index:2;cursor:pointer;}
.dyf-progress-fill{height:100%;width:0;background:#fe2c55;transition:width .12s linear;}
.dyf-time{position:absolute;right:14px;bottom:10px;font-size:11.5px;
  color:rgba(255,255,255,.82);z-index:2;pointer-events:none;
  text-shadow:0 1px 2px rgba(0,0,0,.85);font-variant-numeric:tabular-nums;}

.dyf-embed-link{display:inline-block;margin-top:18px;padding:8px 18px;border-radius:18px;
  background:#fe2c55;color:#fff;text-decoration:none;font-size:13px;}
.dyf-embed-link:hover{opacity:.88}

.dyf-help .dyf-panel-box{width:min(520px,90vw);}
.dyf-help-list{display:flex;flex-direction:column;}
.dyf-help-row{display:flex;gap:12px;padding:8px 0;
  border-bottom:1px solid rgba(255,255,255,.06);}
.dyf-help-row:last-child{border-bottom:0}
.dyf-help-key{flex:0 0 92px;color:rgba(255,255,255,.92);font-size:13px;font-weight:500;}
.dyf-help-desc{color:rgba(255,255,255,.7);font-size:12.5px;line-height:1.6;}

.dyf-comments{position:absolute;inset:0;z-index:7;display:none;}
.dyf-comments.dyf-show{display:block}
.dyf-comments-mask{position:absolute;inset:0;background:rgba(0,0,0,.45);}
.dyf-comments-sheet{position:absolute;left:0;right:0;bottom:0;height:60%;
  border-radius:16px 16px 0 0;display:flex;flex-direction:column;
  border-top:1px solid rgba(255,255,255,.1);
  /* 毛玻璃与右侧 HUD 按钮同风格：半透明底 + backdrop blur */
  background:rgba(24,24,27,.55);
  backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);
  transform:translateY(100%);transition:transform .25s ease,height .25s ease;}
.dyf-comments.dyf-show .dyf-comments-sheet{transform:translateY(0)}
.dyf-comments-sheet.is-expanded{height:90%}
.dyf-comments-handle{height:20px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;flex:0 0 auto;touch-action:none;}
.dyf-comments-handle::after{content:'';width:38px;height:4px;border-radius:2px;
  background:rgba(255,255,255,.28);}
.dyf-comments-head{display:flex;align-items:center;justify-content:space-between;
  padding:0 16px 10px;flex:0 0 auto;touch-action:none;}
.dyf-comments-title{font-size:14px;font-weight:600;}
.dyf-comments-close{background:rgba(255,255,255,.1);border:0;color:#fff;
  padding:5px 12px;border-radius:14px;font-size:12.5px;cursor:pointer;}
.dyf-comments-body{flex:1 1 auto;overflow-y:auto;padding:0 16px 20px;
  overscroll-behavior:contain;scrollbar-width:thin;}
.dyf-comment{display:flex;gap:10px;padding:10px 0;
  border-bottom:1px solid rgba(255,255,255,.06);}
.dyf-comment-avatar{width:32px;height:32px;border-radius:50%;flex:0 0 auto;
  object-fit:cover;background:#333;}
.dyf-comment-main{flex:1 1 auto;min-width:0;}
.dyf-comment-meta{display:flex;gap:8px;align-items:baseline;font-size:12px;
  color:rgba(255,255,255,.55);}
.dyf-comment-author{color:rgba(255,255,255,.88);font-weight:500;}
.dyf-comment-text{font-size:13.5px;line-height:1.55;color:rgba(255,255,255,.86);
  margin-top:3px;word-break:break-word;white-space:pre-wrap;}
.dyf-comment-likes{font-size:11.5px;color:rgba(255,255,255,.45);margin-top:4px;}
.dyf-comment-sticker{max-width:120px;max-height:120px;border-radius:6px;margin-top:5px;display:block;}
.dyf-comments-state{padding:44px 0;text-align:center;color:rgba(255,255,255,.6);
  font-size:13px;}
.dyf-comments-state button{margin-top:12px;background:#fe2c55;border:0;color:#fff;
  padding:7px 18px;border-radius:16px;font-size:12.5px;cursor:pointer;display:block;
  margin-left:auto;margin-right:auto;}

.dyf-panel{position:absolute;inset:0;background:rgba(0,0,0,.82);z-index:6;
  display:none;align-items:center;justify-content:center;backdrop-filter:blur(2px);}
.dyf-panel.dyf-show{display:flex}
.dyf-panel-box{background:#18181b;border:1px solid rgba(255,255,255,.12);
  border-radius:12px;padding:22px;width:min(440px,90vw);max-height:80vh;
  overflow-y:auto;font-size:13.5px;}
.dyf-panel-box h3{margin:0 0 16px;font-size:15px;font-weight:600}
.dyf-row{display:flex;align-items:center;justify-content:space-between;
  padding:9px 0;border-bottom:1px solid rgba(255,255,255,.07);}
.dyf-row:last-child{border-bottom:0}
.dyf-row label{color:rgba(255,255,255,.85);cursor:pointer}
.dyf-row input[type=checkbox]{width:16px;height:16px;accent-color:#fe2c55;cursor:pointer}
.dyf-field{margin-top:12px}
.dyf-field span{display:block;margin-bottom:5px;color:rgba(255,255,255,.6);font-size:12px}
.dyf-field input[type=text]{width:100%;background:#0e0e10;border:1px solid rgba(255,255,255,.15);
  color:#fff;border-radius:6px;padding:7px 9px;font-size:13px;outline:none;}
.dyf-field input[type=text]:focus{border-color:#fe2c55}
/* 传感器自检：直接告诉用户卡在哪一层，免得只能猜权限 */
.dyf-hint{font-size:11.5px;line-height:1.5;color:rgba(255,255,255,.5);margin:-2px 0 6px;}
.dyf-hint.is-bad{color:#ff9c9c}
.dyf-hint.is-ok{color:#8fe3a5}
.dyf-panel-actions{display:flex;gap:8px;margin-top:18px;justify-content:flex-end}
.dyf-panel-actions button{background:rgba(255,255,255,.1);border:0;color:#fff;
  padding:8px 15px;border-radius:6px;font-size:13px;cursor:pointer;}
.dyf-panel-actions button.dyf-primary{background:#fe2c55}
.dyf-panel-actions button:hover{opacity:.85}

`;

  function injectStyle() {
    if (document.getElementById('dyf-style')) return;
    const style = document.createElement('style');
    style.id = 'dyf-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function removeStyle() {
    const style = document.getElementById('dyf-style');
    if (style) style.remove();
  }

  // ---------------------------------------------------------------- 浮层

  class Overlay {
    constructor() {
      this.source = new FeedSource();
      this.posts = this.source.posts;
      this.slides = [];
      this.activeIndex = -1;
      this.root = null;
      this.scroller = null;
      this.videos = new Map();   // index -> HTMLVideoElement
      this.videoPool = [];
      this.videoStates = new WeakMap();
      this.accountPending = new Set();
      this.io = null;
      this.opened = false;
      this.savedScrollY = 0;
      this.wheelLocked = false;
      this.wheelTimer = null;
      this.wheelAccum = 0;
      this.wheelIdleTimer = null;
      this.lastLikeFx = 0;
      this.toastTimer = null;
      this.loadingMore = false;
      this.settingsOpen = false;
      // 吸附动画状态：snapTimer 未空表示吸附进行中
      this.snapTimer = null;
      this.snapScrollTo = null;
      // 图片缩放状态：仅图片帖有效
      this.zoomState = null;
      // 横滑回弹定时器：未决时新拖动必须先取消，否则 transition:none 被清
      this.mediaRestoreTimer = null;
      // 轮播预览层当前方向：0 无，1 下一张在右侧，-1 上一张在左侧
      this.slidePreviewDir = 0;
      // 拖动手势进行中标志与基准条目：拖动期间暂停 IO 激活、锁定翻页基准
      this.gestureActive = false;
      this.gestureBase = -1;
      // 跨页进度恢复进行中标志，防止与手动翻页加载并发重复拉取
      this.restoringPages = false;
      // 打开浮层时的初始条目：跨页恢复完成时据此判断用户是否已开始浏览，
      // 已移动则不再强跳，避免浏览到一半被拉回恢复点
      this.openBaselineIndex = 0;
      // 评论区预载计时器：激活条目停留片刻后预取详情缓存
      this.commentPrefetchTimer = null;
      // 当前 (sort, tag) 的阅读位置条目缓存，避免每次翻页都读存储
      this.markEntry = null;
      // 处于横屏态的条目索引，-1 表示不在横屏
      this.landscapeIndex = -1;
      // 倾斜换边：当前操作栏在哪侧、监听函数、上次判定时间（节流用）
      this.actionSide = 'right';
      this.orientationHandler = null;
      this.absoluteHandler = null;
      this.gravitySensor = null;
      this.sensorState = 'off';
      this.lastGamma = null;
      this.sensorHintEl = null;
      this.sensorWaitTimer = null;
      this.sideCheckAt = 0;
      // 已并行预载过的图片地址：窗口回收只清节点，缓存命中靠它去重
      this.warmedImages = new Set();

      this.onKeyDown = this.onKeyDown.bind(this);
      this.onWheel = this.onWheel.bind(this);
      this.onResize = this.onResize.bind(this);
      this.onVisibilityChange = this.onVisibilityChange.bind(this);
      this.onToastHide = null;

      // 缓存解析结果和进行中的 Promise，评论与媒体补全共用一次详情请求。
      this.detailCache = new Map();
      this.commentsOpen = false;
      this.commentsLoading = false;
      this.commentsEl = null;
      this.commentsBodyEl = null;
      this.commentsTitleEl = null;
      this.commentsPostId = null;
      this.helpEl = null;
      this.helpOpen = false;
    }

    // ------------------------------------------------------------ 生命周期

    open() {
      if (this.opened) return;
      injectStyle();

      const added = this.source.addFromDocument();
      if (!this.source.posts.length) {
        removeStyle();
        showBootHint('当前页面没有可刷的内容');
        return false;
      }
      this.posts = this.source.posts;
      void added;

      this.savedScrollY = window.scrollY;
      document.documentElement.classList.add('dyf-locked');
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';

      this.buildShell();
      this.renderAll();

      document.addEventListener('keydown', this.onKeyDown, true);
      this.scroller.addEventListener('wheel', this.onWheel, { passive: false });
      window.addEventListener('resize', this.onResize);
      document.addEventListener('visibilitychange', this.onVisibilityChange);

      this.opened = true;
      this.root.classList.add('dyf-open');
      this.root.setAttribute('aria-hidden', 'false');
      const launcher = document.getElementById('dyf-launcher');
      if (launcher) launcher.style.display = 'none';

      store.set('lastMode', 'dy');

      // 待跨页恢复的目标必须先取：下面 setActive 会写入新位置，
      // 取晚了读到的就是当前条目，永远匹配不到目标
      this.markEntry = null;
      const restoreSlot = this.pendingRestoreSlot();
      // 先让浮层可见再定位：display:none 时 offsetTop 恒为 0，滚动会失效
      this.restoreProgress();
      this.openBaselineIndex = this.activeIndex;
      // 传 false 强制走完整激活流程：恢复的索引可能与当前值相同，
      // 若按「滚动触发」路径提前返回，首屏媒体与计数器都不会初始化
      this.setActive(this.activeIndex < 0 ? 0 : this.activeIndex, false);
      const activeSlide = this.slides[this.activeIndex];
      if (activeSlide) this.scroller.scrollTop = activeSlide.offsetTop;
      this.maybeLoadMore();
      // 上次位置不在本地首屏：从第 1 页进入才值得逐页拉（用户从头刷）；
      // 用户已经手动翻到后面某一页再进入，强行拉回旧位置的代价是���十次请求，
      // 行为也不符合他的意图，这里只提示不加载。
      if (restoreSlot && this.source.hasMore) {
        if (this.source.page > 1) {
          // 延后一点：开屏 500ms 后有“点击画面开启声音”的提示，同时弹会被它盖掉
          const page = this.source.page;
          setTimeout(() => this.toast('当前第 ' + page + ' 页，未自动恢复上次位置'), 1300);
        } else {
          void this.restoreAcrossPages(restoreSlot);
        }
      }
      // 默认静音是自动播放的前提，用户需要知道怎样开启声音
      if (settings.muted) setTimeout(() => this.toast('点击画面开启声音'), 500);
      // 倾斜换边：设置开启时挂监听（权限已在设置里拿过，拿不到则保持右侧）
      if (settings.gravitySide) void this.enableGravitySide(false);
      return true;
    }

    close() {
      if (!this.opened) return;
      this.opened = false;
      // 退出前记下当前条目，用于在原页面定位
      const activePost = this.posts[this.activeIndex] || null;
      // 面板停留、进度条拖动不走 setActive，退出时补记一次位置
      this.saveProgress();

      document.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('resize', this.onResize);
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      if (this.scroller) this.scroller.removeEventListener('wheel', this.onWheel);
      if (this.io) { this.io.disconnect(); this.io = null; }

      for (const [index] of this.videos) this.releaseVideo(index);
      for (const video of this.videoPool) {
        video.pause();
        video.removeAttribute('src');
        try { video.load(); } catch (e) { /* 忽略 */ }
      }
      this.videoPool.length = 0;
      // 跳转按钮随浮层销毁，评论预载计时器一并清掉
      clearTimeout(this.commentPrefetchTimer);

      if (this.root) this.root.remove();
      this.root = null;
      this.scroller = null;
      this.slides = [];
      this.commentsOpen = false;
      this.commentsPostId = null;
      this.commentsEl = null;
      this.commentsBodyEl = null;
      this.commentsTitleEl = null;
      this.commentsSheetEl = null;
      this.helpOpen = false;
      // 清屏为会话内状态，退出浮层即复位，下次进入从完整控件开始
      this.cleanScreenOn = false;
      this.helpEl = null;
      // 操作栏节点随 root 一起销毁，旧引用必须清掉，否则重开后会操作已移除的节点
      this.actEls = null;
      this.actionsEl = null;
      // 横屏态随实例销毁复位
      this.landscapeIndex = -1;
      this.landscapeBarEl = null;
      // 倾斜换边：监听必须摘，否则下一个实例会收到两份事件
      this.stopOrientationWatch();
      this.actionSide = 'right';
      this.sensorHintEl = null;

      removeStyle();
      document.documentElement.classList.remove('dyf-locked');
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      // 定位到当前浏览的条目；属于后续分页时跳列表对应页，不在本页才回退滚动位置
      if (activePost) {
        const card = document.querySelector('.post-card[data-id="' + activePost.id + '"]');
        if (card) this.focusOriginalPost(activePost);
        else this.exitToListPage(activePost);
      } else window.scrollTo(0, this.savedScrollY);

      const launcher = document.getElementById('dyf-launcher');
      // 启动按钮的样式全部内联，清空 display 会把 flex 一并抹掉，必须显式还原
      if (launcher) launcher.style.display = 'flex';

      store.set('lastMode', 'original');
    }

    /** 退出后把原页面对齐到刚看的条目（条目在本页 DOM 中） */
    focusOriginalPost(post) {
      const card = document.querySelector('.post-card[data-id="' + post.id + '"]');
      if (card) highlightCard(card);
    }

    /**
     * 当前条目属于后续分页时，退出直接跳列表对应分页而不是原帖详情页：
     * 页码由 pageRanges 反查，落地后由 boot 里的 exitTarget 恢复滚动与高亮。
     */
    exitToListPage(post) {
      const page = this.source.pageOf(this.activeIndex);
      store.set('exitTarget', { postId: post.id, at: Date.now() });
      location.href = location.pathname + '?sort=' + encodeURIComponent(this.source.sort) +
        '&tag=' + encodeURIComponent(this.source.tag) + '&page=' + page;
    }

    /**
     * 回到最新：清掉当前分类的阅读位置后重载列表第 1 页。位置不清的话
     * 刷新后会被跨页恢复直接拉回旧位置，与「从头看」的意图相反。
     */
    goToLatest() {
      writeMarks(this.source.sort, this.source.tag, null);
      this.markEntry = {};
      location.href = location.pathname + '?sort=' + encodeURIComponent(this.source.sort) +
        '&tag=' + encodeURIComponent(this.source.tag);
    }

    /** 最靠后的阅读进度在本地列表中的索引；没有记录或不在本地返回 -1 */
    farthestIndex() {
      const far = this.marks().farthest;
      if (!far || !far.postId) return -1;
      return this.posts.findIndex(post => post.id === far.postId);
    }

    /**
     * 从头看 / 回到进度的常驻显隐（嵌在左上角计数器右侧，无淡出机制）：
     * - 从头看：不在第 1 条时可用；
     * - 回到进度：有记录且与当前条目不同才显示，否则点了也不动。
     */
    updateJumpbar() {
      if (!this.jumpBarEl) return;
      const far = this.farthestIndex();
      this.jumpBarButtons.restart.style.display = this.activeIndex > 0 ? '' : 'none';
      this.jumpBarButtons.progress.style.display = far >= 0 && far !== this.activeIndex ? '' : 'none';
    }

    buildShell() {
      const root = el('div');
      root.id = 'dyf-root';

      const scroller = el('div', 'dyf-scroller');
      root.appendChild(scroller);

      // 计数器为 flex 胶囊：文本节点 + 从头看/继续看按钮组（updateCounter 只写文本，
      // 直接用 textContent 会清掉按钮节点，故拆出 span）
      const counter = el('div', 'dyf-counter');
      const counterText = el('span', 'dyf-counter-text');
      counter.appendChild(counterText);
      root.appendChild(counter);

      const hud = el('div', 'dyf-hud');

      // 声音与设置放在同一组，均为纯图标
      const volume = el('button', 'dyf-hud-btn');
      volume.dataset.act = 'volume';
      volume.title = settings.muted ? '取消静音' : '静音';
      volume.setAttribute('aria-label', '声音');
      volume.innerHTML = settings.muted ? iconVolumeOff() : iconVolumeOn();
      volume.addEventListener('click', () => this.toggleMute());

      const help = el('button', 'dyf-hud-btn');
      help.innerHTML = iconHelp();
      help.title = '帮助';
      help.setAttribute('aria-label', '帮助');
      help.addEventListener('click', () => this.toggleHelp(true));

      const gear = el('button', 'dyf-hud-btn');
      gear.innerHTML = iconGear();
      gear.title = '设置';
      gear.setAttribute('aria-label', '设置');
      gear.addEventListener('click', () => this.togglePanel(true));

      const exit = el('button', 'dyf-hud-btn');
      exit.innerHTML = iconExit();
      exit.title = '退出';
      exit.setAttribute('aria-label', '退出');
      exit.addEventListener('click', () => this.close());

      // 窄屏折叠入口：平时只显示这个箭头，点击展开其余按钮
      const toggle = el('button', 'dyf-hud-btn dyf-hud-toggle');
      toggle.innerHTML = iconChevron();
      toggle.title = '展开菜单';
      toggle.setAttribute('aria-label', '展开菜单');
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        hud.classList.toggle('is-expanded');
      });

      hud.appendChild(volume);
      hud.appendChild(help);
      hud.appendChild(gear);
      hud.appendChild(exit);
      hud.appendChild(toggle);
      root.appendChild(hud);

      // 点击别处收起倍速菜单
      root.addEventListener('click', () => {
        root.querySelectorAll('.dyf-speed-group.is-open')
          .forEach(group => group.classList.remove('is-open'));
      });

      const panel = this.buildPanel();
      root.appendChild(panel);

      const helpPanel = this.buildHelpPanel();
      root.appendChild(helpPanel);
      this.helpEl = helpPanel;

      const toast = el('div', 'dyf-toast');
      root.appendChild(toast);

      // 从头看 / 回到进度：常驻嵌在计数器右侧，按浏览状态条件显隐（无淡出机制）。
      // 按钮透明融入计数器底色，hover 圆形高亮；图标语义为回到顶部 / 跳向底部
      const jumpbar = el('div', 'dyf-jumpbar');
      const restartBtn = el('button', 'dyf-hud-btn');
      restartBtn.innerHTML = iconJumpToTop();
      restartBtn.title = '从头看（回第 1 页看最新）';
      restartBtn.setAttribute('aria-label', '从头看');
      restartBtn.addEventListener('click', event => {
        event.stopPropagation();
        this.goToLatest();
      });
      const progressBtn = el('button', 'dyf-hud-btn');
      progressBtn.innerHTML = iconJumpToBottom();
      progressBtn.title = '回到上次看到的进度';
      progressBtn.setAttribute('aria-label', '回到进度');
      progressBtn.addEventListener('click', event => {
        event.stopPropagation();
        const far = this.farthestIndex();
        if (far >= 0) this.jumpTo(far);
      });
      jumpbar.appendChild(restartBtn);
      jumpbar.appendChild(progressBtn);
      counter.appendChild(jumpbar);

      const comments = this.buildCommentPanel();
      root.appendChild(comments.wrap);

      // 右侧操作栏固定在视口：挂在 root 而不是 slide 上，跟内容滚动的旧行为已取消
      this.actionsEl = this.buildActions();
      root.appendChild(this.actionsEl);

      // 横屏态只有这一排：全屏沉浸时控件全隐，留一个退出入口
      const landscapeBar = el('div', 'dyf-landscape-bar');
      const landscapeExit = el('button', 'dyf-hud-btn');
      landscapeExit.dataset.act = 'landscape-exit';
      landscapeExit.title = '退出横屏';
      landscapeExit.setAttribute('aria-label', '退出横屏');
      landscapeExit.innerHTML = iconLandscapeExit();
      landscapeExit.addEventListener('click', event => {
        event.stopPropagation();
        this.setLandscape(false);
      });
      landscapeBar.appendChild(landscapeExit);
      root.appendChild(landscapeBar);

      // 浮层挂在 documentElement 上：body 若有 transform/filter 会破坏 fixed 定位，
      // 部分移动端模板确实会加这类样式
      document.documentElement.appendChild(root);

      this.root = root;
      this.scroller = scroller;
      this.counterEl = counter;
      this.counterTextEl = counterText;
      this.panelEl = panel;
      this.toastEl = toast;
      this.jumpBarEl = jumpbar;
      this.jumpBarButtons = { restart: restartBtn, progress: progressBtn };
      this.commentsEl = comments.wrap;
      this.commentsBodyEl = comments.body;
      this.commentsTitleEl = comments.title;
      this.commentsSheetEl = comments.sheet;
      this.landscapeBarEl = landscapeBar;

      // 触摸滚动由原生 scroll-snap 处理，这里只同步当前项
      this.io = new IntersectionObserver(entries => {
        // 拖动中的中间态（滑过一半）不能提前激活目标条目，会打乱吸附基准
        if (this.gestureActive) return;
        let best = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number(entry.target.dataset.index);
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            best = index;
          }
        }
        if (best >= 0 && bestRatio >= 0.55 && best !== this.activeIndex) {
          this.setActive(best, true);
        }
      }, { root: scroller, threshold: [0.55, 0.75, 0.95] });
    }

    onResize() {
      if (!this.opened || this.activeIndex < 0) return;
      const slide = this.slides[this.activeIndex];
      if (slide) this.scroller.scrollTop = slide.offsetTop;
    }

    // ------------------------------------------------------------ 渲染

    renderAll() {
      for (let i = 0; i < this.posts.length; i++) this.appendSlide(i, false);
      this.updateCounter();
    }

    appendSlide(index, scrollIntoView) {
      const post = this.posts[index];
      if (!post) return null;
      if (this.slides[index]) return this.slides[index];

      const slide = el('section', 'dyf-slide');
      slide.dataset.index = String(index);
      slide.dataset.postId = post.id;
      // 手势只在 slide 上绑定一次，内部按 data-index 取当前条目；
      // 回收重建时不会重复挂监听
      this.bindMediaGestures(slide);
      this.fillSlide(slide, index);

      this.scroller.appendChild(slide);
      this.slides[index] = slide;
      this.io.observe(slide);

      if (scrollIntoView) slide.scrollIntoView();
      return slide;
    }

    /** 构建或重建 slide 的可见内容，回收后重新进入窗口时复用 */
    fillSlide(slide, index) {
      const post = this.posts[index];
      if (!post) return;
      slide.textContent = '';
      slide.dataset.mediaReady = '0';
      slide.dataset.unloaded = '0';
      slide.dataset.mediaIndex = '0';

      slide.appendChild(el('div', 'dyf-media'));

      const caption = el('div', 'dyf-caption');
      if (post.title) {
        // 标题即可点击跳转原帖，替代原「原帖」按钮
        const title = el('div', 'dyf-title', post.title);
        title.title = '打开原帖';
        title.addEventListener('click', event => {
          event.stopPropagation();
          window.open(post.url, '_blank', 'noopener');
        });
        caption.appendChild(title);
      }

      const meta = el('div', 'dyf-meta');
      if (post.author) meta.appendChild(el('span', '', post.author));
      if (post.time) meta.appendChild(el('span', '', post.time));
      if (post.comments) meta.appendChild(el('span', '', post.comments + ' 评论'));
      caption.appendChild(meta);

      if (post.tags.length) {
        const tags = el('div', 'dyf-tags');
        for (const tag of post.tags.slice(0, 6)) tags.appendChild(el('span', '', tag));
        caption.appendChild(tags);
      }

      if (post.excerpt && post.type !== 'text') {
        const excerpt = el('div', 'dyf-excerpt', post.excerpt);
        caption.appendChild(excerpt);
        this.setupExcerptToggle(caption, excerpt);
      }

      slide.appendChild(caption);
      if (this.currentMediaItem(index)?.type === 'video') this.buildProgress(slide);
      // 媒体位置不再用独立角标显示，统一合并进左上角内容计数器（updateCounter）
    }

    /**
     * 摘要超过两行时提供展开/收起入口。溢出检测必须在节点插入 DOM 后进行：
     * 未插入时 clientHeight/scrollHeight 均为 0；rAF 回调晚于 appendSlide
     * 的同步插入，此时读取的是真实布局。
     */
    setupExcerptToggle(caption, excerpt) {
      const toggle = el('button', 'dyf-excerpt-toggle', '展开');
      toggle.style.display = 'none';
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        const expanded = excerpt.classList.toggle('is-expanded');
        toggle.textContent = expanded ? '收起' : '展开';
      });
      caption.appendChild(toggle);
      requestAnimationFrame(() => {
        // +1 容差：亚像素舍入可能让恰好两行的内容也报出溢出
        if (excerpt.scrollHeight > excerpt.clientHeight + 1) toggle.style.display = '';
      });
    }

    /** 保留图片并在其后追加视频；每项携带类型，切换后按当前媒体处理交互。 */
    mediaList(post) {
      if (!post) return [];
      return [
        ...(post.images || []).map((src, index) => ({ type: 'image', src, gif: !!post.imageGif?.[index] })),
        ...(post.videos || []).map(video => ({ ...video, type: 'video' }))
      ];
    }

    /** 当前媒体决定播放、图片缩放与保存，混合帖不能仅凭帖子类型判断。 */
    currentMediaItem(index) {
      const list = this.mediaList(this.posts[index]);
      const slide = this.slides[index];
      return list[slide ? this.currentMediaIndex(slide) : 0] || null;
    }

    currentMediaIndex(slide) {
      const value = Number(slide.dataset.mediaIndex || '0');
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    /** 切换当前帖子内的媒体（图片或视频），不跨帖子 */
    stepMedia(delta) {
      const index = this.activeIndex;
      const post = this.posts[index];
      const slide = this.slides[index];
      if (!post || !slide) return false;

      const list = this.mediaList(post);
      if (list.length < 2) return false;

      const current = this.currentMediaIndex(slide);
      const next = Math.max(0, Math.min(list.length - 1, current + delta));
      if (next === current) return false;

      this.resetZoom(index);
      slide.dataset.mediaIndex = String(next);
      const item = list[next];
      const previousItem = list[current];
      if (previousItem.type !== item.type) {
        this.releaseVideo(index);
        this.fillSlideMedia(slide);
        this.ensureMedia(index);
        this.syncVideos();
      } else if (item.type === 'video') {
        const video = this.videos.get(index);
        if (video && item) {
          this.configureVideo(index, video);
        }
      } else {
        this.applyImage(index);
      }

      this.playCurrent();
      this.updateCounter();
      return true;
    }

    /**
     * 应用当前索引的图片：先预载目标图，加载完成才替换 src。
     * 直接改 src 会在网络慢时长时间停留在旧图上，与角标计数不一致；
     * 等待期间显示加载指示器，给用户明确反馈。
     */
    applyImage(index) {
      const post = this.posts[index];
      const slide = this.slides[index];
      if (!post || !slide) return;
      const img = slide.querySelector('.dyf-single-image');
      const item = this.currentMediaItem(index);
      const src = item && item.type === 'image' ? item.src : '';
      if (!img || !src) return;
      if (img.getAttribute('src') === src) return;
      this.resetZoom(index);
      img.style.transform = '';
      this.setImageLoading(slide, true);
      const probe = new Image();
      probe.referrerPolicy = 'no-referrer';
      probe.onload = () => {
        // 用户可能已切到下一张，只允许最新请求落地
        if (this.posts[index] !== post) return;
        if (!this.opened || !img.isConnected || this.currentMediaItem(index)?.src !== src) return;
        img.src = src;
        this.setImageLoading(slide, false);
        this.clearMediaTip(slide);
        this.updateCounter();
      };
      probe.onerror = () => {
        if (this.posts[index] !== post) return;
        if (!this.opened || !img.isConnected || this.currentMediaItem(index)?.src !== src) return;
        this.setImageLoading(slide, false);
        // 不能只留黑屏：地址失效或 CDN 异常时给出重试入口
        this.showMediaTip(slide, '图片加载失败', '重试', () => {
          this.clearMediaTip(slide);
          img.removeAttribute('src');
          this.applyImage(index);
        });
      };
      probe.src = src;
    }

    setImageLoading(slide, on) {
      if (!slide) return;
      const media = slide.querySelector('.dyf-media');
      if (!media) return;
      let spinner = media.querySelector('.dyf-loading');
      if (!spinner) {
        spinner = el('div', 'dyf-loading');
        media.appendChild(spinner);
      }
      spinner.classList.toggle('dyf-show', on);
    }

    /**
     * 图集帖激活时并行预载全部图片：翻到下一张时直接命中浏览器缓存，
     * 不再出现逐张临时加载的等待。按 src 去重，同一图集只发一轮请求；
     * 窗口回收只清理节点不清这个集合，翻回去仍能命中缓存。
     */
    preloadPostImages(post) {
      if (!post || !post.images.length) return;
      const images = post.images || [];
      if (images.length < 2) return;
      if (!this.warmedImages) this.warmedImages = new Set();
      for (const src of images) {
        if (this.warmedImages.has(src)) continue;
        this.warmedImages.add(src);
        const probe = new Image();
        probe.referrerPolicy = 'no-referrer';
        probe.src = src;
      }
    }

    /**
     * 刷新横屏入口显隐：只对「单个视频 + 横向比例」的当前条目出现。
     * videoWidth/videoHeight 要等 metadata，所以 loadedmetadata 里也会再调一次。
     */
    syncLandscapeBtn() {
      const els = this.actEls;
      const post = this.posts[this.activeIndex];
      if (!els || !els.landscape || !post) return;
      const video = this.videos.get(this.activeIndex);
      const w = video ? video.videoWidth : 0;
      const h = video ? video.videoHeight : 0;
      const single = this.mediaList(post).length === 1;
      // 1.1 容差：近方形的视频不当作横屏，避免按钮在边界上闪
      const wide = w > 0 && h > 0 && w > h * 1.1;
      els.landscape.style.display = (video && single && wide) ? '' : 'none';
    }

    /**
     * 进出横屏。横屏时媒体层旋转 90° 并换成「宽=屏高、高=屏宽」，
     * 横向视频的 contain 长边因此变成屏幕高度，转过来才能铺满。
     */
    setLandscape(on, index) {
      if (!this.root) return;
      const at = typeof index === 'number' ? index : this.activeIndex;
      if (on && at !== this.activeIndex) return;
      if (on && this.currentMediaItem(at)?.type !== 'video') return;
      // 旋转后旧位移基准失效，进出都先复位缩放
      this.resetZoom(this.activeIndex);
      this.finishSnap();

      for (const slide of this.slides) {
        if (slide) slide.classList.remove('is-landscape');
      }
      this.root.classList.toggle('dyf-landscape', !!on);
      this.landscapeIndex = on ? at : -1;
      const slide = on ? this.slides[at] : null;
      if (slide) {
        slide.classList.add('is-landscape');
        this.scroller.scrollTop = slide.offsetTop;
      }
      // 横屏时入口按钮跟随操作栏一起隐藏，退出靠顶部退出条或 Esc
      this.syncLandscapeBtn();
    }

    /** 底部进度条：显示已播时长与总时长，点击可跳转 */
    buildProgress(slide) {
      const bar = el('div', 'dyf-progress');
      bar.appendChild(el('div', 'dyf-progress-fill'));
      bar.addEventListener('click', event => {
        event.stopPropagation();
        const video = this.videos.get(Number(slide.dataset.index));
        if (!video || !isFinite(video.duration) || video.duration <= 0) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        video.currentTime = ratio * video.duration;
        this.updateProgress(video);
      });
      slide.appendChild(bar);
      slide.appendChild(el('div', 'dyf-time', ''));
    }

    updateProgress(video) {
      const slide = video.closest('.dyf-slide');
      if (!slide) return;
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) return;
      const fill = slide.querySelector('.dyf-progress-fill');
      const time = slide.querySelector('.dyf-time');
      if (fill) fill.style.width = Math.min(100, (video.currentTime / duration) * 100) + '%';
      if (time) time.textContent = formatTime(video.currentTime) + ' / ' + formatTime(duration);
    }

    /**
     * 远离当前条目的 slide 只保留空壳。
     * 高度由 CSS 固定，清空内容不影响滚动位置；这样 DOM 节点数不随浏览条数增长。
     */
    unloadSlide(index) {
      const slide = this.slides[index];
      if (!slide || slide.dataset.unloaded === '1') return;
      this.releaseVideo(index);
      slide.textContent = '';
      slide.dataset.mediaReady = '0';
      slide.dataset.unloaded = '1';
    }

    ensureLoaded(index) {
      const slide = this.slides[index];
      if (!slide) return;
      if (slide.dataset.unloaded === '1') this.fillSlide(slide, index);
    }

    /** 维护幻灯片窗口：近处加载媒体，远处清空内容，中间带留作悬停缓冲 */
    refreshWindow() {
      const active = this.activeIndex;
      for (let k = 0; k < this.posts.length; k++) {
        const slide = this.slides[k];
        if (!slide) continue;
        const distance = Math.abs(k - active);
        if (distance > 14) {
          this.unloadSlide(k);
        } else if (distance <= 7) {
          this.ensureLoaded(k);
          if (distance > 3) this.dropMedia(k);
        }
      }
    }

    /**
     * 右侧操作栏：只建一份，挂在浮层根节点上固定在视口右侧。
     * 早期实现每条 slide 各建一份，翻页与拖动时整列按钮会跟着内容上下滑走。
     * 按钮内容（点赞数、收藏态、评论数）由 syncActions 在切换条目时刷新。
     */
    buildActions() {
      const actions = el('div', 'dyf-actions');

      const like = el('button', 'dyf-act');
      like.dataset.act = 'like';
      like.innerHTML = iconHeart() + '<span></span>';
      like.addEventListener('click', () => this.onLike(this.activeIndex, like));
      actions.appendChild(like);

      const fav = el('button', 'dyf-act');
      fav.dataset.act = 'fav';
      fav.innerHTML = iconStar() + '<span>收藏</span>';
      fav.addEventListener('click', () => this.onFav(this.activeIndex, fav));
      actions.appendChild(fav);

      const commentBtn = el('button', 'dyf-act');
      commentBtn.dataset.act = 'comment';
      commentBtn.innerHTML = iconComment() + '<span>0</span>';
      commentBtn.addEventListener('click', () => this.openComments(this.posts[this.activeIndex]));
      actions.appendChild(commentBtn);

      const saveBtn = el('button', 'dyf-act');
      saveBtn.dataset.act = 'save';
      saveBtn.innerHTML = iconDownload() + '<span>保存</span>';
      saveBtn.addEventListener('click', () => this.saveCurrent(this.activeIndex));
      actions.appendChild(saveBtn);

      const nextBtn = el('button', 'dyf-act');
      nextBtn.dataset.act = 'autonext';
      nextBtn.innerHTML = iconNext() + '<span>连播</span>';
      nextBtn.addEventListener('click', () => this.toggleAutoNext());
      actions.appendChild(nextBtn);

      actions.appendChild(this.buildSpeedGroup());

      // 横屏入口：排在清屏上方，紧贴底部区域；只在「单个视频 + 横向比例」时
      // 由 syncLandscapeBtn 打开。放在这个位置后，横屏视频比竖屏视频多一格，
      // 底部锚定会把上方按钮整体顶高一格。
      const landscapeBtn = el('button', 'dyf-act');
      landscapeBtn.dataset.act = 'landscape';
      landscapeBtn.type = 'button';
      landscapeBtn.title = '横屏观看';
      landscapeBtn.setAttribute('aria-label', '横屏观看');
      landscapeBtn.innerHTML = iconLandscape() + '<span>横屏</span>';
      landscapeBtn.style.display = 'none';
      landscapeBtn.addEventListener('click', () => this.setLandscape(true, this.activeIndex));
      actions.appendChild(landscapeBtn);

      // 清屏：抖音式一键隐藏全部控件，再点还原
      const cleanBtn = el('button', 'dyf-act');
      cleanBtn.dataset.act = 'clean';
      cleanBtn.innerHTML = iconClean() + '<span>清屏</span>';
      cleanBtn.title = '清屏：只看内容，再点还原';
      cleanBtn.addEventListener('click', () => this.toggleCleanScreen(cleanBtn));
      actions.appendChild(cleanBtn);

      this.actEls = { like, fav, comment: commentBtn, save: saveBtn, autonext: nextBtn,
        landscape: landscapeBtn, clean: cleanBtn };
      return actions;
    }

    /** 按当前条目刷新操作栏：点赞数与状态、收藏态、评论数、连播文案 */
    syncActions() {
      const els = this.actEls;
      const post = this.posts[this.activeIndex];
      if (!els || !post) return;

      // 原页面卡片上已有站点的点赞状态与计数，优先用真实值
      const pageLikeBtn = document.querySelector(
        '.post-card[data-id="' + post.id + '"] .vote-btn.upvote');
      if (pageLikeBtn && pageLikeBtn.classList.contains('voted')) likedIds.add(post.id);
      const pageCount = pageLikeBtn && pageLikeBtn.querySelector('.vote-count')
        ? pageLikeBtn.querySelector('.vote-count').textContent.trim() : '';
      const count = els.like.querySelector('span');
      if (count) count.textContent = pageCount || post.likes || '';

      const loggedIn = isLoggedIn();
      els.like.classList.toggle('is-on', likedIds.has(post.id));
      els.like.classList.toggle('is-local', !loggedIn);
      els.like.title = loggedIn ? '点赞' : '未登录，仅本地记录';

      els.fav.classList.toggle('is-on', favIds.has(post.id));
      els.fav.classList.toggle('is-local', !loggedIn);
      els.fav.title = loggedIn ? '收藏' : '未登录，仅本地记录';

      const commentCount = els.comment.querySelector('span');
      if (commentCount) commentCount.textContent = String(post.comments || 0);

      els.autonext.classList.toggle('is-on', !!settings.autoNext);
      const nextLabel = els.autonext.querySelector('span');
      if (nextLabel) nextLabel.textContent = settings.autoNext ? '连播' : '单条';

      this.syncLandscapeBtn();
    }

    // ------------------------------------------------------------ 倾斜换边

    /**
     * 开关倾斜换边。
     * 真正能分辨左右高差的是设备姿态（横滚角），不是 GPS 海拔：
     * 浏览器拿到的 `coords.altitude` 精度到十米级，左右两端几厘米的高差测不出来。
     * 默认关闭；开时才申请传感器权限，拒绝则回滚开关并保持右侧。
     */
    async toggleGravitySide(value, checkbox) {
      if (!value) {
        settings.gravitySide = false;
        store.set('settings', settings);
        this.stopOrientationWatch();
        this.applyActionSide('right');
        return;
      }
      const granted = await this.requestOrientationPermission();
      if (!granted) {
        // 拿不到权限就回滚，否则下次进入会静默失败且用户以为已开启
        settings.gravitySide = false;
        store.set('settings', settings);
        if (checkbox) checkbox.checked = false;
        this.stopOrientationWatch();
        this.applyActionSide('right');
        return;
      }
      settings.gravitySide = true;
      store.set('settings', settings);
      this.startOrientationWatch();
      this.toast('倾斜换边已开启：哪侧低就把按钮放哪侧');
    }

    /** iOS 13+ 必须在用户手势里请求；拿不到权限时返回 false */
    async requestOrientationPermission() {
      const DOE = window.DeviceOrientationEvent;
      if (typeof DOE !== 'function') {
        this.toast('此浏览器不支持设备方向传感器');
        return false;
      }
      if (typeof DOE.requestPermission !== 'function') return true;
      try {
        const state = await DOE.requestPermission();
        if (state === 'granted') return true;
        this.toast('未获得传感器权限，仍保持右侧');
        return false;
      } catch (e) {
        this.toast('传感器权限请求失败，仍保持右侧');
        return false;
      }
    }

    /** 进入浮层时恢复（silent）：权限失败不弹提示，保持右侧 */
    async enableGravitySide(silent) {
      const granted = silent === false
        ? await this.requestOrientationPermission()
        : true;
      if (!granted) {
        this.applyActionSide('right');
        return;
      }
      this.startOrientationWatch();
    }

    /**
     * 挂传感器监听。
     * 两条路并行：DeviceOrientationEvent（Android/iOS 通用）与 GravitySensor（Chromium 独有，
     * 某些设备上方向事件为 null 而重力传感器仍有数据），谁先给数据用谁。
     * 3 秒内一条数据都没有就进入“无数据”状态，面板上直接告知用户。
     */
    startOrientationWatch() {
      if (this.orientationHandler || this.gravitySensor) return;
      this.sensorState = 'waiting';
      this.lastGamma = null;
      if (typeof window.DeviceOrientationEvent === 'function') {
        this.orientationHandler = event => this.handleOrientation(event);
        window.addEventListener('deviceorientation', this.orientationHandler, true);
        // 部分 Chromium 只发绝对方向事件
        this.absoluteHandler = event => this.handleOrientation(event);
        window.addEventListener('deviceorientationabsolute', this.absoluteHandler, true);
      }
      this.startGravitySensor();
      clearTimeout(this.sensorWaitTimer);
      this.sensorWaitTimer = setTimeout(() => {
        this.sensorWaitTimer = null;
        if (this.sensorState !== 'active') {
          this.sensorState = 'nodata';
          this.updateSensorHint();
        }
      }, 3000);
      this.updateSensorHint();
    }

    /** GravitySensor 兜底：用重力在设备 x 轴的分量换算横滚角 */
    startGravitySensor() {
      if (typeof window.GravitySensor !== 'function') return;
      try {
        const sensor = new window.GravitySensor({ frequency: 10 });
        sensor.addEventListener('reading', () => {
          const z = Math.abs(sensor.z) || 9.8;
          this.handleTilt(Math.atan2(sensor.x, z) * 180 / Math.PI);
        });
        sensor.start();
        this.gravitySensor = sensor;
      } catch (e) {
        this.gravitySensor = null;
      }
    }

    stopOrientationWatch() {
      if (this.orientationHandler) {
        window.removeEventListener('deviceorientation', this.orientationHandler, true);
        this.orientationHandler = null;
      }
      if (this.absoluteHandler) {
        window.removeEventListener('deviceorientationabsolute', this.absoluteHandler, true);
        this.absoluteHandler = null;
      }
      if (this.gravitySensor) {
        try { this.gravitySensor.stop(); } catch (e) { /* 忽略 */ }
        this.gravitySensor = null;
      }
      clearTimeout(this.sensorWaitTimer);
      this.sensorWaitTimer = null;
      this.sensorState = 'off';
      this.updateSensorHint();
    }

    /** 把事件转成倾斜角；无数据的事件（gamma 为 null）不当数据 */
    handleOrientation(event) {
      if (typeof event.gamma === 'number' && isFinite(event.gamma)) this.handleTilt(event.gamma);
    }

    /**
     * gamma（或重力换算的横滚角）为正 = 右侧下沉，为负 = 左侧下沉。
     * 接近平放（小于 8°）与横屏一律回退右侧。
     */
    handleTilt(gamma) {
      if (!settings.gravitySide || !this.opened) return;
      this.lastGamma = gamma;
      if (this.sensorState !== 'active') {
        this.sensorState = 'active';
        clearTimeout(this.sensorWaitTimer);
        this.sensorWaitTimer = null;
        this.updateSensorHint();
      }
      if (window.innerWidth > window.innerHeight) {
        this.applyActionSide('right');
        return;
      }
      const now = Date.now();
      if (now - this.sideCheckAt < 200) return;
      this.sideCheckAt = now;
      if (Math.abs(gamma) < 8) this.applyActionSide('right');
      else this.applyActionSide(gamma > 0 ? 'right' : 'left');
      this.updateSensorHint();
    }

    /** 传感器状态文案：直接把卡在哪一层写出来 */
    updateSensorHint() {
      const hint = this.sensorHintEl;
      if (!hint) return;
      const hasApi = typeof window.DeviceOrientationEvent === 'function' ||
        typeof window.GravitySensor === 'function';
      const needsPermission = typeof window.DeviceOrientationEvent === 'function' &&
        typeof window.DeviceOrientationEvent.requestPermission === 'function';
      let text = '';
      let level = '';
      if (!settings.gravitySide) {
        text = hasApi
          ? '未开启。开启后浏览器会按「本站域名」询问运动传感器权限。'
          : '此浏览器未提供设备方向接口，开启也用不了。';
        level = hasApi ? '' : 'is-bad';
      } else if (this.sensorState === 'active') {
        const g = Number(this.lastGamma || 0);
        text = '已收到数据：倾斜 ' + g.toFixed(1) + '°，按钮在' +
          (this.actionSide === 'left' ? '左' : '右') + '侧。';
        level = 'is-ok';
      } else if (this.sensorState === 'nodata') {
        text = '已开始监听，但 3 秒内没有收到数据。检查浏览器或系统是否禁用了运动传感器。';
        level = 'is-bad';
      } else {
        text = '已开始监听，等待数据…' +
          (needsPermission ? '（本浏览器需要弹窗授权）' : '（本浏览器不需要弹窗授权）');
        level = '';
      }
      hint.textContent = text;
      hint.classList.toggle('is-bad', level === 'is-bad');
      hint.classList.toggle('is-ok', level === 'is-ok');
    }

    /** 切换操作栏所在侧；同一侧不重复写 DOM */
    applyActionSide(side) {
      const next = side === 'left' ? 'left' : 'right';
      if (this.actionSide === next) return;
      this.actionSide = next;
      if (this.root) this.root.classList.toggle('dyf-actions-left', next === 'left');
    }

    /** 清屏模式：隐藏全部叠加控件只留画面；状态跟实例走，翻页不退出 */    toggleCleanScreen(btn) {
      const on = this.root.classList.toggle('dyf-clean');
      this.cleanScreenOn = on;
      // 每条 slide 有自己的操作栏，全部按钮同步切换，避免翻页后状态不一致
      this.root.querySelectorAll('[data-act="clean"]').forEach(b => {
        b.innerHTML = (on ? iconRestore() : iconClean()) +
          '<span>' + (on ? '还原' : '清屏') + '</span>';
      });
      if (on) {
        // 只收掉未完成的吸附，不碰图片/视频缩放：
        // 清屏的语义是“隐藏叠加控件”，不是重置内容。以前这里调了 resetZoom，
        // 导致放大看长图时一点清屏就被打回原尺寸。
        this.finishSnap();
      }
    }

    /** 倍速：按钮在操作栏内，点击向左展开，悬停不展开 */
    buildSpeedGroup() {
      const group = el('div', 'dyf-speed-group');

      const button = el('button', 'dyf-act');
      button.dataset.act = 'speed';
      button.title = '播放速度';
      button.setAttribute('aria-label', '播放速度');
      button.innerHTML = iconSpeed() +
        '<span class="dyf-speed-label">' + formatRate(settings.playbackRate) + '</span>';
      button.addEventListener('click', event => {
        event.stopPropagation();
        group.classList.toggle('is-open');
      });

      const menu = el('div', 'dyf-speed-menu');
      [1, 1.5, 2, 3].forEach(rate => {
        const item = el('button', 'dyf-speed-item', formatRate(rate));
        item.dataset.rate = String(rate);
        if (rate === Number(settings.playbackRate)) item.classList.add('is-active');
        item.addEventListener('click', event => {
          event.stopPropagation();
          this.setPlaybackRate(rate);
          group.classList.remove('is-open');
        });
        menu.appendChild(item);
      });

      group.appendChild(menu);
      group.appendChild(button);
      return group;
    }

    // ------------------------------------------------------------ 手势

    /**
     * 手势统一在这里处理。slide 设了 touch-action:none，原生滚动被禁用。
     *
     * - 拖动过程实时平移：纵向拖动平移整个滚动容器，横向拖动平移媒体元素，
     *   松手后按位移与速度吸附到目标位置（带过渡动画），消除直接跳变的生硬感
     * - 横向：切换同一条帖子内的图片或视频
     * - 纵向：切换帖子；图片放大时纵向拖动改为平移图片
     * - 双击：图片帖切换放大（不再触发点赞），视频帖点赞
     */
    bindMediaGestures(slide) {
      const indexOf = () => Number(slide.dataset.index);

      const isInteractive = target =>
        !!(target.closest && target.closest(
          '.dyf-actions, .dyf-progress, .dyf-embed-link, .dyf-title, .dyf-excerpt-toggle'));

      // 文字卡内部需要原生滚动，手势不接管；展开后的摘要同理
      const inTextbox = target =>
        !!(target.closest && target.closest('.dyf-textbox, .dyf-excerpt.is-expanded'));

      const likeOnce = () => {
        const now = Date.now();
        if (now - this.lastLikeFx < 400) return;
        this.lastLikeFx = now;
        this.onDoubleTapLike(indexOf());
      };

      let tapTimer = null;
      let lastTapAt = 0;
      let lastTapX = 0;
      let lastTapY = 0;

      // 拖动状态：axis 为 null 时未定向，'y' 翻页，'x' 切媒体，'pan' 平移放大图
      let dragging = false;
      let axis = null;
      let startX = 0;
      let startY = 0;
      let lastX = 0;
      let lastY = 0;
      let lastMoveAt = 0;
      let vx = 0;
      let vy = 0;
      // 放大图平移基准：手势开始时的既有偏移，拖动在其上累加
      let panBaseX = 0;
      let panBaseY = 0;
      // 多指触摸：只有第一根手指参与手势。第二指落下者若也参与，
      // 会在吸附动画进行中重置手势基准，表现为画面卡在两屏之间；
      // 但双指缩放需要两根手指，故单独记一张表，只在图片帖上开双指分支
      let activePointerId = null;
      const touchPoints = new Map();
      // 双指缩放会话：起手时的间距、倍率、位移与中点（相对视口中心）
      let pinch = null;
      // 本次手势曾进过双指：抬指后不得再走单击/双击判定
      let pinched = false;

      const finishGesture = () => {
        dragging = false;
        axis = null;
        this.gestureActive = false;
      };

      /** 中断进行中的单指手势并按回弹处理（双指接管、浏览器接管时用） */
      const cancelGesture = () => {
        if (!dragging) return;
        const movedAxis = axis;
        finishGesture();
        if (movedAxis === 'y') this.snapBack();
        else if (movedAxis === 'x') this.cancelDragMedia(indexOf());
        else if (movedAxis === 'pan') this.endPanZoom(indexOf());
      };

      /** 双指缩放上限沿用双击口径：低分辨率小图放大到原生尺寸即可 */
      const pinchMaxScale = el => {
        const shownW = el.clientWidth || window.innerWidth;
        const natural = el.naturalWidth || el.videoWidth || shownW;
        return Math.max(2, natural / shownW);
      };

      /**
       * 进入双指缩放。正在翻页/切图时先回弹再接管，
       * 否则拖到一半改道会让画面停在两屏中间或半张图上。
       * 返回 false 表示本次双指不能缩放（文字帖或站外视频），调用方须阻止单指逻辑。
       */
      const startPinch = () => {
        if (touchPoints.size < 2) return false;
        // 横屏态的媒体层已被旋转，锚点公式不成立，直接不接管
        if (this.landscapeIndex >= 0) return false;
        const index = indexOf();
        const kind = this.currentMediaItem(index)?.type;
        if (kind !== 'image' && kind !== 'video') return false;
        const img = this.zoomTarget(index);
        if (!img) return false;
        if (dragging) cancelGesture();

        const [a, b] = [...touchPoints.values()];
        const z = this.zoomState && this.zoomState.index === index ? this.zoomState : null;
        pinch = {
          startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          startScale: z ? z.scale : 1,
          startX: z ? z.x : 0,
          startY: z ? z.y : 0,
          // 图片在媒体区内居中，其布局中心即视口中心，
          // 两指中点减视口中心就是锚点相对图片中心的偏移
          cx: (a.x + b.x) / 2 - window.innerWidth / 2,
          cy: (a.y + b.y) / 2 - window.innerHeight / 2
        };
        // 退出单指流程：否则抬指时会按拖动结算或触发点击
        dragging = false;
        axis = null;
        activePointerId = null;
        pinched = true;
        this.finishSnap();
        this.gestureActive = true;
        this.gestureBase = index;
        img.classList.remove('dyf-anim');
        return true;
      };

      /** 双指位移；锚点下的图像点保持不动，两指同时移动即双指平移 */
      const movePinch = () => {
        const index = indexOf();
        const img = this.zoomTarget(index);
        if (!pinch || !img || touchPoints.size < 2) return;
        const [a, b] = [...touchPoints.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const scale = Math.min(pinchMaxScale(img), Math.max(1, pinch.startScale * (dist / pinch.startDist)));
        const cx = (a.x + b.x) / 2 - window.innerWidth / 2;
        const cy = (a.y + b.y) / 2 - window.innerHeight / 2;
        // 纸面推导：缩放前锚点下的图像点 p = (C0 - offset0) / s0；
        // 缩放后要让 p 仍在中点下，即 offset1 = C1 - s1 * p
        const ratio = scale / pinch.startScale;
        this.zoomState = {
          index,
          scale,
          x: cx - ratio * (pinch.cx - pinch.startX),
          y: cy - ratio * (pinch.cy - pinch.startY)
        };
        this.clampZoom(img);
        const z = this.zoomState;
        img.style.transform =
          'scale(' + z.scale + ') translate(' + z.x / z.scale + 'px,' + z.y / z.scale + 'px)';
      };

      /** 结束双指：缩回 1 倍直接复位，否则钳制边界并补一次过渡动画 */
      const endPinch = () => {
        if (!pinch) return;
        pinch = null;
        activePointerId = null;
        this.gestureActive = false;
        const index = indexOf();
        const img = this.zoomTarget(index);
        const z = this.zoomState;
        if (!img || !z || z.index !== index) return;
        // 1 倍附近直接复位：留着 1.0x~1.05x 的缩放态会让单指拖动变成平移，
        // 翻页反而失效，手感像卡住了
        if (z.scale <= 1.05) {
          this.resetZoom(index);
          return;
        }
        this.endPanZoom(index);
      };

      // 兜底拦截原生拖拽：图片拖影会中断指针事件流，让鼠标平移失效
      slide.addEventListener('dragstart', event => event.preventDefault());

      slide.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse') touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        // 第二根手指落下：图片帖改走双指缩放；其余媒体也锁住单指流程，
        // 否则双指会变成一次纵向拖动直接翻页
        if (touchPoints.size === 2) {
          if (!startPinch()) { cancelGesture(); pinched = true; }
          return;
        }
        if (activePointerId !== null) return;
        if (isInteractive(event.target) || inTextbox(event.target)) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        // 新手势开始时立即结束未完成的吸附，避免两次动画互相叠加
        this.finishSnap();
        pinched = false;
        activePointerId = event.pointerId;
        dragging = true;
        axis = null;
        this.gestureActive = true;
        this.gestureBase = indexOf();
        startX = event.clientX;
        startY = event.clientY;
        lastX = startX;
        lastY = startY;
        lastMoveAt = event.timeStamp || Date.now();
        vx = 0;
        vy = 0;
        // 平移以既有偏移为起点：panZoom 的位移以本次手势为零点，
        // 不记基准的话第二次拖动会把图片跳回原位
        const zoom = this.zoomState;
        panBaseX = zoom && zoom.index === indexOf() ? zoom.x : 0;
        panBaseY = zoom && zoom.index === indexOf() ? zoom.y : 0;
      });

      slide.addEventListener('pointermove', event => {
        if (touchPoints.has(event.pointerId)) {
          touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }
        if (pinch) { movePinch(); return; }
        // 两指以上且未进入缩放（文字帖等）：一律不参与翻页/切图
        if (touchPoints.size >= 2) return;
        // 横屏态只保留点击（暂停/继续），拖动不参与翻页与平移
        if (this.landscapeIndex >= 0) return;
        if (!dragging || event.pointerId !== activePointerId) return;
        const now = event.timeStamp || Date.now();
        const dt = Math.max(1, now - lastMoveAt);
        vx = (event.clientX - lastX) / dt;
        vy = (event.clientY - lastY) / dt;
        lastX = event.clientX;
        lastY = event.clientY;
        lastMoveAt = now;

        const dx = event.clientX - startX;
        const dy = event.clientY - startY;

        if (!axis) {
          const over = Math.abs(dx) > 12 || Math.abs(dy) > 12;
          // 图片放大时优先平移图片，不参与翻页/切图；pan 也要越过阈值才启动，
          // 否则触屏点击的天然抖动会被当成拖动，双击缩回永远无法触发
          if (this.zoomActive(indexOf())) {
            if (!over) return;
            axis = 'pan';
          } else if (over) {
            axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
            if (axis === 'x' && !this.canStepMedia(indexOf())) {
              // 该条目没有可切换媒体，横向拖动无意义，保持未定向等待纵向
              if (Math.abs(dy) <= 12) { axis = null; return; }
              axis = 'y';
            }
          } else {
            return;
          }
        }

        if (axis === 'y') {
          this.dragScroll(event.clientY - startY);
        } else if (axis === 'x') {
          this.dragMedia(indexOf(), event.clientX - startX);
        } else {
          this.panZoom(indexOf(), panBaseX + dx, panBaseY + dy);
        }
      });

      const endGesture = event => {
        if (!dragging) return false;
        const movedAxis = axis;
        finishGesture();
        // 从未定向（axis 为 null）的按压到抬起是一次纯点击，
        // 返回 false 交由下方的单击/双击判定处理
        if (!movedAxis) return false;

        if (movedAxis === 'y') {
          const dy = event.clientY - startY;
          this.endDragScroll(dy, vy);
        } else if (movedAxis === 'x') {
          const dx = event.clientX - startX;
          this.endDragMedia(indexOf(), dx, vx);
        } else {
          this.endPanZoom(indexOf());
        }
        // 有方向的拖动已被消费，不能再触发点击
        return true;
      };

      slide.addEventListener('pointerup', event => {
        touchPoints.delete(event.pointerId);
        // 双指期间任一指抬起即结束本次缩放，避免第二指残留
        if (pinch) { endPinch(); return; }
        if (event.pointerId !== activePointerId) return;
        activePointerId = null;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (endGesture(event)) return;

        if (isInteractive(event.target) || inTextbox(event.target)) return;
        // 刚从双指收手：不再当成点击，否则会误触暂停或点赞
        if (pinched) { pinched = false; return; }

        // 点击：双击点赞（图片帖为缩放），单击延迟执行
        const now = Date.now();
        const near = Math.abs(event.clientX - lastTapX) < 40 &&
          Math.abs(event.clientY - lastTapY) < 40;

        if (now - lastTapAt < 320 && near) {
          lastTapAt = 0;
          clearTimeout(tapTimer);
          tapTimer = null;
          if (!this.toggleZoom(indexOf())) likeOnce();
          return;
        }

        lastTapAt = now;
        lastTapX = event.clientX;
        lastTapY = event.clientY;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          tapTimer = null;
          this.handleTap(indexOf());
        }, 220);
      });

      // 浏览器接管手势（如边缘回弹）时不产生 pointerup，必须按回弹处理
      slide.addEventListener('pointercancel', event => {
        touchPoints.delete(event.pointerId);
        if (pinch) { endPinch(); return; }
        if (event.pointerId !== activePointerId) return;
        activePointerId = null;
        if (!dragging) return;
        const movedAxis = axis;
        finishGesture();
        if (movedAxis === 'y') this.snapBack();
        else if (movedAxis === 'x') this.cancelDragMedia(indexOf());
        else if (movedAxis === 'pan') this.endPanZoom(indexOf());
      });
      slide.addEventListener('pointerleave', event => {
        if (event.pointerType === 'mouse' && event.pointerId === activePointerId) {
          dragging = false;
          axis = null;
          activePointerId = null;
        }
      });
    }

    /** 该条目是否可以左右切换媒体 */
    canStepMedia(index) {
      const post = this.posts[index];
      return !!(post && this.mediaList(post).length > 1);
    }

    // ---- 纵向拖动翻页 ----

    dragScroll(dy) {
      // 拖动中直接改 scrollTop（浏览器逐帧重绘），比 transform 兼容性更稳。
      // 基准条目在手势开始时锁定，IntersectionObserver 也被暂停，
      // 否则滑过一半时基准会漂移，画面跳回
      const slide = this.slides[this.gestureBase];
      if (!slide) return;
      const base = slide.offsetTop;
      const max = this.scroller.scrollHeight - this.scroller.clientHeight;
      this.scroller.scrollTop = Math.max(0, Math.min(max, base - dy));
    }

    endDragScroll(dy, vy) {
      const height = this.scroller.clientHeight;
      // 位移超过 1/3 屏，或快速轻扫，都视为翻页
      const flick = Math.abs(vy) > 0.55;
      let delta = 0;
      if (dy < -height / 3 || (flick && dy < -40)) delta = 1;
      else if (dy > height / 3 || (flick && dy > 40)) delta = -1;
      const target = Math.max(0, Math.min(this.posts.length - 1, this.gestureBase + delta));
      this.snapTo(target);
    }

    snapBack() {
      this.snapTo(this.activeIndex);
    }

    /**
     * 吸附到目标条目：rAF 自驱动的缓动滚动，结束时强制对齐 offsetTop。
     * 不用 scroll-behavior:smooth——它的动画时长不可控，程序化落位会与
     * 未完成的动画互相覆盖，表现为停在两屏之间。
     */
    snapTo(target) {
      const scroller = this.scroller;
      if (!scroller) return;
      const dest = this.slides[target];
      if (!dest) return;
      const to = dest.offsetTop;
      const previous = this.activeIndex;

      if (target !== previous && this.videos.has(previous)) {
        const old = this.videos.get(previous);
        if (old) old.pause();
      }

      this.finishSnap();
      const session = { target, to, previous };
      this.snapScrollTo = session;

      const from = scroller.scrollTop;
      if (from === to) {
        this.snapSettle();
        return;
      }
      const dur = Math.min(300, Math.max(150, Math.abs(to - from) * 0.55));
      const t0 = performance.now();
      const ease = t => 1 - Math.pow(1 - t, 3);

      this.snapTimer = null;
      const step = now => {
        if (this.snapScrollTo !== session) return;
        // 目标位置每帧实时取：移动端地址栏伸缩会改变 100dvh 与全部
        // offsetTop，用开拍时的旧值落位会停在两屏之间（露出上一条半截）
        const to = dest.offsetTop;
        const p = Math.min(1, (now - t0) / dur);
        scroller.scrollTop = from + (to - from) * ease(p);
        if (p < 1) {
          this.snapTimer = requestAnimationFrame(step);
        } else {
          this.snapSettle();
        }
      };
      this.snapTimer = requestAnimationFrame(step);
    }

    /** 吸附落位：强制对齐并激活目标条目 */
    snapSettle() {
      const info = this.snapScrollTo;
      this.snapTimer = null;
      this.snapScrollTo = null;
      if (!info) return;
      const dest = this.slides[info.target];
      this.scroller.scrollTop = dest ? dest.offsetTop : info.to;
      if (info.target !== info.previous) this.setActive(info.target, false);
    }

    /** 结束未完成的吸附动画：立即对齐目标位置 */
    finishSnap() {
      if (this.snapTimer) {
        if (typeof this.snapTimer === 'number') cancelAnimationFrame(this.snapTimer);
        else clearTimeout(this.snapTimer);
        this.snapTimer = null;
        this.snapSettle();
      }
    }

    // ---- 横向拖动切媒体（轮播：当前媒体推走、相邻图跟进） ----

    /**
     * 拖动时把相邻方向的图片装到屏外同步平移。只在相邻项是图片时插预览：
     * 视频预览要提前解码代价高，保持旧的回弹行为；到边界无相邻项也不插。
     */
    prepareSlidePreview(index, dir) {
      const slide = this.slides[index];
      if (!slide) return null;
      const media = slide.querySelector('.dyf-media');
      if (!media) return null;
      const post = this.posts[index];
      const list = post ? this.mediaList(post) : [];
      const next = this.currentMediaIndex(slide) + dir;
      if (list.length < 2 || next < 0 || next >= list.length || list[next].type !== 'image') {
        this.removeSlidePreview(slide);
        return null;
      }
      let preview = slide.querySelector('.dyf-slide-preview');
      if (preview && this.slidePreviewDir === dir) return preview;
      if (preview) preview.remove();
      preview = document.createElement('img');
      preview.className = 'dyf-slide-preview';
      preview.referrerPolicy = 'no-referrer';
      preview.src = list[next].src;
      // 插到媒体容器之前：容器拖出时预览层不被压在下面
      slide.insertBefore(preview, media);
      this.slidePreviewDir = dir;
      return preview;
    }

    removeSlidePreview(slide) {
      const preview = slide && slide.querySelector('.dyf-slide-preview');
      if (preview) preview.remove();
      this.slidePreviewDir = 0;
    }

    dragMedia(index, dx) {
      const slide = this.slides[index];
      if (!slide) return;
      const media = slide.querySelector('.dyf-media');
      if (!media) return;
      // 未决的收尾定时器会清掉手势期间刚设的 transition:none，
      // 连续快滑时拖动会带上过渡变成滞后跟手，开始新拖动先取消
      this.clearMediaRestoreTimer();
      const dir = dx < 0 ? 1 : -1;
      const preview = Math.abs(dx) > 2 ? this.prepareSlidePreview(index, dir) : this.removeSlidePreview(slide) || null;
      media.style.transition = 'none';
      media.style.transform = 'translateX(' + dx + 'px)';
      if (preview) {
        // 预览跟随：与媒体容器（宽度=屏宽）并排，随 dx 同步进屏
        const w = slide.clientWidth;
        preview.style.transition = 'none';
        preview.style.transform = 'translateX(' + (dir > 0 ? w + dx : dx - w) + 'px)';
      }
    }

    endDragMedia(index, dx, vx) {
      const slide = this.slides[index];
      if (!slide) return;
      const media = slide.querySelector('.dyf-media');
      const width = slide.clientWidth;
      let delta = 0;
      if (dx < -width / 3 || (Math.abs(vx) > 0.55 && dx < -40)) delta = 1;
      else if (dx > width / 3 || (Math.abs(vx) > 0.55 && dx > 40)) delta = -1;

      // 回弹：媒体归位、预览滑回屏外，动画结束统一复位清理
      const restore = () => {
        if (!media) return;
        const preview = slide.querySelector('.dyf-slide-preview');
        const w = slide.clientWidth;
        media.style.transition = 'transform .2s ease-out';
        media.style.transform = '';
        if (preview) {
          const dir = this.slidePreviewDir || (dx < 0 ? 1 : -1);
          preview.style.transition = 'transform .2s ease-out';
          preview.style.transform = 'translateX(' + (dir > 0 ? w : -w) + 'px)';
        }
        this.armMediaRestoreTimer(media, 240);
      };

      if (delta === 0) { restore(); return; }
      const changed = this.stepMedia(delta);
      if (!changed) { restore(); return; }
      // 切换成功：状态已到新图。带预览时走轮播收尾——当前媒体（旧图）
      // 滑出屏幕、预览（新图）滑入；applyImage 换 src 发生在屏外，无闪现。
      // 无预览（相邻是视频或到边界）保持旧行为：无过渡直接归位，避免残留。
      const preview = slide.querySelector('.dyf-slide-preview');
      const w = slide.clientWidth;
      this.clearMediaRestoreTimer();
      if (preview) {
        media.style.transition = 'transform .22s ease-out';
        media.style.transform = 'translateX(' + (delta === 1 ? -w : w) + 'px)';
        preview.style.transition = 'transform .22s ease-out';
        preview.style.transform = 'translateX(0px)';
      } else {
        media.style.transition = 'none';
        media.style.transform = '';
      }
      this.armMediaRestoreTimer(media, 260);
    }

    /** 横滑手势被浏览器接管（pointercancel）时清理媒体位移，不留半程偏移 */
    cancelDragMedia(index) {
      const slide = this.slides[index];
      const media = slide && slide.querySelector('.dyf-media');
      if (!media) return;
      this.removeSlidePreview(slide);
      this.clearMediaRestoreTimer();
      media.style.transition = 'none';
      media.style.transform = '';
      this.armMediaRestoreTimer(media, 60);
    }

    /**
     * 横滑收尾定时器：复位媒体容器过渡与位移、移除预览层。
     * 新拖动开始时会先取消本定时器，避免与手势互相覆盖。
     */
    armMediaRestoreTimer(media, delay) {
      const slide = media.closest('.dyf-slide');
      this.mediaRestoreTimer = setTimeout(() => {
        this.mediaRestoreTimer = null;
        media.style.transition = '';
        media.style.transform = '';
        this.removeSlidePreview(slide);
      }, delay);
    }

    clearMediaRestoreTimer() {
      if (this.mediaRestoreTimer) {
        clearTimeout(this.mediaRestoreTimer);
        this.mediaRestoreTimer = null;
      }
    }

    // ---- 图片 / 视频缩放 ----

    /** 当前条目可缩放的元素：图片帖为 img，视频帖为 video */
    zoomTarget(index) {
      const slide = this.slides[index];
      if (!slide) return null;
      const item = this.currentMediaItem(index);
      if (!item) return null;
      if (item.type === 'video') return slide.querySelector('.dyf-video');
      if (item.type === 'image') return slide.querySelector('.dyf-single-image');
      return null;
    }

    zoomActive(index) {
      const z = this.zoomState;
      return !!(z && z.index === index && z.scale > 1.01);
    }

    /** 双击切换放大；图片帖返回 true 表示已处理（不再点赞） */
    toggleZoom(index) {
      const post = this.posts[index];
      const slide = this.slides[index];
      if (!post || this.currentMediaItem(index)?.type !== 'image' || !slide) return false;
      const img = slide.querySelector('.dyf-single-image');
      if (!img) return false;

      if (this.zoomState && this.zoomState.index === index && this.zoomState.scale > 1) {
        this.zoomState = null;
        img.classList.add('dyf-anim');
        img.style.transform = '';
        setTimeout(() => img.classList.remove('dyf-anim'), 240);
        return true;
      }
      const scale = this.fitZoomScale(img);
      this.zoomState = { index, scale, x: 0, y: 0 };
      img.classList.add('dyf-anim');
      img.style.transform = 'scale(' + scale + ')';
      setTimeout(() => img.classList.remove('dyf-anim'), 240);
      return true;
    }

    /**
     * 放大倍数取「显示宽度撑满屏幕」：contain 缩放后窄图两侧留黑边，
     * 放大后宽度对齐屏幕即可按原始像素看清内容；图片本身已满宽时
     * 退回固定 2 倍继续放大，倍数封顶 4，避免小图放得过大。
     */
    fitZoomScale(el) {
      const screenW = window.innerWidth;
      const shownW = el.clientWidth || screenW;
      let scale = screenW / shownW;
      if (scale <= 1.05) scale = 2;
      // 上限由原生分辨率决定（图片用 naturalWidth，视频用 videoWidth）：
      // 高分辨率长图按比例需要 4 倍以上才能撑满屏宽，固定封顶 4 会让极限长图撑不满；
      // 下限 2 保持既有行为，低分辨率内容最多放大到原生尺寸，超过只会发糊
      const natural = el.naturalWidth || el.videoWidth || shownW;
      return Math.min(Math.max(scale, 2), Math.max(2, natural / shownW));
    }

    /** 放大状态下拖动平移，边界内钳制（图片与视频共用） */
    panZoom(index, dx, dy) {
      const z = this.zoomState;
      if (!z || z.index !== index) return;
      const el = this.zoomTarget(index);
      if (!el) return;
      z.x = dx;
      z.y = dy;
      this.clampZoom(el);
      el.style.transform =
        'scale(' + z.scale + ') translate(' + z.x / z.scale + 'px,' + z.y / z.scale + 'px)';
    }

    /** 平移越界量钳制：z.x/z.y 是视觉位移，范围 = (布局尺寸 × scale − 视口) / 2 */
    clampZoom(img) {
      const z = this.zoomState;
      if (!z) return;
      // 必须用布局尺寸：getBoundingClientRect 是 transform 后的视觉矩形，
      // 已含缩放，再乘 scale 会把边界放大 scale 倍，图能被拖出屏幕
      const maxX = Math.max(0, (img.clientWidth * z.scale - window.innerWidth) / 2);
      const maxY = Math.max(0, (img.clientHeight * z.scale - window.innerHeight) / 2);
      z.x = Math.max(-maxX, Math.min(maxX, z.x));
      z.y = Math.max(-maxY, Math.min(maxY, z.y));
    }

    endPanZoom(index) {
      const z = this.zoomState;
      if (!z || z.index !== index) return;
      const el = this.zoomTarget(index);
      if (!el) return;
      el.classList.add('dyf-anim');
      this.clampZoom(el);
      el.style.transform =
        'scale(' + z.scale + ') translate(' + z.x / z.scale + 'px,' + z.y / z.scale + 'px)';
      setTimeout(() => el.classList.remove('dyf-anim'), 240);
    }

    /** 切换条目或切图时复位缩放 */
    resetZoom(index) {
      if (!this.zoomState || this.zoomState.index !== index) return;
      this.zoomState = null;
      const el = this.zoomTarget(index);
      if (el) el.style.transform = '';
    }

    /** 暂停时在画面中央显示暂停图标 */
    updatePauseIcon(video) {
      const slide = video.closest('.dyf-slide');
      if (!slide) return;
      const shouldShow = video.paused && !video.ended;
      let icon = slide.querySelector('.dyf-pause-icon');
      if (!icon) {
        if (!shouldShow) return;
        icon = el('div', 'dyf-pause-icon');
        icon.innerHTML = iconPause();
        slide.appendChild(icon);
      }
      icon.classList.toggle('dyf-show', shouldShow);
    }

    /** 单击：静音时先开声，否则切换播放/暂停 */
    handleTap(index) {
      const video = this.videos.get(index);
      if (!video) return;
      if (video.muted) {
        this.toggleMute();
        if (video.paused) video.play().catch(() => {});
        return;
      }
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    onDoubleTapLike(index) {
      const post = this.posts[index];
      const slide = this.slides[index];
      if (!post || !slide) return;
      this.showHeart(slide);
      // 双击只点赞，不取消
      if (likedIds.has(post.id)) return;
      this.onLike(index, this.actEls && this.actEls.like);
    }

    showHeart(slide) {
      const heart = el('div', 'dyf-heart', '♥');
      slide.appendChild(heart);
      setTimeout(() => heart.remove(), 800);
    }

    toggleAutoNext() {
      settings.autoNext = !settings.autoNext;
      store.set('settings', settings);
      for (const video of this.videos.values()) video.loop = !settings.autoNext;
      this.refreshAutoNextButtons();
      this.toast(settings.autoNext ? '已开启自动连播' : '已关闭自动连播，改为循环');
    }

    refreshAutoNextButtons() {
      if (!this.root) return;
      const label = settings.autoNext ? '连播' : '单条';
      this.root.querySelectorAll('[data-act="autonext"]').forEach(button => {
        button.innerHTML = iconNext() + '<span>' + label + '</span>';
        button.classList.toggle('is-on', !!settings.autoNext);
      });
    }

    // ------------------------------------------------------------ 媒体

    /** 只重建媒体区域，保留标题、操作栏和当前媒体索引。 */
    fillSlideMedia(slide) {
      slide.querySelector('.dyf-media').textContent = '';
      slide.querySelectorAll('.dyf-progress, .dyf-time, .dyf-pause-icon').forEach(node => node.remove());
      slide.dataset.mediaReady = '0';
      if (this.currentMediaItem(Number(slide.dataset.index))?.type === 'video') this.buildProgress(slide);
    }

    /** 同源读取详情；缓存 Promise 和解析结果以合并并发请求，失败后允许重试。 */
    loadDetail(post) {
      if (this.detailCache.has(post.id)) return this.detailCache.get(post.id);
      const url = new URL('/detail.php', location.origin);
      url.searchParams.set('id', post.id);
      const request = fetch(url.href, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(parseDetail)
        .catch(error => {
          if (this.detailCache.get(post.id) === request) this.detailCache.delete(post.id);
          throw error;
        });
      this.detailCache.set(post.id, request);
      return request;
    }

    /** 激活疑似帖后补视频；快速切换、退出或重开时不更新已失效的画面。 */
    async ensureDetailMedia(index) {
      const post = this.posts[index];
      const slide = this.slides[index];
      const root = this.root;
      if (!post?.needsDetailMedia || post.detailMediaChecked || !slide || slide.dataset.detailLoading === '1') return;
      slide.dataset.detailLoading = '1';
      const isCurrent = () => this.opened && this.root === root && this.slides[index] === slide &&
        this.activeIndex === index && this.posts[index] === post;
      this.showMediaTip(slide, '正在检查视频…');
      try {
        const detail = await this.loadDetail(post);
        // 已离开的帖子只缓存详情，重新激活后再应用，避免遗留提示或自动播放。
        if (!isCurrent()) return;
        if (!post.detailMediaChecked) {
          post.videos = detail.videos;
          post.detailMediaChecked = true;
          if (post.videos.length) {
            post.type = post.images.length ? 'mixed' : 'video';
            post.kind = post.images.length ? '图+视频' : '视频';
          }
        }
        this.clearMediaTip(slide);
        // 单图仍保持当前显示与缩放，仅在原来没有图片时新建视频画面。
        if (this.currentMediaItem(index)?.type === 'video') {
          this.fillSlideMedia(slide);
          this.ensureMedia(index);
          this.syncVideos();
          this.playCurrent();
        }
        this.updateCounter();
      } catch (error) {
        if (!isCurrent()) return;
        this.showMediaTip(slide, '视频信息加载失败：' + error.message, '重试', () => {
          void this.ensureDetailMedia(index);
        });
      } finally {
        delete slide.dataset.detailLoading;
      }
    }

    ensureMedia(index) {
      const slide = this.slides[index];
      const post = this.posts[index];
      if (!slide || !post || slide.dataset.mediaReady === '1') return;
      const media = slide.querySelector('.dyf-media');
      if (!media) return;

      const item = this.currentMediaItem(index);
      if (item?.type === 'video') {
        // 视频元素由 syncVideos 统一挂载，这里只标记就绪
      } else if (item?.type === 'image') {
        // 只渲染当前这一张，左右切换由手势改变索引后重设 src
        const img = el('img', 'dyf-single-image');
        img.alt = post.title || '';
        img.referrerPolicy = 'no-referrer';
        // PC 上默认的图片拖拽会启动原生 HTML5 drag，打断指针事件流
        img.draggable = false;
        media.appendChild(img);
        this.applyImage(index);
        this.updateCounter();
      } else if (post.type === 'embed') {
        const box = el('div', 'dyf-textbox');
        box.appendChild(el('div', '', post.excerpt || post.title || '站外视频'));
        const link = el('a', 'dyf-embed-link', '在 B 站打开');
        link.href = post.embed.replace('player.bilibili.com/player.html', 'www.bilibili.com/video');
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.display = 'inline-block';
        link.style.marginTop = '18px';
        box.appendChild(link);
        media.appendChild(box);
      } else {
        const box = el('div', 'dyf-textbox');
        box.textContent = post.excerpt || post.title || '（无正文）';
        media.appendChild(box);
      }

      slide.dataset.mediaReady = '1';
    }

    dropMedia(index) {
      const slide = this.slides[index];
      if (!slide || slide.dataset.mediaReady !== '1') return;
      const media = slide.querySelector('.dyf-media');
      if (media && !media.querySelector('video')) media.textContent = '';
      slide.dataset.mediaReady = '0';
    }

    createVideo() {
      const video = document.createElement('video');
      video.className = 'dyf-video';
      video.playsInline = true;
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('x5-playsinline', '');
      video.preload = 'none';
      video.loop = !settings.autoNext;
      video.controls = false;
      video.muted = settings.muted;
      applyRate(video);
      // 点击/双击统一由 slide 的手势处理，这里只管进度与播放状态
      const syncProgress = () => this.updateProgress(video);
      video.addEventListener('timeupdate', syncProgress);
      video.addEventListener('loadedmetadata', syncProgress);
      video.addEventListener('loadedmetadata', () => {
        const slide = video.closest('.dyf-slide');
        if (!slide) return;
        const index = Number(slide.dataset.index);
        if (this.videos.get(index) === video && index === this.activeIndex) this.syncLandscapeBtn();
      });
      video.addEventListener('durationchange', syncProgress);
      video.addEventListener('seeked', syncProgress);

      // 暂停/播放时更新中央图标，让用户知道当前状态
      video.addEventListener('pause', () => {
        this.updatePauseIcon(video);
        this.setVideoLoading(video, false);
      });
      video.addEventListener('play', () => {
        this.updatePauseIcon(video);
        this.setVideoLoading(video, video.readyState < 3);
      });

      // 播完自动下一条：同一条帖子里还有视频就先切视频，否则切帖子
      video.addEventListener('ended', () => {
        if (!settings.autoNext) return;
        const slide = video.closest('.dyf-slide');
        if (!slide) return;
        if (Number(slide.dataset.index) !== this.activeIndex) return;

        const total = this.mediaList(this.posts[this.activeIndex]).length;
        if (total > 1 && this.currentMediaIndex(slide) < total - 1) {
          this.stepMedia(1);
          return;
        }
        this.goTo(this.activeIndex + 1);
      });

      const setLoading = on => this.setVideoLoading(video, on);
      video.addEventListener('loadstart', () => setLoading(true));
      video.addEventListener('waiting', () => setLoading(true));
      video.addEventListener('canplay', () => setLoading(false));
      video.addEventListener('playing', () => setLoading(false));

      // 缓冲不足先自愈一次：多数卡顿是这一段连接取不到数据，重新拉流即可续上
      const onStall = () => this.scheduleStallRecover(video);
      video.addEventListener('waiting', onStall);
      video.addEventListener('stalled', onStall);
      video.addEventListener('playing', () => this.cancelStallRecover(video));
      video.addEventListener('timeupdate', () => this.cancelStallRecover(video));

      // 加载失败时不能只留一张封面图，否则用户会以为这是图片
      video.addEventListener('error', () => {
        void this.recoverVideo(video, '视频加载失败');
      });
      video.addEventListener('playing', () => {
        const slide = video.closest('.dyf-slide');
        if (slide) this.clearMediaTip(slide);
      });
      return video;
    }

    /** 当前视频等待超过期限时显示失败入口；后台、暂停与回收必须撤销计时。 */
    setVideoLoading(video, on) {
      const state = this.videoStates.get(video);
      if (!state) return;
      if (!on) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      const slide = video.closest('.dyf-slide');
      if (!slide) return;
      const media = slide.querySelector('.dyf-media');
      if (!media) return;
      let spinner = media.querySelector('.dyf-loading');
      if (!spinner) {
        spinner = el('div', 'dyf-loading');
        media.appendChild(spinner);
      }
      spinner.classList.toggle('dyf-show', on);
      if (on && !state.timer && !state.renewing && !document.hidden &&
          state.index === this.activeIndex && !video.paused) {
        state.timer = setTimeout(() => {
          state.timer = null;
          if (this.videoStates.get(video) === state) void this.recoverVideo(video, '视频加载超时');
        }, CONFIG.videoLoadTimeoutMs);
      }
    }

    /**
     * 缓冲策略：只有当前条目全量缓冲。实测视频源带宽 87~1500KB/s 波动剧烈，
     * 多路并发会互相挤占带宽、把当前视频拉进卡顿，邻条一律只取元数据
     * （仍会完成 DNS/TLS 与头部握手，切过去少等一段）。
     */
    preloadFor(index) {
      return index === this.activeIndex ? 'auto' : 'metadata';
    }

    /**
     * 卡顿自愈：waiting/stalled 持续到期限仍没有 readyState>=3 就原地重新拉流，
     * 保留播放进度。每个元素只做一次，再卡就走正常失败提示，避免无限请求。
     */
    scheduleStallRecover(video) {
      const state = this.videoStates.get(video);
      if (!state || state.stalled || state.renewing || state.stallTimer) return;
      if (document.hidden || state.index !== this.activeIndex || video.paused) return;
      state.stallTimer = setTimeout(() => {
        state.stallTimer = null;
        if (this.videoStates.get(video) !== state) return;
        if (document.hidden || state.index !== this.activeIndex || video.paused) return;
        if (video.readyState >= 3) return;
        state.stalled = true;
        const at = video.currentTime;
        video.load();
        applyRate(video);
        if (at > 0) {
          video.addEventListener('loadedmetadata', () => {
            if (this.videoStates.get(video) !== state) return;
            const limit = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.5) : at;
            video.currentTime = Math.min(at, limit);
          }, { once: true });
        }
        this.playCurrent();
      }, CONFIG.videoStallRecoverMs);
    }

    cancelStallRecover(video) {
      const state = this.videoStates.get(video);
      if (!state) return;
      clearTimeout(state.stallTimer);
      state.stallTimer = null;
    }

    /** 播放器复用时为这一次媒体分配独立状态，旧续签请求不得覆盖新媒体。 */
    configureVideo(index, video) {
      const old = this.videoStates.get(video);
      if (old) { clearTimeout(old.timer); old.controller?.abort(); }
      const item = this.currentMediaItem(index);
      const state = {
        index, src: item.src, vid: item.vid || '', retried: false,
        timer: null, stallTimer: null, stalled: false
      };
      this.videoStates.set(video, state);
      video.pause();
      this.clearMediaTip(this.slides[index]);
      video.poster = item.poster || '';
      video.setAttribute('data-src', item.src);
      video.preload = this.preloadFor(index);
      // 编号由本脚本管理，不挂站点续签监听所用属性，避免两套请求竞争。
      video.src = item.src;
      video.load();
      applyRate(video);
    }

    /** 使用站点公开同源续签接口，仅刷新当前视频；回收时取消在途请求。 */
    async renewVideo(video, state) {
      if (state.renewing) return state.renewing;
      state.retried = true;
      state.controller = new AbortController();
      const timer = setTimeout(() => state.controller.abort(), 15000);
      state.renewing = (async () => {
        const response = await fetch('/api/video_sign.php?vids=' + encodeURIComponent(state.vid), {
          credentials: 'same-origin', signal: state.controller.signal
        });
        if (!response.ok) throw new Error('视频地址更新失败');
        const data = await response.json();
        const item = data?.success && data.items?.[state.vid];
        if (!item?.ready || !item.url) throw new Error('视频地址暂不可用');
        if (this.videoStates.get(video) !== state || !this.opened) return false;
        const source = this.posts[state.index].videos.find(v => v.src === state.src);
        if (source) source.src = item.url;
        state.src = item.url;
        video.setAttribute('data-src', item.url);
        video.src = item.url;
        video.load();
        applyRate(video);
        return true;
      })();
      try { return await state.renewing; }
      finally { clearTimeout(timer); state.renewing = null; state.controller = null; }
    }

    /** 一次自动续签仍失败就停止等待，重试由用户明确触发。 */
    async recoverVideo(video, message) {
      const state = this.videoStates.get(video);
      if (!state || state.renewing) return;
      this.setVideoLoading(video, false);
      if (state.index === this.activeIndex && state.vid && !state.retried) {
        try {
          if (await this.renewVideo(video, state)) { this.playCurrent(); return; }
        } catch (e) { /* 续签失败进入可见失败状态，不无限循环请求。 */ }
      }
      if (this.videoStates.get(video) !== state) return;
      video.pause();
      const slide = this.slides[state.index];
      this.showMediaTip(slide, message, '重试', () => {
        if (this.videoStates.get(video) !== state || state.index !== this.activeIndex) return;
        this.clearMediaTip(slide);
        // 直接换元素：重试原元素对已挂起的解码器无效，这也是用户看到“重试也不行”的原因
        this.rebuildVideo(state.index);
      });
    }

    showMediaTip(slide, text, actionText, onAction) {
      const media = slide.querySelector('.dyf-media');
      if (!media) return;
      let tip = media.querySelector('.dyf-media-tip');
      if (!tip) {
        tip = el('div', 'dyf-media-tip');
        media.appendChild(tip);
      }
      tip.textContent = '';
      tip.appendChild(el('div', 'dyf-tip-text', text));
      if (actionText) {
        const button = el('button', 'dyf-tip-btn', actionText);
        button.addEventListener('click', event => {
          event.stopPropagation();
          onAction();
        });
        tip.appendChild(button);
      }
      tip.classList.add('dyf-show');
    }

    clearMediaTip(slide) {
      if (!slide) return;
      const tip = slide.querySelector('.dyf-media-tip');
      if (tip) tip.classList.remove('dyf-show');
    }

    /** 自动播放被拦截时不静默失败，给出可点击的播放入口 */
    askManualPlay(slide, video) {
      this.showMediaTip(slide, '点击播放', '播放', () => {
        video.muted = true;
        this.setVideoLoading(video, false);
        this.clearMediaTip(slide);
        video.play().catch(() => {
          this.showMediaTip(slide, '播放失败，请打开原帖', null, null);
        });
      });
    }

    ensureVideo(index) {
      const post = this.posts[index];
      const slide = this.slides[index];
      if (!post || this.currentMediaItem(index)?.type !== 'video' || !slide) return null;
      if (this.videos.has(index)) return this.videos.get(index);

      const media = slide.querySelector('.dyf-media');
      if (!media) return null;

      const item = this.currentMediaItem(index);
      if (!item) return null;

      const video = this.videoPool.pop() || this.createVideo();
      video.muted = settings.muted;
      video.loop = !settings.autoNext;
      applyRate(video);
      media.appendChild(video);
      this.videos.set(index, video);
      this.configureVideo(index, video);
      this.updateCounter();
      return video;
    }

    releaseVideo(index, discard) {
      const video = this.videos.get(index);
      if (!video) return;
      this.setVideoLoading(video, false);
      const state = this.videoStates.get(video);
      state?.controller?.abort();
      clearTimeout(state?.timer);
      clearTimeout(state?.stallTimer);
      this.videoStates.delete(video);
      this.videos.delete(index);
      video.pause();
      video.removeAttribute('src');
      // 图与视频往返时可能复用同一个元素，清除源标记以确保重新设置 src。
      video.removeAttribute('data-src');
      try { video.load(); } catch (e) { /* 忽略 */ }
      video.remove();
      // discard：元素可能已被浏览器挂起/解码器释放，不能再放回池里喂给下一条
      if (!discard && this.videoPool.length < CONFIG.videoPoolSize) this.videoPool.push(video);
    }

    /**
     * 只保留邻近的视频元素：桌面前后各一个，移动端只留当前与下一条。
     * 距离更远的立即释放，避免同时占用多个解码器与带宽。
     */
    syncVideos() {
      // 移动端三路并发在弱网下互相抢带宽，卡顿比预先缓冲更明显
      const narrow = window.matchMedia('(max-width: 640px)').matches;
      const keep = new Set(narrow
        ? [this.activeIndex, this.activeIndex + 1]
        : [this.activeIndex - 1, this.activeIndex, this.activeIndex + 1]);
      for (const [index] of this.videos) {
        if (!keep.has(index) || this.currentMediaItem(index)?.type !== 'video') this.releaseVideo(index);
      }
      for (const index of keep) {
        if (index < 0 || index >= this.posts.length) continue;
        if (this.currentMediaItem(index)?.type === 'video') this.ensureVideo(index);
      }
      // 邻条升为当前后立即改为全量缓冲，降级时收回为只取元数据
      for (const [index, video] of this.videos) video.preload = this.preloadFor(index);
    }

    // ------------------------------------------------------------ 切换

    setActive(index, fromScroll) {
      if (index < 0 || index >= this.posts.length) return;
      if (index === this.activeIndex && fromScroll) {
        this.syncVideos();
        return;
      }

      const previous = this.activeIndex;
      this.activeIndex = index;
      // 换条目必须退出横屏：旋转只对原条目有意义
      if (this.landscapeIndex >= 0 && this.landscapeIndex !== index) this.setLandscape(false);
      // 换条目必须复位上一条的图片缩放，否则回来时图片停在放大状态
      this.resetZoom(previous);

      if (previous >= 0 && this.videos.has(previous)) {
        const old = this.videos.get(previous);
        if (old) old.pause();
      }

      this.refreshWindow();
      // 近处媒体需先就绪，refreshWindow 只负责窗口与回收
      for (let k = index - 2; k <= index + 2; k++) {
        if (k >= 0 && k < this.posts.length) this.ensureMedia(k);
      }
      // 图集在激活时并行预热全部图片，后续翻图不再等待
      this.preloadPostImages(this.posts[index]);

      this.syncVideos();
      this.playCurrent();
      this.syncActions();
      this.updateCounter();
      this.updateActiveClass();
      this.saveProgress();
      this.updateJumpbar();
      this.maybeLoadMore();
      void this.ensureDetailMedia(index);
      this.scheduleCommentPrefetch(index);
    }

    /**
     * 评论区预载：激活条目停留 1.5 秒后预取详情（评论与详情共用一次请求
     * 和缓存），打开评论区即可秒显。快速翻页不发请求，避免放大站点访问量；
     * 预载失败静默，打开评论区时仍有「加载中 / 重试」路径兜底。
     */
    scheduleCommentPrefetch(index) {
      clearTimeout(this.commentPrefetchTimer);
      this.commentPrefetchTimer = setTimeout(() => {
        const post = this.posts[index];
        if (!post || !this.opened || this.activeIndex !== index || this.detailCache.has(post.id)) return;
        this.loadDetail(post).catch(() => { /* 预载失败不打扰用户 */ });
      }, 1500);
    }

    /**
     * 后台：全部保留的视频都停，不只是当前条目；同时清掉加载超时与卡顿自愈计时器，
     * 避免在后台被判超时而进入错误态。
     * 回前台：用户后台前本来在播才恢复；元素被浏览器挂起（readyState 掉到 2 以下或
     * 源被丢弃）时直接重建元素，不能只调 play() —— 挂起的解码器再 load() 也救不回来，
     * 这正是“后台转前台后一直加载、重试也不行”的成因。
     */
    onVisibilityChange() {
      const hidden = document.hidden || document.visibilityState !== 'visible';
      const index = this.activeIndex;
      const video = this.videos.get(index);
      const state = video && this.videoStates.get(video);
      if (!state) return;

      if (hidden) {
        state.resumeOnVisible = state.resumeOnVisible || !video.paused;
        for (const [, item] of this.videos) {
          const st = this.videoStates.get(item);
          if (st) {
            clearTimeout(st.timer);
            st.timer = null;
            clearTimeout(st.stallTimer);
            st.stallTimer = null;
          }
          this.setVideoLoading(item, false);
          if (!item.paused) item.pause();
        }
        return;
      }

      if (!state.resumeOnVisible) return;
      state.resumeOnVisible = false;
      // 元素被挂起：重建比等超时快，也比 video.load() 可靠
      if (video.readyState < 2 || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
        this.rebuildVideo(index);
        return;
      }
      this.playCurrent();
    }

    /**
     * 换一个新的 video 元素重试当前条目。
     * 旧元素可能已被浏览器释放解码器，load() 无法恢复，必须从 DOM 与池里一并丢弃。
     */
    rebuildVideo(index) {
      const state = this.videoStates.get(this.videos.get(index));
      const retried = state ? state.retried : false;
      this.releaseVideo(index, true);
      const video = this.ensureVideo(index);
      if (!video) return;
      const fresh = this.videoStates.get(video);
      // 已续签过一次就保持标记，避免重建与续签互相触发成循环请求
      if (fresh) fresh.retried = retried;
      this.playCurrent();
    }

    playCurrent() {
      const video = this.videos.get(this.activeIndex);
      if (!video || !settings.autoplay) return;
      const state = this.videoStates.get(video);
      if (!state || state.renewing) return;
      if (document.hidden) { state.resumeOnVisible = true; return; }
      const expiry = Number(new URL(state.src, location.href).searchParams.get('expires'));
      if (state.vid && expiry && expiry <= Date.now() / 1000 && !state.retried) {
        void this.recoverVideo(video, '视频地址已过期');
        return;
      }
      const slide = this.slides[this.activeIndex];
      video.muted = settings.muted;
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.then(() => {
          if (slide) this.clearMediaTip(slide);
        }).catch(err => {
          if (this.videoStates.get(video) !== state || state.index !== this.activeIndex) return;
          // AbortError 表示快速切换打断了上一次播放，不是策略拦截
          if (!err || err.name === 'AbortError') return;
          if (err.name === 'NotAllowedError') {
            if (!video.muted) {
              // 浏览器要求静音才能自动播放，降级后重试
              video.muted = true;
              video.play()
                .then(() => { if (slide) this.clearMediaTip(slide); })
                .catch(() => { if (slide) this.askManualPlay(slide, video); });
            } else if (slide) {
              this.askManualPlay(slide, video);
            }
            this.setVideoLoading(video, false);
          } else {
            void this.recoverVideo(video, '视频播放失败');
          }
        });
      }
    }

    goTo(index) {
      const target = Math.max(0, Math.min(this.posts.length - 1, index));
      // 横屏态下翻页先退出横屏，避免旋转跟着新条目误用
      if (this.landscapeIndex >= 0 && target !== this.landscapeIndex) this.setLandscape(false);
      // 统一走吸附：键盘、滚轮、播完自动下一条与手势共用同一套落位与激活逻辑
      this.snapTo(target);
    }

    updateCounter() {
      if (!this.counterEl) return;
      const total = this.posts.length;
      const current = this.activeIndex + 1;
      const post = this.posts[this.activeIndex];
      const slide = this.slides[this.activeIndex];
      // 多媒体条目显示「图集 1/2」：类型名词在前、当前位置在后，
      // 总数已含在分母里不再重复；GIF 标记等附加说明挪到末尾保留
      let mediaPart = '';
      if (post && slide) {
        const mediaTotal = this.mediaList(post).length;
        if (mediaTotal > 1) {
          const noun = (post.kind || '').replace(/\s*\d+$/, '');
          const splitAt = noun.indexOf(' · ');
          const base = splitAt > 0 ? noun.slice(0, splitAt) : noun;
          const tail = splitAt > 0 ? noun.slice(splitAt) : '';
          mediaPart = ' ' + base + ' ' + (this.currentMediaIndex(slide) + 1) + '/' + mediaTotal + tail;
        }
      }
      // 单媒体条目维持「· 类型」后缀；多媒体时类型已并入前段，避免重复
      const kind = !mediaPart && post && post.kind ? ' · ' + post.kind : '';
      // 文本写入独立 span：counterEl 现在还容纳从头看/继续看按钮组
      this.counterTextEl.textContent = total ? `${current} / ${total}${mediaPart}${kind}` : '';
    }

    updateActiveClass() {
      this.slides.forEach((slide, index) => {
        if (!slide) return;
        slide.classList.toggle('is-active', index === this.activeIndex);
      });
    }

    // ------------------------------------------------------------ 加载更多

    async maybeLoadMore() {
      if (this.loadingMore) return;
      if (this.activeIndex < this.posts.length - CONFIG.loadAhead) return;
      if (!this.source.hasMore) return;

      this.loadingMore = true;
      try {
        const added = await this.source.fetchNext();
        const total = this.posts.length;
        for (let i = total - added.length; i < total; i++) this.appendSlide(i, false);
        this.updateCounter();
        if (!added.length && this.source.error) {
          this.toast('加载下一页失败，稍后重试');
        }
      } catch (e) {
        this.toast('加载下一页失败：' + (e && e.message ? e.message : '网络错误'));
      } finally {
        this.loadingMore = false;
      }
    }

    // ------------------------------------------------------------ 进度

    /** 当前 (sort, tag) 的阅读位置条目；首次访问时从存储读取并缓存 */
    marks() {
      if (!this.markEntry) {
        const map = readMarks();
        this.markEntry = map[markKey(this.source.sort, this.source.tag)] || {};
      }
      return this.markEntry;
    }

    /**
     * 记录阅读位置。last 每次切换都更新（进入浮层用它恢复）；
     * farthest 只在向前推进时更新：记录点已加载且当前更靠后才覆盖。
     * 未加载说明进度在更后面，一律不动——这是回翻顶部不丢进度的关键。
     * 同时记下所在列表页码：列表只能往后翻，知道目标在第几页才能判断
     * “该往后拉几页”还是“目标本来就在前面、不该拉”。
     */
    saveProgress() {
      const post = this.posts[this.activeIndex];
      if (!post) return;
      const entry = this.marks();
      const now = Date.now();
      const page = this.source.pageOf(this.activeIndex);
      entry.last = { postId: post.id, at: now, page };
      const far = entry.farthest;
      const farIndex = far && far.postId ? this.posts.findIndex(item => item.id === far.postId) : -1;
      if (!far || (farIndex >= 0 && this.activeIndex > farIndex)) {
        entry.farthest = { postId: post.id, at: now, page };
      }
      writeMarks(this.source.sort, this.source.tag, entry);
    }

    /** 进入浮层定位：last 优先，其次 farthest，都找不到回到第 1 条 */
    restoreProgress() {
      const entry = this.marks();
      let index = -1;
      for (const slot of [entry.last, entry.farthest]) {
        if (!slot || !slot.postId) continue;
        const found = this.posts.findIndex(post => post.id === slot.postId);
        if (found >= 0) { index = found; break; }
      }
      this.activeIndex = index >= 0 ? index : 0;
      const slide = this.slides[this.activeIndex];
      if (slide) this.scroller.scrollTop = slide.offsetTop;
    }

    /** 需要跨页恢复的目标（含记录时的页码）：last 优先，其次 farthest，本地已有则返回 null */
    pendingRestoreSlot() {
      const entry = this.marks();
      for (const slot of [entry.last, entry.farthest]) {
        if (slot && slot.postId && !this.posts.some(post => post.id === slot.postId)) return slot;
      }
      return null;
    }

    /**
     * 跨页恢复进度：目标条目不在已加载条目里时逐页拉取列表直到找到。
     *
     * 列表只能往后翻，所以必须先用记录时的页码判定方向：
     * - 目标在前面的页：拉多少页也没用，直接不拉；
     * - 目标在后面：按页码差算需要的页数，而不是无脑拉满 50 页；
     * - 旧数据没有页码：保守给 10 页（旧逻辑的 50 页会一路拉到 800+ 条）。
     */
    async restoreAcrossPages(slot) {
      const postId = slot && slot.postId;
      if (this.restoringPages || !postId) return;
      const startPage = this.source.page;
      const targetPage = Number(slot.page) || 0;
      if (targetPage && targetPage < startPage) {
        this.toast('上次浏览位置在第 ' + targetPage + ' 页，比当前页靠前，未自动恢复');
        return;
      }
      const limit = targetPage
        ? Math.min(50, targetPage - startPage + 2)
        : 10;
      this.restoringPages = true;
      this.toast('正在恢复上次浏览位置…');
      try {
        for (let page = 0; page < limit && this.opened && this.source.hasMore; page++) {
          const added = await this.source.fetchNext();
          if (!added.length) break;
          const total = this.posts.length;
          for (let i = total - added.length; i < total; i++) this.appendSlide(i, false);
          this.updateCounter();
          const found = this.posts.findIndex(post => post.id === postId);
          if (found >= 0) {
            // 用户从打开起已翻过页（或连播在走）说明正在浏览，
            // 强跳会打断；只提示位置，是否回去交给用户
            if (this.activeIndex === this.openBaselineIndex) {
              if (this.opened) this.jumpTo(found);
            } else if (this.opened) {
              this.toast('上次浏览位置：第 ' + (found + 1) + ' 条');
            }
            return;
          }
          // 多页拉取可能持续数秒，周期刷新提示，避免被当成没有反应
          this.toast('正在恢复上次浏览位置…（已加载 ' + this.posts.length + ' 条）');
        }
        if (this.opened) this.toast('未能恢复上次浏览位置');
      } catch (e) {
        if (this.opened) this.toast('恢复浏览位置失败：' + (e && e.message ? e.message : '网络错误'));
      } finally {
        this.restoringPages = false;
      }
    }

    /** 立即定位到目标条目并完整激活，不做吸附动画（跨页恢复用） */
    jumpTo(index) {
      const slide = this.slides[index];
      if (!slide || !this.scroller) return;
      this.finishSnap();
      this.scroller.scrollTop = slide.offsetTop;
      this.setActive(index, false);
    }

    // ------------------------------------------------------------ 互动

    /** 登录互动由接口返回状态驱动；匿名互动只保存本地标记。 */
    onLike(index, button) {
      const post = this.posts[index];
      if (!post) return;

      if (isLoggedIn()) return this.runAccountAction('vote', post, button);

      const next = !likedIds.has(post.id);
      if (next) likedIds.add(post.id); else likedIds.delete(post.id);
      saveLiked();
      this.syncLikeButton(post.id);
      this.toast(next ? '未登录，仅本地记录' : '已取消本地记录');
    }

    /** 同一帖子同一动作一次只发一个请求，失败保留原状态并明确提示。 */
    async runAccountAction(action, post, button) {
      const key = action + ':' + post.id;
      if (this.accountPending.has(key)) return;
      this.accountPending.add(key);
      if (button) button.disabled = true;
      try {
        const data = await requestAccountAction(action, post.id);
        const like = action === 'vote';
        const voteState = Number(data.vote_state);
        const valid = like ? (voteState === 0 || voteState === 1) &&
          Number.isFinite(Number(data.upvotes)) : typeof data.bookmarked === 'boolean';
        if (!valid) throw new Error('服务器响应无效，请重试');
        const on = like ? voteState === 1 : data.bookmarked;
        const ids = like ? likedIds : favIds;
        if (on) ids.add(post.id); else ids.delete(post.id);
        if (like) {
          saveLiked();
          post.likes = Number(data.upvotes);
          this.syncLikeButton(post.id);
          this.setLikeCount(post.id, String(data.upvotes));
        } else {
          saveFav();
          const active = this.posts[this.activeIndex];
          if (this.actEls && active && active.id === post.id) {
            this.actEls.fav.classList.toggle('is-on', on);
            const label = this.actEls.fav.querySelector('span');
            if (label) label.textContent = on ? '已收藏' : '收藏';
          }
        }
        const card = document.querySelector(CONFIG.sel.card + '[data-id="' + post.id + '"]');
        const pageButton = card?.querySelector(like ? CONFIG.sel.pageLike : CONFIG.sel.pageBookmark);
        pageButton?.classList.toggle(like ? 'voted' : 'bookmarked', on);
        if (like && pageButton) {
          const count = pageButton.querySelector(CONFIG.sel.likeCount);
          if (count) count.textContent = String(data.upvotes);
        }
        this.toast(like ? (on ? '已点赞' : '已取消点赞') : (on ? '已收藏到账号' : '已取消收藏'));
      } catch (error) {
        this.toast(error.name === 'TimeoutError' || error.name === 'AbortError'
          ? '请求超时，请重试' : error.message || '请求失败，请重试');
      } finally {
        this.accountPending.delete(key);
        if (button) button.disabled = false;
      }
    }

    /** 操作栏只有一份且只代表当前条目，其它帖子的状态由 syncActions 在切换时重建 */
    syncLikeButton(postId) {
      const post = this.posts[this.activeIndex];
      if (!this.actEls || !post || post.id !== postId) return;
      this.actEls.like.classList.toggle('is-on', likedIds.has(postId));
    }

    setLikeCount(postId, count) {
      const post = this.posts[this.activeIndex];
      if (!this.actEls || !post || post.id !== postId || !count) return;
      const span = this.actEls.like.querySelector('span');
      if (span) span.textContent = count;
    }

    /** 收藏成功前不改变本地和按钮状态，避免请求失败仍显示已收藏。 */
    onFav(index, button) {
      const post = this.posts[index];
      if (!post) return;
      if (isLoggedIn()) return this.runAccountAction('bookmark', post, button);

      const next = !favIds.has(post.id);
      if (next) favIds.add(post.id); else favIds.delete(post.id);
      saveFav();
      button.classList.toggle('is-on', next);

      this.toast(next ? '未登录，仅本地收藏' : '已取消本地收藏');
    }

    // ------------------------------------------------------------ 保存

    /** 取当前条目正在显示的那份媒体 */
    currentMedia(index) {
      const item = this.currentMediaItem(index);
      if (!item) return null;
      // 代理对非 GIF 图片转成 webp；混合帖保存当前显示项，不能始终取视频。
      return { url: item.src, ext: item.type === 'video' ? 'mp4' : (item.gif ? 'gif' : 'webp') };
    }

    async saveCurrent(index) {
      const post = this.posts[index];
      if (!post) return;
      const media = this.currentMedia(index);
      if (!media) {
        this.toast('该条目没有可直接保存的媒体');
        return;
      }
      const name = safeFileName(post, media.ext);
      this.toast('开始下载…');

      if (typeof GM_download === 'function') {
        let dispatched = false;
        try {
          GM_download({
            url: media.url,
            name,
            saveAs: false,
            onload: () => this.toast('已保存：' + name),
            // 管理器下载失败时再走浏览器兜底，避免只留一句失败提示
            onerror: () => { this.saveFallback(media.url, name); },
            ontimeout: () => { this.saveFallback(media.url, name); }
          });
          dispatched = true;
        } catch (e) {
          dispatched = false;
        }
        if (dispatched) return;
      }

      await this.saveFallback(media.url, name);
    }

    async saveFallback(url, name) {
      const saved = await blobDownload(url, name);
      if (saved) {
        this.toast('已保存：' + name);
        return;
      }
      window.open(url, '_blank', 'noopener');
      this.toast('已在新标签打开，可长按或右键保存');
    }

    // ------------------------------------------------------------ 事件

    onWheel(event) {
      if (!this.opened) return;
      if (event.target.closest('.dyf-panel, .dyf-comments')) return;

      // Ctrl+滚轮：图片帖内缩放（触控板捏合同样带 ctrlKey），其余区域交还浏览器
      if (event.ctrlKey) {
        const post = this.posts[this.activeIndex];
        if (post && this.currentMediaItem(this.activeIndex)?.type === 'image' && event.target.closest('.dyf-media')) {
          event.preventDefault();
          this.wheelZoom(event.deltaY, event.clientX, event.clientY);
        }
        return;
      }

      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      // 正文内部已滚动到边界时再翻页，否则优先让正文滚动
      const textbox = event.target.closest('.dyf-textbox, .dyf-excerpt.is-expanded');
      if (textbox) {
        const atTop = textbox.scrollTop <= 0;
        const atBottom = textbox.scrollTop + textbox.clientHeight >= textbox.scrollHeight - 1;
        if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return;
      }

      event.preventDefault();
      if (this.wheelLocked) return;

      // 触控板一次滑动会产生大量小增量，累计到阈值再翻页，
      // 否则会被识别成连续多次滚动，一下跳好几条
      this.wheelAccum += event.deltaY;
      clearTimeout(this.wheelIdleTimer);
      this.wheelIdleTimer = setTimeout(() => { this.wheelAccum = 0; }, 250);

      if (Math.abs(this.wheelAccum) < CONFIG.wheelThreshold) return;

      const direction = this.wheelAccum > 0 ? 1 : -1;
      this.wheelAccum = 0;
      this.wheelLocked = true;
      this.wheelTimer = setTimeout(() => { this.wheelLocked = false; }, CONFIG.wheelLockMs);
      this.goTo(this.activeIndex + direction);
    }

    /**
     * Ctrl+滚轮缩放：以光标为锚点连续调整倍率，缩回 1x 自动退出放大。
     * 锚点保持：缩放前后光标下的图片点不动（视觉位移按倍率比重排）。
     * 与双击切换（fitZoomScale 定倍率）并存，滚轮不做补间，跟随感优先。
     */
    wheelZoom(deltaY, mx, my) {
      const index = this.activeIndex;
      const img = this.zoomTarget(index);
      if (!img || !img.clientWidth) return;

      // 每格 ±15%；未放大时从 1x 起步
      const factor = deltaY < 0 ? 1.15 : 1 / 1.15;
      if (!this.zoomState || this.zoomState.index !== index) {
        const scale = Math.min(4, factor);
        if (scale <= 1.001) return;
        this.zoomState = { index, scale, x: 0, y: 0 };
      }
      const z = this.zoomState;
      const next = Math.min(4, Math.max(1, z.scale * factor));
      if (next <= 1.001) {
        this.resetZoom(index);
        return;
      }
      const cx = mx - window.innerWidth / 2;
      const cy = my - window.innerHeight / 2;
      const ratio = next / z.scale;
      z.scale = next;
      z.x = cx - (cx - z.x) * ratio;
      z.y = cy - (cy - z.y) * ratio;
      this.clampZoom(img);
      img.classList.remove('dyf-anim');
      img.style.transform =
        'scale(' + z.scale + ') translate(' + z.x / z.scale + 'px,' + z.y / z.scale + 'px)';
    }

    onKeyDown(event) {
      if (!this.opened) return;
      // 字母键统一按小写判定，Shift 组合也能命中
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (this.commentsOpen) {
        // x 是开关：打开后可以再按一次关闭
        if (key === 'Escape' || key === 'x') {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.closeComments();
        } else if (key === ' ') {
          // 空格翻评论列表一屏；评论打开期间不再作用于视频播放/页面翻页
          event.preventDefault();
          event.stopImmediatePropagation();
          const body = this.commentsBodyEl;
          if (body) body.scrollBy({ top: body.clientHeight, behavior: 'smooth' });
        }
        return;
      }
      if (this.helpOpen) {
        if (key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.toggleHelp(false);
        }
        return;
      }
      if (this.settingsOpen) {
        if (key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.togglePanel(false);
        }
        return;
      }
      const target = event.target;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return;

      const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight',
        'PageDown', 'PageUp', ' ', 'j', 'k', 'm', 'c', 'x', 'Tab', 'Escape'];
      if (!keys.includes(key)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      switch (key) {
        case 'ArrowLeft':
        case 'ArrowRight':
          // 多图 / 多视频时左右切换，单媒体时无动作
          this.stepMedia(key === 'ArrowRight' ? 1 : -1);
          break;
        case 'ArrowDown':
        case 'PageDown':
        case 'j':
          this.goTo(this.activeIndex + 1);
          break;
        case 'ArrowUp':
        case 'PageUp':
        case 'k':
          this.goTo(this.activeIndex - 1);
          break;
        case ' ':
          this.togglePlay();
          break;
        case 'm':
          this.toggleMute();
          break;
        case 'c':
          this.cyclePlaybackRate();
          break;
        case 'x':
          this.openComments(this.posts[this.activeIndex]);
          break;
        case 'Tab':
          // 图集内翻下一张，翻到底直接下一条；单媒体条目直接下一条
          this.stepMedia(1) || this.goTo(this.activeIndex + 1);
          break;
        case 'Escape':
          if (this.settingsOpen) this.togglePanel(false);
          else if (this.helpOpen) this.toggleHelp(false);
          // 横屏态先退横屏，再按一次才退出浮层
          else if (this.landscapeIndex >= 0) this.setLandscape(false);
          else this.close();
          break;
      }
    }

    togglePlay() {
      const video = this.videos.get(this.activeIndex);
      if (!video) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    toggleMute() {
      settings.muted = !settings.muted;
      store.set('settings', settings);
      const video = this.videos.get(this.activeIndex);
      if (video) {
        video.muted = settings.muted;
        if (!settings.muted) video.play().catch(() => {});
      }
      // 所有条目共用同一个开关，界面必须同步
      this.refreshVolumeButtons();
      this.toast(settings.muted ? '已静音' : '已开启声音');
    }

    refreshVolumeButtons() {
      if (!this.root) return;
      const icon = settings.muted ? iconVolumeOff() : iconVolumeOn();
      const title = settings.muted ? '取消静音' : '静音';
      this.root.querySelectorAll('[data-act="volume"]').forEach(button => {
        button.innerHTML = icon;
        button.title = title;
      });
    }

    /** 倍速对所有视频生效，并在切换条目后保持 */
    setPlaybackRate(rate) {
      settings.playbackRate = Number(rate) || 1;
      store.set('settings', settings);
      for (const video of this.videos.values()) applyRate(video);
      if (this.root) {
        this.root.querySelectorAll('.dyf-speed-label').forEach(label => {
          label.textContent = formatRate(settings.playbackRate);
        });
        this.root.querySelectorAll('.dyf-speed-item').forEach(item => {
          item.classList.toggle('is-active', Number(item.dataset.rate) === settings.playbackRate);
        });
      }
      this.toast(settings.playbackRate === 1 ? '正常速度' : formatRate(settings.playbackRate) + ' 播放');
    }

    /** 循环切换倍速：1x → 1.5x → 2x → 3x → 1x */
    cyclePlaybackRate() {
      const rates = [1, 1.5, 2, 3];
      const current = Number(settings.playbackRate) || 1;
      const index = rates.indexOf(current);
      this.setPlaybackRate(rates[(index + 1) % rates.length]);
    }

    // ------------------------------------------------------------ 面板

    buildPanel() {
      const panel = el('div', 'dyf-panel');
      const box = el('div', 'dyf-panel-box');
      box.appendChild(el('h3', '', '设置'));

      box.appendChild(this.checkboxRow('自动播放', settings.autoplay, value => {
        settings.autoplay = value;
        store.set('settings', settings);
        if (value) this.playCurrent();
      }));

      box.appendChild(this.checkboxRow('播完自动下一条', settings.autoNext, value => {
        settings.autoNext = value;
        store.set('settings', settings);
        for (const video of this.videos.values()) video.loop = !value;
        this.refreshAutoNextButtons();
      }));

      box.appendChild(this.checkboxRow('默认静音', settings.muted, value => {
        settings.muted = value;
        store.set('settings', settings);
        const video = this.videos.get(this.activeIndex);
        if (video) video.muted = value;
      }));

      box.appendChild(this.checkboxRow('下次自动进入抖音模式', settings.autoEnter, value => {
        settings.autoEnter = value;
        store.set('settings', settings);
      }));

      let gravityRow;
      gravityRow = this.checkboxRow('按手机倾斜自动换边（按钮放低的一侧）', settings.gravitySide, value => {
        void this.toggleGravitySide(value, gravityRow.__checkbox);
      });
      box.appendChild(gravityRow);

      // 传感器自检：把「浏览器不支持 / 权限被拒 / 已监听但无数据 / 正常」分开说清楚
      this.sensorHintEl = el('div', 'dyf-hint');
      box.appendChild(this.sensorHintEl);
      this.updateSensorHint();

      box.appendChild(this.fieldRow('屏蔽标签（逗号分隔，可带 #）', settings.blockTags, value => {
        settings.blockTags = value;
        store.set('settings', settings);
        this.toast('屏蔽规则已保存，重新进入生效');
      }));

      box.appendChild(this.fieldRow('屏蔽作者（逗号分隔）', settings.blockAuthors, value => {
        settings.blockAuthors = value;
        store.set('settings', settings);
        this.toast('屏蔽规则已保存，重新进入生效');
      }));

      const actions = el('div', 'dyf-panel-actions');

      const clearBtn = el('button', '', '清除进度');
      clearBtn.addEventListener('click', () => {
        writeMarks(this.source.sort, this.source.tag, null);
        this.markEntry = {};
        this.updateJumpbar();
        this.toast('进度已清除');
      });

      const closeBtn = el('button', 'dyf-primary', '关闭');
      closeBtn.addEventListener('click', () => this.togglePanel(false));

      actions.appendChild(clearBtn);
      actions.appendChild(closeBtn);
      box.appendChild(actions);
      panel.appendChild(box);

      panel.addEventListener('click', event => {
        if (event.target === panel) this.togglePanel(false);
      });

      return panel;
    }

    checkboxRow(label, checked, onChange) {
      const row = el('div', 'dyf-row');
      const text = el('label', '', label);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!checked;
      const id = 'dyf-cb-' + Math.random().toString(36).slice(2, 8);
      input.id = id;
      text.setAttribute('for', id);
      input.addEventListener('change', () => onChange(input.checked));
      row.appendChild(text);
      row.appendChild(input);
      // 供异步失败时回滚勾选状态（如传感器权限被拒绝）
      row.__checkbox = input;
      return row;
    }

    fieldRow(label, value, onChange) {
      const wrap = el('div', 'dyf-field');
      wrap.appendChild(el('span', '', label));
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      input.addEventListener('change', () => onChange(input.value.trim()));
      wrap.appendChild(input);
      return wrap;
    }

    togglePanel(open) {
      if (!this.panelEl) return;
      this.settingsOpen = open;
      this.panelEl.classList.toggle('dyf-show', open);
    }

    // ------------------------------------------------------------ 帮助

    buildHelpPanel() {
      const panel = el('div', 'dyf-panel dyf-help');
      const box = el('div', 'dyf-panel-box');
      box.appendChild(el('h3', '', '快捷键与操作'));

      const rows = [
        ['上下翻页', '↓ / ↑、PageDown / PageUp、j / k，或直接上下滑动'],
        ['左右切换', '← / →，或左右滑动（多图、多视频时）'],
        ['图集连翻', 'Tab：图集内翻下一张，翻到底直接下一条；单图 / 视频直接下一条'],
        ['播放 / 暂停', '空格，或点击画面'],
        ['静音切换', 'm，或右上角声音按钮'],
        ['循环倍速', 'c，依次切换 1x / 1.5x / 2x / 3x'],
        ['打开评论区', 'x，或点击右侧评论按钮；再按一次关闭'],
        ['评论区翻页', '评论区打开时按空格，向下翻一屏'],
        ['点赞', '双击画面（图片帖双击为放大 / 缩小）'],
        ['图片缩放', '双指捏合连续缩放（移动端）；双击在适配尺寸与原生分辨率间切换；PC 上 Ctrl + 滚轮以光标为锚点缩放'],
        ['视频缩放与横屏', '视频帖同样可双指捏合放大；横屏比例的单个视频右下角有横屏按钮，点后旋转铺满并隐藏控件，顶部按钮、Esc 或再点一次退出'],
        ['倾斜换边', '设置里开启后，右侧整列按钮会移到手机较低的一侧；接近平放或横屏时回右侧'],
        ['打开原帖', '点击左下角标题'],
        ['清屏', '右下角「清屏」按钮：隐藏全部控件只看内容，再点还原'],
        ['从头看 / 回到进度', '左上角计数器右侧的两个小图标：从头看回第 1 页最新并清掉阅读进度，另一个回到上次看到的最靠后位置'],
        ['关闭 / 退出', 'Esc']
      ];

      const list = el('div', 'dyf-help-list');
      for (const [name, desc] of rows) {
        const row = el('div', 'dyf-help-row');
        row.appendChild(el('span', 'dyf-help-key', name));
        row.appendChild(el('span', 'dyf-help-desc', desc));
        list.appendChild(row);
      }
      box.appendChild(list);

      const actions = el('div', 'dyf-panel-actions');
      const closeBtn = el('button', 'dyf-primary', '知道了');
      closeBtn.addEventListener('click', () => this.toggleHelp(false));
      actions.appendChild(closeBtn);
      box.appendChild(actions);

      panel.appendChild(box);
      panel.addEventListener('click', event => {
        if (event.target === panel) this.toggleHelp(false);
      });
      return panel;
    }

    toggleHelp(open) {
      if (!this.helpEl) return;
      this.helpOpen = open;
      this.helpEl.classList.toggle('dyf-show', open);
    }

    // ------------------------------------------------------------ 评论

    buildCommentPanel() {
      const wrap = el('div', 'dyf-comments');
      const mask = el('div', 'dyf-comments-mask');
      mask.addEventListener('click', () => this.closeComments());

      const sheet = el('div', 'dyf-comments-sheet');
      const handle = el('div', 'dyf-comments-handle');
      // 点击顶部把手在 60% 与 90% 高度之间切换
      handle.addEventListener('click', () => sheet.classList.toggle('is-expanded'));

      const head = el('div', 'dyf-comments-head');
      const title = el('div', 'dyf-comments-title', '评论');
      const closeBtn = el('button', 'dyf-comments-close', '关闭');
      closeBtn.addEventListener('click', () => this.closeComments());
      head.appendChild(title);
      head.appendChild(closeBtn);

      const body = el('div', 'dyf-comments-body');

      sheet.appendChild(handle);
      sheet.appendChild(head);
      sheet.appendChild(body);
      wrap.appendChild(mask);
      wrap.appendChild(sheet);

      /*
       * 下拉关闭：只在下拉把手与标题栏上接管拖动。
       * 评论区内的列表滚动不受影响，外层视频的上下翻页由 slide 处理，二者不重叠。
       */
      let dragStartY = 0;
      let dragOffset = 0;
      let dragging = false;

      const onDragStart = event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        dragging = true;
        dragStartY = event.clientY;
        dragOffset = 0;
        sheet.style.transition = 'none';
        if (event.target.setPointerCapture) {
          try { event.target.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
        }
      };

      const onDragMove = event => {
        if (!dragging) return;
        dragOffset = Math.max(0, event.clientY - dragStartY);
        sheet.style.transform = 'translateY(' + dragOffset + 'px)';
      };

      const onDragEnd = () => {
        if (!dragging) return;
        dragging = false;
        sheet.style.transition = '';
        sheet.style.transform = '';
        if (dragOffset > 90) this.closeComments();
      };

      [handle, head].forEach(target => {
        target.addEventListener('pointerdown', onDragStart);
        target.addEventListener('pointermove', onDragMove);
        target.addEventListener('pointerup', onDragEnd);
        target.addEventListener('pointercancel', onDragEnd);
      });

      return { wrap, sheet, body, title };
    }

    openComments(post) {
      if (!post || !this.commentsEl) return;
      this.commentsOpen = true;
      this.commentsPostId = post.id;
      this.commentsSheetEl.classList.remove('is-expanded');
      this.commentsEl.classList.add('dyf-show');
      this.commentsTitleEl.textContent = post.comments ? '评论 ' + post.comments : '评论';
      this.renderCommentState('加载中…');
      this.loadComments(post);
    }

    closeComments() {
      this.commentsOpen = false;
      this.commentsPostId = null;
      if (this.commentsEl) this.commentsEl.classList.remove('dyf-show');
    }

    async loadComments(post) {
      const requestId = post.id;
      this.commentsLoading = true;
      try {
        const { comments } = await this.loadDetail(post);
        // 请求返回时用户可能已经切到别的条目
        if (this.commentsPostId === requestId) this.renderComments(comments);
      } catch (e) {
        if (this.commentsPostId === requestId) {
          this.renderCommentState('评论加载失败', '重试', () => this.openComments(post));
        }
      } finally {
        this.commentsLoading = false;
      }
    }

    renderComments(comments) {
      const body = this.commentsBodyEl;
      if (!body) return;
      body.textContent = '';
      if (!comments.length) {
        this.renderCommentState('还没有评论');
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const comment of comments) {
        const row = el('div', 'dyf-comment');
        // 缩进封顶，深层回复不至于把正文挤成窄条
        row.style.paddingLeft = Math.min(comment.depth, 3) * 20 + 'px';

        if (comment.avatar) {
          const avatar = el('img', 'dyf-comment-avatar');
          avatar.src = comment.avatar;
          avatar.alt = '';
          avatar.referrerPolicy = 'no-referrer';
          avatar.loading = 'lazy';
          row.appendChild(avatar);
        }

        const main = el('div', 'dyf-comment-main');
        const meta = el('div', 'dyf-comment-meta');
        meta.appendChild(el('span', 'dyf-comment-author', comment.author || '匿名'));
        if (comment.level) meta.appendChild(el('span', '', comment.level));
        if (comment.time) meta.appendChild(el('span', '', comment.time));
        main.appendChild(meta);
        if (comment.text) main.appendChild(el('div', 'dyf-comment-text', comment.text));
        if (comment.sticker) {
          const sticker = el('img', 'dyf-comment-sticker');
          sticker.src = comment.sticker;
          sticker.alt = '';
          sticker.referrerPolicy = 'no-referrer';
          sticker.loading = 'lazy';
          // 站点存在失效贴纸（如 /static/stickers/21.jpg 返回 404），隐藏而不是留破图
          sticker.addEventListener('error', () => sticker.remove());
          main.appendChild(sticker);
        }
        if (comment.likes) main.appendChild(el('div', 'dyf-comment-likes', '赞 ' + comment.likes));
        row.appendChild(main);
        fragment.appendChild(row);
      }
      body.appendChild(fragment);
    }

    renderCommentState(text, actionLabel, onAction) {
      const body = this.commentsBodyEl;
      if (!body) return;
      body.textContent = '';
      const state = el('div', 'dyf-comments-state', text);
      if (actionLabel && onAction) {
        const button = el('button', '', actionLabel);
        button.addEventListener('click', onAction);
        state.appendChild(button);
      }
      body.appendChild(state);
    }

    toast(message) {
      if (!this.toastEl) return;
      this.toastEl.textContent = message;
      this.toastEl.classList.add('dyf-show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toastEl.classList.remove('dyf-show');
      }, 1800);
    }
  }

  // ---------------------------------------------------------------- 图标

  /** 点赞：取自 lucide `heart`（ISC） */
  function iconHeart() {
    return '<svg viewBox="0 0 24 24"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg>';
  }

  /** 收藏：取自 lucide `star`（ISC） */
  function iconStar() {
    return '<svg viewBox="0 0 24 24"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';
  }

  /** 连播：取自 lucide `skip-forward`（ISC） */
  function iconNext() {
    return '<svg viewBox="0 0 24 24"><path d="M21 4v16"/>' +
      '<path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/></svg>';
  }

  /** 从头看：回到顶部语义（顶部横杠 + 向上箭头） */
  function iconJumpToTop() {
    return '<svg viewBox="0 0 24 24"><line x1="5" y1="4" x2="19" y2="4"/>' +
      '<polyline points="6 14 12 8 18 14"/><line x1="12" y1="8" x2="12" y2="20"/></svg>';
  }

  /**
   * 横屏入口：竖屏手机与横放平板交叠。
   * 取自 lucide `tablet-smartphone`（ISC），不自行拼几何体：
   * 自己画的矩形叠矩形既不像设备，也与其他图标不同线宽语言。
   */
  function iconLandscape() {
    return '<svg viewBox="0 0 24 24">' +
      '<rect width="10" height="14" x="3" y="8" rx="2"/>' +
      '<path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4"/>' +
      '<path d="M8 18h.01"/></svg>';
  }

  /** 退出横屏：取自 lucide `minimize`（ISC） */
  function iconLandscapeExit() {
    return '<svg viewBox="0 0 24 24">' +
      '<path d="M8 3v3a2 2 0 0 1-2 2H3"/>' +
      '<path d="M21 8h-3a2 2 0 0 1-2-2V3"/>' +
      '<path d="M3 16h3a2 2 0 0 1 2 2v3"/>' +
      '<path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';
  }

  /** 清屏：对角角标向中心收拢（收起全部控件），样式同抖音清屏 */
  function iconClean() {
    return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 5h5v5"/><path d="M10 19H5v-5"/></svg>';
  }

  /** 还原：对角角标从中心展开（恢复控件显示） */
  function iconRestore() {
    return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M5 10V5h5"/><path d="M19 14v5h-5"/></svg>';
  }

  /** 继续看：跳向底部语义（底部横杠 + 向下箭头） */
  function iconJumpToBottom() {
    return '<svg viewBox="0 0 24 24"><line x1="5" y1="20" x2="19" y2="20"/>' +
      '<polyline points="6 10 12 16 18 10"/><line x1="12" y1="4" x2="12" y2="16"/></svg>';
  }

  /** 帮助：取自 lucide `circle-help`（ISC） */
  function iconHelp() {
    return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/>' +
      '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>' +
      '<path d="M12 17h.01"/></svg>';
  }

  /**
   * 暂停时中央叠加：取自 lucide `play`（ISC）。
   * CSS 里 `.dyf-pause-icon svg{fill:#fff}` 会把它填成实心，无需描边三角。
   */
  function iconPause() {
    return '<svg viewBox="0 0 24 24"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>';
  }

  /** 倍速：取自 lucide `gauge`（ISC） */
  function iconSpeed() {
    return '<svg viewBox="0 0 24 24"><path d="m12 14 4-4"/>' +
      '<path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';
  }

  /** 1 → 1x，1.5 → 1.5x */
  function formatRate(rate) {
    const value = Number(rate) || 1;
    return (Number.isInteger(value) ? value : value.toFixed(1)) + 'x';
  }

  /**
   * 换源会把 playbackRate 重置为 defaultPlaybackRate，
   * 两个都要设置，倍速才能在切换视频后保持。
   */
  function applyRate(video) {
    if (!video) return;
    const rate = Number(settings.playbackRate) || 1;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  }

  /** 设置：取自 lucide `settings`（ISC） */
  function iconGear() {
    return '<svg viewBox="0 0 24 24"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>' +
      '<circle cx="12" cy="12" r="3"/></svg>';
  }

  /** 退出：取自 lucide `x`（ISC） */
  function iconExit() {
    return '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  }

  /** 窄屏 HUD 折叠箭头，展开时 CSS 旋转 180°；取自 lucide `chevron-left`（ISC） */
  function iconChevron() {
    return '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>';
  }

  /** 保存：取自 lucide `download`（ISC） */
  function iconDownload() {
    return '<svg viewBox="0 0 24 24"><path d="M12 15V3"/>' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<path d="m7 10 5 5 5-5"/></svg>';
  }

  /** 评论：取自 lucide `message-circle`（ISC） */
  function iconComment() {
    return '<svg viewBox="0 0 24 24"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/></svg>';
  }

  /** 有声：取自 lucide `volume-2`（ISC） */
  function iconVolumeOn() {
    return '<svg viewBox="0 0 24 24"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>' +
      '<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>';
  }

  /** 静音：取自 lucide `volume-x`（ISC） */
  function iconVolumeOff() {
    return '<svg viewBox="0 0 24 24"><path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z"/>' +
      '<path d="m16.5 14.5 5-5"/><path d="m16.5 9.5 5 5"/></svg>';
  }

  /** 秒数格式化为 m:ss */
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes + ':' + (rest < 10 ? '0' + rest : rest);
  }

  /** 文件名去掉各系统非法字符，标题截断避免路径过长 */
  function safeFileName(post, ext) {
    const raw = (post.title || 'huanggua')
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const title = raw.slice(0, 60) || 'huanggua';
    return '黄瓜吧-' + title + '-' + post.id + '.' + ext;
  }

  /**
   * Blob 方式下载。跨域资源要求服务端放行 CORS：
   * 实测图片域名可以，视频域名不行，后者由调用方交给 GM_download 或新标签兜底。
   */
  async function blobDownload(url, name) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return false;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- 过滤

  function applyFilters(posts) {
    const tags = settings.blockTags.split(/[,，]/).map(s => s.trim().replace(/^#/, '')).filter(Boolean);
    const authors = settings.blockAuthors.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (!tags.length && !authors.length) return posts;
    return posts.filter(post => {
      if (authors.includes(post.author)) return false;
      const postTags = post.tags.map(t => t.replace(/^#/, ''));
      return !postTags.some(tag => tags.includes(tag));
    });
  }

  // ---------------------------------------------------------------- 启动

  const state = {
    overlay: null,
    launcher: null
  };

  function createLauncher() {
    if (document.getElementById('dyf-launcher')) return;
    const button = document.createElement('button');
    button.id = 'dyf-launcher';
    button.title = '切换抖音模式（Alt+D）';
    button.setAttribute('aria-label', '切换抖音模式');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px">' +
      '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
      '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
    // 浮层样式在关闭时会被移除，启动按钮必须自带样式才能保持外观
    button.style.cssText = [
      // 站点自带的「回到顶部」是右下角的橙色圆钮，这里上移并改用纯红，
      // 避免两个按钮挨在一起难以区分
      'position:fixed', 'right:18px', 'bottom:128px', 'z-index:2147483647',
      'width:52px', 'height:52px', 'border-radius:50%', 'border:2px solid rgba(255,255,255,.85)',
      'cursor:pointer', 'background:#fe2c55', 'color:#fff', 'padding:0',
      'display:flex', 'align-items:center', 'justify-content:center',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)', 'transition:transform .15s',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif'
    ].join(';');
    button.addEventListener('click', () => {
      if (!state.overlay) state.overlay = new Overlay();
      state.overlay.open();
    });
    document.documentElement.appendChild(button);
    state.launcher = button;
  }

  function toggleMode() {
    if (!state.overlay) state.overlay = new Overlay();
    if (state.overlay.opened) state.overlay.close();
    else state.overlay.open();
  }

  /** 无法启动时给用户可见反馈，避免「装了什么都没发生」 */
  function showBootHint(text) {
    if (document.getElementById('dyf-boot-hint')) return;
    const hint = document.createElement('div');
    hint.id = 'dyf-boot-hint';
    hint.textContent = text;
    hint.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483001',
      'background:rgba(0,0,0,.82)', 'color:#fff', 'font-size:12px',
      'padding:8px 12px', 'border-radius:6px', 'max-width:70vw',
      'font-family:-apple-system,sans-serif', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 8000);
  }

  /** 原页面对齐到刚浏览的条目：滚动居中并短时描边（浮层样式表此时可能已移除，全用内联样式） */
  function highlightCard(card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prevOutline = card.style.outline;
    const prevOffset = card.style.outlineOffset;
    card.style.outline = '3px solid #fe2c55';
    card.style.outlineOffset = '2px';
    setTimeout(() => {
      card.style.outline = prevOutline;
      card.style.outlineOffset = prevOffset;
    }, 2000);
  }

  function boot() {
    try {
      // 入口只放在列表页：详情页没有可刷的列表，按钮留在那里只会干扰
      if (/detail\.php/i.test(location.pathname)) return;

      injectStyle();
      createLauncher();

      document.addEventListener('keydown', event => {
        if (event.altKey && (event.key === 'd' || event.key === 'D')) {
          event.preventDefault();
          toggleMode();
        }
      });

      // 跨页退出后落到本页：定位到刚才浏览的条目并高亮（一次性，读到即清除）
      const exitTarget = store.get('exitTarget', null);
      if (exitTarget) {
        store.remove('exitTarget');
        // 只认 10 分钟内的目标，陈旧残留不做任何定位
        if (Date.now() - exitTarget.at < 10 * 60 * 1000) {
          const card = document.querySelector('.post-card[data-id="' + exitTarget.postId + '"]');
          if (card) highlightCard(card);
        }
      }

      const lastMode = store.get('lastMode', 'original');
      if (lastMode === 'dy' && settings.autoEnter) {
        setTimeout(() => {
          if (!state.overlay) state.overlay = new Overlay();
          state.overlay.open();
        }, 500);
      }
    } catch (e) {
      // 启动失败时保持静默，不向页面插入任何诊断节点
    }
  }

  window.__dyf = {
    version: VERSION,
    open: () => { if (!state.overlay) state.overlay = new Overlay(); return state.overlay.open(); },
    close: () => state.overlay && state.overlay.close(),
    overlay: () => state.overlay
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
