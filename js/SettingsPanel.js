/**
 * ComfyUI-Translation 设置面板模块
 * 负责：设置项注册、翻译按钮、插件翻译管理面板
 */

import {
  isTranslationEnabled,
  toggleTranslation,
  currentConfig,
  saveConfig,
  error
} from "./utils.js";

// ─── 设置项注册 ───────────────────────────────────────────

// 设置项 ID（注册与同步共用）
const SETTING_ID_LANG = "🌐Language翻译语言.Language";
const SETTING_ID_STYLE = "🌐Language翻译语言.ButtonStyle";
const SETTING_ID_OPTS = "🌐Language翻译语言.TranslateOptions";

let registeredApp = null;
// 程序性同步防护标志：防止同步写入设置商店时触发 onChange 把值再写回磁盘
let applyingConfig = false;

// 设置对话框选择器（新旧版兼容）
const DIALOG_SELECTOR = '#comfy-settings-dialog, .p-dialog, [role="dialog"], [class*="z-1700"]';

/** 设置对话框是否打开（用于区分用户真实操作与商店 hydration 等程序性写入） */
function isSettingsDialogOpen() {
  return !!document.querySelector(DIALOG_SELECTOR);
}

/** 从服务器拉取最新 config.json 更新 currentConfig（避免多标签/多客户端下用陈旧值覆盖） */
async function refreshCurrentConfig() {
  try {
    const res = await fetch("./translation_node/get_config");
    if (!res.ok) return;
    const c = await res.json();
    currentConfig.translation_enabled = c.translation_enabled;
    currentConfig.locale = c.locale || currentConfig.locale;
    currentConfig.button_style = c.button_style || currentConfig.button_style;
    currentConfig.disabled_plugins = c.disabled_plugins || [];
    currentConfig.translate_options = c.translate_options !== false;
  } catch (e) {
    error("刷新配置失败:", e);
  }
}

/** 将当前配置回写到 ComfyUI Settings 商店，保证设置对话框显示与 config.json 一致 */
function syncSettingsFromConfig(app) {
  const setter = app.ui.settings.setSettingValue?.bind(app.ui.settings);
  if (!setter) return;
  applyingConfig = true;
  try {
    setter(SETTING_ID_LANG, currentConfig.locale);
    setter(SETTING_ID_STYLE, styleLabelOf(currentConfig.button_style));
    setter(SETTING_ID_OPTS, currentConfig.translate_options);
  } finally {
    applyingConfig = false;
  }
}

/** 设置对话框每次打开时，用最新配置同步一次显示值（防止对话框显示陈旧/默认值） */
function syncSettingsDialogIfOpen() {
  if (!registeredApp) return;
  const dialogEl = document.querySelector(DIALOG_SELECTOR);
  if (!dialogEl || dialogEl.dataset.tlSynced) return;
  dialogEl.dataset.tlSynced = "1";
  (async () => {
    await refreshCurrentConfig();
    syncSettingsFromConfig(registeredApp);
  })();
}

/**
 * 在 ComfyUI 设置面板中注册所有翻译相关设置
 * @param {object} app - ComfyUI app 实例
 * @returns {Promise<void>}
 */
export async function registerSettings(app) {
  let availableLocales = ["zh-CN", "en_US"];
  try {
    const locRes = await fetch("./translation_node/get_locales");
    if (locRes.ok) availableLocales = await locRes.json();
  } catch (e) {}

  let isSettingsRegistered = false;
  registeredApp = app;

  // 1. 语言设置
  app.ui.settings.addSetting({
    id: SETTING_ID_LANG,
    name: "🌐 Language settings for translation (翻译语言设置)",
    type: "combo",
    options: availableLocales,
    defaultValue: currentConfig.locale,
    onChange: async (newVal) => {
      if (applyingConfig) return;
      if (!isSettingsRegistered) return;
      // 忽略设置商店 hydration（服务器端 userdata 旧值）等非用户操作，防止覆盖 config.json
      if (!isSettingsDialogOpen()) return;
      if (newVal && newVal !== currentConfig.locale) {
        await saveConfig(currentConfig.translation_enabled, newVal, currentConfig.button_style);
        alert(`Language set to ${newVal}. The page will reload.`);
        location.reload();
      }
    }
  });

  // 2. UI 风格设置（多样式开关，持久化到 config.json，切换后实时重绘无需刷新）
  app.ui.settings.addSetting({
    id: SETTING_ID_STYLE,
    name: "🎨 Toggle Style (翻译开关样式)",
    type: "combo",
    options: STYLE_OPTIONS,
    defaultValue: styleLabelOf(currentConfig.button_style),
    onChange: async (newVal) => {
      if (applyingConfig) return;
      if (!isSettingsRegistered) return;
      if (!isSettingsDialogOpen()) return;
      const key = parseStyleKey(newVal);
      if (key !== currentConfig.button_style) {
        await saveConfig(currentConfig.translation_enabled, currentConfig.locale, key, currentConfig.disabled_plugins, currentConfig.translate_options);
        renderToggle(app);
      }
    }
  });

  // 3. COMBO 下拉选项翻译开关
  app.ui.settings.addSetting({
    id: SETTING_ID_OPTS,
    name: "📋 Translate COMBO Options (下拉选项 翻译开关)",
    tooltip: "开启或关闭，节点中 COMBO 下拉框选项的翻译。关闭后下拉选项保持英文原文。修改后刷新页面生效。",
    type: "boolean",
    defaultValue: currentConfig.translate_options,
    onChange: async (newVal) => {
      if (applyingConfig) return;
      if (!isSettingsRegistered) return;
      if (!isSettingsDialogOpen()) return;
      if (newVal !== currentConfig.translate_options) {
        await saveConfig(currentConfig.translation_enabled, currentConfig.locale, currentConfig.button_style, currentConfig.disabled_plugins, newVal);
        location.reload();
      }
    }
  });

  isSettingsRegistered = true;

  // 主动同步 config.json 的值到 ComfyUI Settings (userdata)，
  // 防止用户手动编辑 config.json 后 UI 显示与实际行为不一致
  try {
    syncSettingsFromConfig(app);
  } catch (e) {
    // 旧版 ComfyUI 可能不支持 setSettingValue，忽略即可
  }

  // 商店收敛：若 hydration 晚于注册把旧值写回商店，在对话框关闭时持续纠正为 config.json 值
  startStoreConvergence(app);
}

/** 短时轮询纠正设置商店与 config.json 的分歧（仅对话框关闭时，避免干扰用户操作） */
function startStoreConvergence(app) {
  const getter = app.ui.settings.getSettingValue?.bind(app.ui.settings);
  if (!getter) return;
  let checks = 0;
  const timer = setInterval(() => {
    checks++;
    try {
      const diverged = getter(SETTING_ID_LANG) !== currentConfig.locale
        || getter(SETTING_ID_STYLE) !== styleLabelOf(currentConfig.button_style)
        || getter(SETTING_ID_OPTS) !== currentConfig.translate_options;
      if (diverged && !isSettingsDialogOpen()) {
        syncSettingsFromConfig(app);
      }
    } catch (e) { /* 旧版兼容：静默 */ }
    if (checks >= 20) clearInterval(timer); // 10 秒后停止
  }, 500);
}

// ─── 翻译按钮 ─────────────────────────────────────────────

// 开关文字多语言表（按 get_locales 返回的语言代码匹配）
const TOGGLE_I18N = {
  "zh-CN": { onFull: "翻译开启", offFull: "翻译关闭", switchOn: "开启", switchOff: "关闭", tipOn: "已开启翻译效果", tipOff: "已使用原生语言" },
  "en-US": { onFull: "Translation On", offFull: "Translation Off", switchOn: "On", switchOff: "Off", tipOn: "Translation enabled", tipOff: "Using native language" },
  "de-DE": { onFull: "Übersetzung An", offFull: "Übersetzung Aus", switchOn: "An", switchOff: "Aus", tipOn: "Übersetzung aktiviert", tipOff: "Originalsprache aktiv" },
  "fr-FR": { onFull: "Traduction On", offFull: "Traduction Off", switchOn: "On", switchOff: "Off", tipOn: "Traduction activée", tipOff: "Langue native utilisée" },
  "ja-JP": { onFull: "翻訳オン", offFull: "翻訳オフ", switchOn: "オン", switchOff: "オフ", tipOn: "翻訳が有効です", tipOff: "元の言語を使用しています" },
  "ko-KR": { onFull: "번역 켜짐", offFull: "번역 꺼짐", switchOn: "켜기", switchOff: "끄기", tipOn: "번역이 활성화되었습니다", tipOff: "원본 언어를 사용 중입니다" },
  "ru-RU": { onFull: "Перевод вкл", offFull: "Перевод выкл", switchOn: "вкл", switchOff: "выкл", tipOn: "Перевод включён", tipOff: "Используется исходный язык" },
};

/**
 * 根据语言代码获取开关文字，支持 en_US / zh 等变体的宽松匹配
 * @param {string} locale - 语言代码
 */
function getToggleI18n(locale) {
  if (TOGGLE_I18N[locale]) return TOGGLE_I18N[locale];
  const prefix = String(locale || "").slice(0, 2).toLowerCase();
  const matched = Object.keys(TOGGLE_I18N).find(k => k.toLowerCase().startsWith(prefix + "-"));
  return (matched && TOGGLE_I18N[matched]) || TOGGLE_I18N["zh-CN"];
}

// 支持的开关样式：pill 胶囊分段 / gradient 旧版七彩渐变 / plain 旧版原生低调
const STYLE_OPTIONS = ["pill (胶囊分段)", "gradient (七彩渐变)", "plain (原生低调)"];

/** 从设置选项文本解析样式键，未知值回退 gradient（兼容旧配置） */
function parseStyleKey(val) {
  const s = String(val || "").toLowerCase();
  if (s.includes("pill")) return "pill";
  if (s.includes("plain")) return "plain";
  return "gradient";
}

/** 样式键 → 设置选项显示文本 */
function styleLabelOf(key) {
  const k = parseStyleKey(key);
  return STYLE_OPTIONS.find(o => o.startsWith(k)) || STYLE_OPTIONS[0];
}

/** 判断元素及其父容器是否真实可见（排除 display:none 的隐藏容器） */
function isVisibleEl(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const pr = el.parentElement?.getBoundingClientRect();
  return !!pr && pr.width > 0 && pr.height > 0;
}

let styleInjected = false;
function injectToggleStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const styleElem = document.createElement("style");
  styleElem.textContent = `
    @keyframes flowEffect {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .translation-active-gradient {
      background: linear-gradient(90deg, #ff0000, #ff8000, #ffff00, #80ff00, #00ff80, #0080ff, #8000ff, #ff0080, #ff0000);
      background-size: 400% 100%; color: white; border: none; animation: flowEffect 8s ease infinite;
      text-shadow: 0 1px 2px rgba(0,0,0,0.7); box-shadow: 0 0 8px rgba(255,255,255,0.3);
      transition: all 0.3s ease; font-weight: bold;
    }
    .translation-inactive-gradient {
      background: linear-gradient(90deg, #f0f0f0, #d0d0d0, #b0b0b0, #909090, #707070, #909090, #b0b0b0, #d0d0d0, #f0f0f0);
      background-size: 300% 100%; color: #333; border: none; animation: flowEffect 6s ease infinite;
      box-shadow: 0 0 5px rgba(0,0,0,0.2); transition: all 0.3s ease; font-weight: bold;
    }
    .translation-active-plain {
      background-color: var(--comfy-menu-bg, #353535);
      color: var(--input-text, #ffffff);
      border: 1px solid var(--border-color, #555555);
      transition: all 0.2s ease;
    }
    .translation-inactive-plain {
      background-color: var(--comfy-input-bg, #1e1e1e);
      color: var(--descrip-text, #888888);
      border: 1px solid var(--border-color, #333333);
      transition: all 0.2s ease;
    }
    .translation-btn:hover {
      transform: translateY(-1px); box-shadow: 0 4px 8px rgba(0,0,0,0.3); cursor: pointer; filter: brightness(1.1);
    }
    .translation-btn {
      cursor: pointer; border-radius: 6px; padding: 6px 12px; font-size: 12px;
    }
    .tl-toggle-pill {
      position: relative;
      display: inline-flex; align-items: stretch; margin: 2px;
      background: var(--comfy-input-bg, #1e1e1e);
      border: 1px solid var(--border-color, #45484c);
      border-radius: 999px; padding: 3px;
      font-size: 12px; user-select: none;
    }
    .tl-toggle-thumb {
      position: absolute; top: 3px; bottom: 3px; left: 3px; width: 0;
      background: #4a9eff; border-radius: 999px;
      box-shadow: 0 1px 4px rgba(74, 158, 255, 0.4);
      transition: left 0.25s ease, width 0.25s ease;
      cursor: pointer;
    }
    .tl-toggle-seg {
      position: relative; z-index: 1;
      padding: 5px 14px; border-radius: 999px; cursor: default;
      color: var(--descrip-text, #888888); line-height: 1.4;
      white-space: nowrap; transition: color 0.25s ease;
      pointer-events: none; /* 文字分段不响应点击，事件穿透到蓝色滑块 */
    }
    .tl-toggle-seg.active {
      color: #ffffff; font-weight: bold;
    }
  `;
  document.head.appendChild(styleElem);
}

/** 按当前配置构建开关元素（不插入 DOM） */
function buildToggle() {
  const translationEnabled = isTranslationEnabled();
  const locale = currentConfig.locale;
  const style = parseStyleKey(currentConfig.button_style);
  const i18n = getToggleI18n(locale);
  const tooltip = translationEnabled ? i18n.tipOn : i18n.tipOff;
  injectToggleStyles();

  if (style === "pill") {
    // 胶囊分段控件：蓝色滑块指示当前状态，点击蓝色滑块滑动切换（灰色文字分段不响应）
    const pill = document.createElement("div");
    pill.className = "tl-toggle-pill";
    pill.title = tooltip;

    const thumb = document.createElement("span");
    thumb.className = "tl-toggle-thumb";

    const segLeft = document.createElement("span");
    segLeft.className = "tl-toggle-seg";
    const segRight = document.createElement("span");
    segRight.className = "tl-toggle-seg";

    let on = translationEnabled;
    let sliding = false;

    const applyTexts = () => {
      segLeft.textContent = on ? i18n.onFull : i18n.switchOn;
      segRight.textContent = on ? i18n.switchOff : i18n.offFull;
      segLeft.classList.toggle("active", on);
      segRight.classList.toggle("active", !on);
    };
    applyTexts();

    // 将滑块定位到活动分段（初次渲染不动画）
    pill.initThumb = (animate) => {
      const target = on ? segLeft : segRight;
      if (!animate) thumb.style.transition = "none";
      thumb.style.left = target.offsetLeft + "px";
      thumb.style.width = target.offsetWidth + "px";
      if (!animate) {
        void thumb.offsetWidth; // 强制回流，恢复过渡供后续滑动使用
        thumb.style.transition = "";
      }
    };

    const slideAndToggle = (segIsOn) => {
      if (sliding || segIsOn === on) return;
      sliding = true;
      on = !on;
      applyTexts();
      pill.initThumb(true);
      // 先播放滑动动画，再保存并刷新
      setTimeout(() => toggleTranslation(), 320);
    };
    // 触发点仅为蓝色滑块：点击后切换到另一侧（灰色文字分段 pointer-events:none 不响应）
    thumb.addEventListener("click", () => slideAndToggle(!on));

    pill.appendChild(thumb);
    pill.appendChild(segLeft);
    pill.appendChild(segRight);
    return pill;
  }

  // 旧版按钮样式：gradient 七彩渐变 / plain 原生低调
  const isPlain = style === "plain";
  const btn = document.createElement("button");
  btn.className = "translation-btn";
  const activeClass = isPlain ? "translation-active-plain" : "translation-active-gradient";
  const inactiveClass = isPlain ? "translation-inactive-plain" : "translation-inactive-gradient";
  btn.classList.add(translationEnabled ? activeClass : inactiveClass);
  btn.textContent = translationEnabled ? `${i18n.onFull} (${locale})` : i18n.offFull;
  btn.style.fontWeight = isPlain ? "normal" : "bold";
  btn.style.margin = "2px";
  btn.title = tooltip;
  btn.addEventListener("click", async () => { await toggleTranslation(); });
  return btn;
}

/**
 * 查找可见的插入锚点：旧版可见菜单 → settingsGroup → 新版 Vue 顶栏右侧按钮区
 * 新版 ComfyUI 中 .comfy-menu 及 menuContainer 被隐藏（display:none），
 * 必须检测锚点与父容器的可见性后再插入
 */
function insertToggle(app, el) {
  const comfyMenu = document.querySelector(".comfy-menu");
  if (comfyMenu && isVisibleEl(comfyMenu) && app.ui?.menuContainer && isVisibleEl(app.ui.menuContainer)) {
    app.ui.menuContainer.appendChild(el);
    return true;
  }
  const settingsGroupEl = app.menu?.settingsGroup?.element;
  if (settingsGroupEl && isVisibleEl(settingsGroupEl)) {
    settingsGroupEl.before(el);
    return true;
  }
  const topRight = document.querySelector(".workflow-tabs-container .ml-auto");
  if (topRight && isVisibleEl(topRight)) {
    topRight.prepend(el);
    return true;
  }
  const topBar = document.querySelector(".workflow-tabs-container");
  if (topBar && isVisibleEl(topBar)) {
    topBar.appendChild(el);
    return true;
  }
  return false;
}

const TOGGLE_ID = "toggle-translation-button";
let toggleWatchdog = null;

/** 低频看门狗：开关节点被顶栏重渲染移除、或插入位置不可见时自动修复 */
function startWatchdog(app, el) {
  if (toggleWatchdog) clearInterval(toggleWatchdog);
  toggleWatchdog = setInterval(() => {
    if (!el.isConnected || !isVisibleEl(el)) {
      el.remove();
      insertToggle(app, el);
      el.initThumb?.(false);
    }
  }, 2000);
}

/** 渲染（或按新样式重绘）翻译开关 */
function renderToggle(app) {
  try {
    if (toggleWatchdog) { clearInterval(toggleWatchdog); toggleWatchdog = null; }
    document.getElementById(TOGGLE_ID)?.remove();

    const el = buildToggle();
    el.id = TOGGLE_ID;

    if (insertToggle(app, el)) {
      el.initThumb?.(false);
      startWatchdog(app, el);
      return;
    }

    // 锚点可能尚未就绪，轮询重试（最多 30 秒）
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (insertToggle(app, el)) {
        clearInterval(timer);
        el.initThumb?.(false);
        startWatchdog(app, el);
      } else if (tries >= 60) {
        clearInterval(timer);
        error("未找到可用的顶栏锚点，翻译开关未插入");
      }
    }, 500);
  } catch (e) {
    error("添加面板开关失败:", e);
  }
}

/**
 * 在顶部菜单栏添加翻译切换开关（多样式，兼容新旧 UI）
 * @param {object} app - ComfyUI app 实例
 */
export function addPanelButtons(app) {
  renderToggle(app);
}

// ─── 插件翻译管理面板 ────────────────────────────────────

const SELF_NAME = "ComfyUI-Chinese-Translation";
const PANEL_ID = "tl-plugin-manager-panel";

// 注入锁：防止并发调用导致重复注入面板
let isInjecting = false;

function buildPluginPanel(parentEl) {
  // 强制去重：如果面板已存在，直接返回
  const existing = document.getElementById(PANEL_ID);
  if (existing) return;

  const disabled = new Set(currentConfig.disabled_plugins || []);

  // 先创建面板 DOM 并设置 ID，确保去重检查能正确工作
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = "margin-top:12px;padding:10px;border:1px solid #444;border-radius:6px;background:#1e1e1e;font-size:13px;";
  panel.innerHTML = `
    <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">🚫 插件翻译管理</div>
    <div style="margin-bottom:6px;color:#aaa;font-size:12px;">取消勾选可禁用对应插件的节点翻译。修改后点击「保存并刷新」生效。</div>
    <input type="text" placeholder="搜索插件..." id="tl-plugin-search"
      style="width:100%;padding:5px 8px;margin-bottom:6px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;box-sizing:border-box;outline:none;" />
    <div style="display:flex;gap:6px;margin-bottom:6px;">
      <button id="tl-select-all" style="flex:1;padding:3px;border:1px solid #555;border-radius:4px;background:#333;color:#ddd;cursor:pointer;font-size:12px;">全选</button>
      <button id="tl-deselect-all" style="flex:1;padding:3px;border:1px solid #555;border-radius:4px;background:#333;color:#ddd;cursor:pointer;font-size:12px;">全不选</button>
    </div>
    <div id="tl-plugin-list" style="height:300px;overflow-y:auto;border:1px solid #444;border-radius:4px;padding:4px;"></div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:8px;">
      <button id="tl-save-plugins" style="padding:6px 20px;border:none;border-radius:4px;background:#4a9eff;color:#fff;cursor:pointer;font-weight:bold;">保存并刷新</button>
      <span id="tl-status" style="font-size:11px;color:#888;"></span>
    </div>
  `;

  const listEl = panel.querySelector("#tl-plugin-list");
  const searchEl = panel.querySelector("#tl-plugin-search");
  const statusEl = panel.querySelector("#tl-status");

  // 先显示加载状态
  statusEl.textContent = "正在加载插件列表...";

  // 异步加载插件列表并填充内容
  fetch("./translation_node/get_plugin_list")
    .then(resp => resp.json())
    .then(plugins => {
      plugins = plugins.filter(n => n !== SELF_NAME && n !== "internal");
      statusEl.textContent = `共 ${plugins.length} 个翻译文件，已禁用 ${disabled.size} 个`;
      
      plugins.forEach(name => {
        const checked = !disabled.has(name);
        const div = document.createElement("div");
        div.style.cssText = "padding:2px 4px;border-radius:3px;";
        div.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" ${checked ? "checked" : ""} data-plugin="${name}" style="cursor:pointer;"> <span style="word-break:break-all;">${name}</span></label>`;
        div.addEventListener("mouseenter", () => div.style.background = "#333");
        div.addEventListener("mouseleave", () => div.style.background = "");
        listEl.appendChild(div);
      });
    })
    .catch(e => {
      error("获取插件列表失败:", e);
      statusEl.textContent = "加载插件列表失败";
    });

  // 搜索过滤
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.toLowerCase();
    listEl.querySelectorAll("div").forEach(d => {
      d.style.display = d.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // 全选 / 全不选
  panel.querySelector("#tl-select-all").addEventListener("click", () => {
    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      if (cb.closest("div").style.display !== "none") cb.checked = true;
    });
  });
  panel.querySelector("#tl-deselect-all").addEventListener("click", () => {
    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      if (cb.closest("div").style.display !== "none") cb.checked = false;
    });
  });

  // 保存并刷新
  panel.querySelector("#tl-save-plugins").addEventListener("click", async () => {
    const newDisabled = [];
    listEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
      if (!cb.checked) newDisabled.push(cb.dataset.plugin);
    });
    await saveConfig(currentConfig.translation_enabled, currentConfig.locale, currentConfig.button_style, newDisabled, currentConfig.translate_options);
    location.reload();
  });

  parentEl.appendChild(panel);
}

function tryInjectPluginPanel() {
  // 检查注入锁，防止并发调用
  if (isInjecting) return;
  // 检查面板是否已存在
  if (document.getElementById(PANEL_ID)) return;

  isInjecting = true;
  try {
    // 持有锁后再次检查，防止并发调用已注入面板
    if (document.getElementById(PANEL_ID)) return;

    // 新版 UI
    const allSettingItems = document.querySelectorAll('[class*="setting-item"], [class*="SettingItem"], .p-fieldset, .p-panel');
    for (const item of allSettingItems) {
      if (item.textContent?.includes("Translate COMBO Options") || item.textContent?.includes("翻译下拉选项")) {
        const container = item.closest('[class*="group"], [class*="category"], .p-fieldset-content, .p-panel-content') || item.parentElement;
        if (container) buildPluginPanel(container);
        return;
      }
    }

    // 旧版 UI
    const oldDialog = document.querySelector("#comfy-settings-dialog");
    if (oldDialog) {
      const tbody = oldDialog.querySelector("tbody");
      if (tbody) {
        const rows = tbody.querySelectorAll("tr");
        for (const row of rows) {
          if (row.textContent?.includes("Translate COMBO") || row.textContent?.includes("翻译下拉")) {
            buildPluginPanel(tbody);
            return;
          }
        }
      }
    }
  } finally {
    // 同步解锁，不用 requestAnimationFrame
    isInjecting = false;
  }
}

/**
 * 监听设置面板打开，自动注入插件翻译管理面板
 */
export function setupPluginManager() {
  const observer = new MutationObserver(() => {
    tryInjectPluginPanel();
    syncSettingsDialogIfOpen();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
