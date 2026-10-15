'use strict';

/**
 * app.js — the terminal panel.
 *
 * The page is chrome plus terminal instances. It owns no session state: tabs
 * live in the plugin process, so closing or hiding this panel never kills a
 * shell. Output arrives either as Server-Sent Events from the plugin's loopback
 * feed or, if that connection is refused, by polling the plugin over the host
 * bridge. Both paths carry the same sequence-numbered, base64 payloads.
 */

(function main() {
  const bridge = window.pluginBridge;
  const CHANNEL = 'windows-terminal';
  const INPUT_COALESCE_MS = 8;
  const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
  const SSE_OPEN_TIMEOUT_MS = 3000;
  const POLL_IDLE_MS = 400;
  const POLL_BUSY_MS = 50;

  const STRINGS = {
    'zh-CN': {
      newTab: '新建终端',
      restart: '重启',
      clear: '清屏',
      close: '关闭',
      copy: '复制',
      paste: '粘贴',
      emptyTitle: '还没有终端',
      emptyHint: '在工作面板中直接使用 Windows 交互式终端：Shell 在项目目录中启动，输入的命令以你的用户身份执行。终端内容不会交给 AI。',
      emptyNoShell: '未找到可用的 Shell（需要 PowerShell 7、Windows PowerShell 5.1 或 cmd）。',
      emptyNoHelper: '插件缺少 ConPTY 辅助程序，请重新安装插件。',
      emptyLoading: '正在读取 Shell 列表…',
      emptyStateError: '无法读取终端状态，请点上方提示里的重试。',
      emptyCatalog: (list, helper) => `已检测到：${list}；ConPTY 辅助程序：${helper}`,
      retry: '重试',
      stateStarting: '启动中',
      stateRunning: '运行中',
      stateExited: '已退出',
      stateError: '错误',
      copied: '已复制选中内容',
      copyEmpty: '没有选中内容',
      pasteEmpty: '剪贴板为空',
      pasteFailed: '读取剪贴板失败',
      copyFailed: '写入剪贴板失败',
      exited: (code) => `进程已退出（代码 ${code}）`,
      forced: 'Shell 进程被终止',
      restartHint: '可以重启该终端继续使用。',
      dropped: (bytes) => `输出过快，已丢弃约 ${bytes} 字节历史输出`,
      transportSse: '事件流',
      transportPoll: '轮询',
      transportUnknown: '未连接',
      shellMissing: 'Shell 不可用',
      cwdNoProject: '未打开项目，已使用用户目录',
      cwdMissing: '原项目目录不存在，已使用用户目录',
      cwdUnc: 'UNC 路径：cmd 可能无法在此目录启动',
      helperMissing: '未找到 ConPTY 辅助程序',
      session: '当前终端',
      sessionList: '终端列表',
      sessionEmpty: '还没有终端',
      chooseShell: '选择 Shell 新建',
      more: '更多操作',
      details: '终端详情',
      closeTerminal: '关闭当前终端',
      noTerminals: '还没有终端，点上方 ＋ 新建。',
      shellLimit: (max) => `已达到终端数量上限（${max}）`,
      detailName: '名称',
      detailShell: 'Shell',
      detailPath: 'Shell 路径',
      detailCwd: '启动目录',
      detailCwdNote: '这是创建终端时的目录，不是 Shell 的实时工作目录。',
      detailSize: '终端尺寸',
      detailStatus: '状态',
      detailTransport: '输出通道',
      detailNoTab: '还没有终端。',
      menuLabel: '终端操作',
    },
    en: {
      newTab: 'New terminal',
      restart: 'Restart',
      clear: 'Clear',
      close: 'Close',
      copy: 'Copy',
      paste: 'Paste',
      emptyTitle: 'No terminal yet',
      emptyHint: 'This is a real Windows interactive terminal in the work panel. The shell starts in the project directory and runs with your user rights. Terminal content is never sent to the AI.',
      emptyNoShell: 'No supported shell found (PowerShell 7, Windows PowerShell 5.1 or cmd).',
      emptyNoHelper: 'The ConPTY helper is missing from the plugin; please reinstall it.',
      emptyLoading: 'Reading the shell list…',
      emptyStateError: 'Could not read the terminal state. Use Retry above.',
      emptyCatalog: (list, helper) => `Detected: ${list}; ConPTY helper: ${helper}`,
      retry: 'Retry',
      stateStarting: 'Starting',
      stateRunning: 'Running',
      stateExited: 'Exited',
      stateError: 'Error',
      copied: 'Selection copied',
      copyEmpty: 'Nothing selected',
      pasteEmpty: 'Clipboard is empty',
      pasteFailed: 'Could not read the clipboard',
      copyFailed: 'Could not write the clipboard',
      exited: (code) => `Process exited (code ${code})`,
      forced: 'The shell process was terminated',
      restartHint: 'Restart the terminal to keep using this tab.',
      dropped: (bytes) => `Output too fast: about ${bytes} bytes of history were dropped`,
      transportSse: 'event stream',
      transportPoll: 'polling',
      transportUnknown: 'not connected',
      shellMissing: 'Shell unavailable',
      cwdNoProject: 'No project open: using your user folder',
      cwdMissing: 'The project folder is gone: using your user folder',
      cwdUnc: 'UNC path: cmd may refuse to start there',
      helperMissing: 'The ConPTY helper was not found',
      session: 'Current terminal',
      sessionList: 'Terminals',
      sessionEmpty: 'No terminal yet',
      chooseShell: 'New terminal with a shell',
      more: 'More actions',
      details: 'Terminal details',
      closeTerminal: 'Close terminal',
      noTerminals: 'No terminal yet — press + above to create one.',
      shellLimit: (max) => `Terminal limit reached (${max})`,
      detailName: 'Name',
      detailShell: 'Shell',
      detailPath: 'Shell path',
      detailCwd: 'Startup directory',
      detailCwdNote: "This is where the shell was started; it is not the shell's live working directory.",
      detailSize: 'Size',
      detailStatus: 'Status',
      detailTransport: 'Output channel',
      detailNoTab: 'No terminal yet.',
      menuLabel: 'Terminal actions',
    },
  };

  const dom = {
    sessionButton: document.getElementById('session'),
    sessionDot: document.getElementById('session-dot'),
    sessionName: document.getElementById('session-name'),
    newButton: document.getElementById('new'),
    newShellButton: document.getElementById('new-shell'),
    moreButton: document.getElementById('more'),
    sessionsPopover: document.getElementById('pop-sessions'),
    sessionsList: document.getElementById('pop-sessions-list'),
    shellPopover: document.getElementById('pop-shells'),
    morePopover: document.getElementById('pop-more'),
    detailsPopover: document.getElementById('pop-details'),
    detailsTitle: document.getElementById('details-title'),
    detailsClose: document.getElementById('details-close'),
    detailsBody: document.getElementById('details-body'),
    stage: document.getElementById('stage'),
    empty: document.getElementById('empty'),
    emptyTitle: document.getElementById('empty-title'),
    emptyHint: document.getElementById('empty-hint'),
    emptyNew: document.getElementById('empty-new'),
    banner: document.getElementById('banner'),
    bannerTitle: document.getElementById('banner-title'),
    bannerMsg: document.getElementById('banner-msg'),
    bannerAction: document.getElementById('banner-action'),
    bannerClose: document.getElementById('banner-close'),
    menu: document.getElementById('menu'),
  };

  const state = {
    locale: 'zh-CN',
    base: 'dark',
    tabs: new Map(),
    order: [],
    activeId: null,
    catalog: { shells: [], defaultShellId: null, helperAvailable: true },
    limits: { maxTabs: 8, scrollbackKiB: 256 },
    transport: { mode: 'unknown', eventSource: null, openedAt: 0, failures: 0 },
    ready: false,
    stateError: false,
    poll: { timer: null, running: false, cursors: {}, busy: false },
    cursors: {},
    menuTabId: null,
  };

  function t(key, ...args) {
    const table = STRINGS[state.locale] || STRINGS['zh-CN'];
    const value = table[key] !== undefined ? table[key] : STRINGS['zh-CN'][key];
    return typeof value === 'function' ? value(...args) : value;
  }

  function invoke(channel, payload) {
    if (!bridge || typeof bridge.invoke !== 'function') {
      return Promise.reject(new Error('pluginBridge is unavailable'));
    }
    return bridge.invoke(channel, payload || {});
  }

  function tunnel(channel, payload) {
    return invoke(channel, payload).then((reply) => {
      if (reply && reply.ok === false) {
        const error = new Error(reply.message || reply.error || 'request failed');
        error.code = reply.error;
        throw error;
      }
      return reply;
    });
  }

  function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  // ---------------------------------------------------------------- appearance

  function applyAppearance(appearance) {
    const base = appearance && appearance.base;
    state.base = base === 'light' || base === 'dark'
      ? base
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.base = state.base;
    if (appearance && typeof appearance.locale === 'string' && appearance.locale) {
      state.locale = appearance.locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
      document.documentElement.lang = state.locale;
    }
    updateTexts();
    for (const entry of state.tabs.values()) {
      if (entry.term) entry.term.options.theme = terminalTheme();
    }
  }

  function terminalTheme() {
    return state.base === 'light'
      ? {
        background: '#fbfbfc',
        foreground: '#1b1d21',
        cursor: '#1b1d21',
        selectionBackground: 'rgba(31, 95, 191, 0.25)',
      }
      : {
        background: '#14161a',
        foreground: '#e6e8ea',
        cursor: '#e6e8ea',
        selectionBackground: 'rgba(127, 180, 255, 0.30)',
      };
  }

  function labelMenuItems() {
    const labels = {
      copy: t('copy'),
      paste: t('paste'),
      clear: t('clear'),
      restart: t('restart'),
      details: t('details'),
      close: t('closeTerminal'),
    };
    for (const [key, text] of Object.entries(labels)) {
      for (const node of document.querySelectorAll(`[id$="-${key}"]`)) {
        if (node.classList && node.classList.contains('grow')) node.textContent = text;
      }
    }
  }

  function updateTexts() {
    dom.sessionButton.setAttribute('aria-label', t('session'));
    dom.newButton.setAttribute('aria-label', t('newTab'));
    dom.newButton.title = `${t('newTab')} (Ctrl+Shift+T)`;
    dom.newShellButton.setAttribute('aria-label', t('chooseShell'));
    dom.newShellButton.title = t('chooseShell');
    dom.moreButton.setAttribute('aria-label', t('more'));
    dom.moreButton.title = t('more');
    dom.sessionsPopover.setAttribute('aria-label', t('sessionList'));
    dom.shellPopover.setAttribute('aria-label', t('chooseShell'));
    dom.morePopover.setAttribute('aria-label', t('more'));
    dom.detailsPopover.setAttribute('aria-label', t('details'));
    dom.menu.setAttribute('aria-label', t('menuLabel'));
    dom.emptyNew.textContent = t('newTab');
    dom.emptyTitle.textContent = t('emptyTitle');
    dom.bannerClose.textContent = t('close');
    dom.detailsTitle.textContent = t('details');
    dom.detailsClose.textContent = t('close');
    labelMenuItems();
    renderEmptyHint();
    renderShellMenu();
    renderTabs();
    renderStatus();
  }

  function emptyHintText() {
    if (state.stateError) return t('emptyStateError');
    if (!state.ready) return t('emptyLoading');
    if (!state.catalog.helperAvailable) return `${t('emptyNoHelper')} ${describeCatalog()}`;
    if (!availableShells().length) return `${t('emptyNoShell')} ${describeCatalog()}`;
    return t('emptyHint');
  }

  /** What discovery actually returned, so the panel can explain itself. */
  function describeCatalog() {
    const shells = state.catalog.shells || [];
    const list = shells.length
      ? shells
        .map((shell) => `${shell.id}=${shell.available ? shell.path || 'ok' : shell.detail || 'unavailable'}`)
        .join('; ')
      : 'none';
    return t('emptyCatalog', list, state.catalog.helperPath || '?');
  }

  /** Single source of truth for the empty-state hint text. */
  function renderEmptyHint() {
    if (dom.emptyHint) dom.emptyHint.textContent = emptyHintText();
  }

  function availableShells() {
    return (state.catalog.shells || []).filter((shell) => shell.available);
  }

  // ---------------------------------------------------------------- terminals

  function ensureTerminal(tabId) {
    const entry = state.tabs.get(tabId);
    if (!entry) return null;
    if (entry.term) return entry;

    const host = document.createElement('div');
    host.className = 'term-host';
    host.dataset.tabId = tabId;
    host.dataset.active = 'false';
    dom.stage.appendChild(host);

    const term = new window.Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 4000,
      theme: terminalTheme(),
      windowsMode: false,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);

    entry.host = host;
    entry.term = term;
    entry.fit = fit;
    entry.queue = [];
    entry.queuedBytes = 0;
    entry.flushScheduled = false;
    entry.inputBuffer = [];
    entry.inputTimer = null;
    entry.lastSize = { cols: 0, rows: 0 };

    term.onData((data) => queueInput(entry, data));
    term.onResize(({ cols, rows }) => sendResize(entry, cols, rows));
    term.onSelectionChange(() => {
      /* selection only matters for the copy shortcuts */
    });
    term.attachCustomKeyEventHandler((event) => handleKey(event, entry));

    host.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY, tabId);
    });
    host.addEventListener('mouseup', () => closeMenu());

    if (tabId === state.activeId) {
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // ignored
        }
      });
    }
    return entry;
  }

  function handleKey(event, entry) {
    if (event.type !== 'keydown') return true;
    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;

    if (ctrl && shift && (event.key === 'C' || event.key === 'c')) {
      copySelection(entry);
      return false;
    }
    if (ctrl && !shift && !event.altKey && (event.key === 'C' || event.key === 'c') && entry.term.hasSelection()) {
      copySelection(entry);
      return false;
    }
    if (ctrl && shift && (event.key === 'V' || event.key === 'v')) {
      pasteClipboard(entry);
      return false;
    }
    if (ctrl && shift && (event.key === 'T' || event.key === 't')) {
      createTab();
      return false;
    }
    if (ctrl && shift && (event.key === 'W' || event.key === 'w')) {
      closeTab(entry.tabId);
      return false;
    }
    if (ctrl && shift && (event.key === 'R' || event.key === 'r')) {
      restartTab(entry.tabId);
      return false;
    }
    if (ctrl && shift && (event.key === 'K' || event.key === 'k')) {
      clearTab(entry.tabId);
      return false;
    }
    return true;
  }

  function queueInput(entry, data) {
    const bytes = new TextEncoder().encode(data);
    entry.inputBuffer.push(bytes);
    if (!entry.inputTimer) {
      entry.inputTimer = setTimeout(() => {
        entry.inputTimer = null;
        const buffer = entry.inputBuffer;
        entry.inputBuffer = [];
        if (buffer.length === 0) return;
        const total = buffer.reduce((sum, part) => sum + part.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const part of buffer) {
          merged.set(part, offset);
          offset += part.length;
        }
        tunnel('input', { tabId: entry.tabId, data: toBase64(merged) }).catch((error) => {
          showBanner('error', t('stateError'), error.message || String(error));
        });
      }, INPUT_COALESCE_MS);
    }
  }

  function sendResize(entry, cols, rows) {
    if (!cols || !rows) return;
    if (entry.lastSize.cols === cols && entry.lastSize.rows === rows) return;
    entry.lastSize = { cols, rows };
    tunnel('resize', { tabId: entry.tabId, cols, rows }).catch(() => {});
  }

  function enqueueOutput(entry, bytes) {
    entry.queue.push(bytes);
    entry.queuedBytes += bytes.length;
    while (entry.queuedBytes > MAX_QUEUED_BYTES && entry.queue.length > 1) {
      const dropped = entry.queue.shift();
      entry.queuedBytes -= dropped.length;
    }
    if (!entry.flushScheduled) {
      entry.flushScheduled = true;
      requestAnimationFrame(() => flushOutput(entry));
    }
  }

  function flushOutput(entry) {
    entry.flushScheduled = false;
    if (!entry.term) return;
    let budget = 512 * 1024;
    while (entry.queue.length > 0 && budget > 0) {
      const chunk = entry.queue.shift();
      entry.queuedBytes -= chunk.length;
      budget -= chunk.length;
      // Writing bytes (not text) lets xterm keep a multi-byte character that was
      // split across two console reads intact.
      entry.term.write(chunk);
    }
    if (entry.queue.length > 0) {
      entry.flushScheduled = true;
      requestAnimationFrame(() => flushOutput(entry));
    }
  }

  function activate(tabId) {
    if (!state.tabs.has(tabId)) return;
    state.activeId = tabId;
    const entry = ensureTerminal(tabId);
    for (const other of state.tabs.values()) {
      if (other.host) other.host.dataset.active = other.tabId === tabId ? 'true' : 'false';
      if (other.tabId === tabId && other.term) {
        requestAnimationFrame(() => {
          try {
            other.fit.fit();
            other.term.focus();
          } catch {
            // ignored
          }
        });
      }
    }
    renderTabs();
    renderStatus();
    if (entry && entry.term) entry.term.focus();
  }

  // ---------------------------------------------------------------- rendering

  function renderTabs() {
    renderSessionList();
  }

  /** Display names for the tabs: identical shells must stay tellable apart. */
  function tabTitles() {
    const names = new Map();
    const totals = new Map();
    for (const tabId of state.order) {
      const entry = state.tabs.get(tabId);
      const base = entry && entry.tab ? entry.tab.title : tabId;
      totals.set(base, (totals.get(base) || 0) + 1);
    }
    const seen = new Map();
    for (const tabId of state.order) {
      const entry = state.tabs.get(tabId);
      const base = entry && entry.tab ? entry.tab.title : tabId;
      const index = (seen.get(base) || 0) + 1;
      seen.set(base, index);
      names.set(tabId, (totals.get(base) || 0) > 1 ? `${base} #${index}` : base);
    }
    return names;
  }

  function renderSessionList() {
    const list = dom.sessionsList;
    const titles = tabTitles();
    list.textContent = '';
    if (!state.order.length) {
      list.appendChild(popoverNote(t('noTerminals')));
      return;
    }
    for (const tabId of state.order) {
      const entry = state.tabs.get(tabId);
      const tab = entry ? entry.tab : null;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', tabId === state.activeId ? 'true' : 'false');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.status = tab ? tab.status || 'starting' : 'starting';
      dot.setAttribute('aria-hidden', 'true');
      const grow = document.createElement('span');
      grow.className = 'grow';
      grow.textContent = titles.get(tabId) || tabId;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = tab ? statusLabel(tab.status) : '';
      const check = document.createElement('span');
      check.className = 'check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = tabId === state.activeId ? '✓' : '';
      item.append(dot, grow, sub, check);
      item.addEventListener('click', () => {
        const target = tabId;
        closePopover();
        activate(target);
        focusTerminal();
      });
      list.appendChild(item);
    }
  }

  function activeEntry() {
    return state.activeId ? state.tabs.get(state.activeId) : null;
  }

  /** One control row: the session button plus `+`, `▾` and `…`. */
  function renderStatus() {
    const entry = activeEntry();
    const tab = entry ? entry.tab : null;
    const titles = tabTitles();
    const maxTabs = state.limits.maxTabs || 8;

    dom.sessionButton.disabled = !tab;
    dom.sessionName.textContent = tab ? titles.get(tab.id) || tab.title : t('sessionEmpty');
    dom.sessionDot.dataset.status = tab ? tab.status || 'starting' : 'idle';
    dom.newButton.disabled = state.order.length >= maxTabs;
    dom.newShellButton.disabled = availableShells().length === 0;
    dom.empty.hidden = state.order.length > 0;
    renderEmptyHint();

    // An open menu must not go stale while frames keep arriving.
    if (currentPopover === dom.sessionsPopover) renderSessionList();
    else if (currentPopover === dom.morePopover) renderMoreMenu();
    else if (currentPopover === dom.detailsPopover) renderDetails();

    if (tab) updateBannerForTab(tab);
    else if (!state.stateError) hideBanner();
  }

  function statusLabel(status) {
    return {
      starting: t('stateStarting'),
      running: t('stateRunning'),
      exited: t('stateExited'),
      error: t('stateError'),
    }[status] || status || '';
  }

  function transportLabel() {
    if (state.transport.mode === 'sse') return t('transportSse');
    if (state.transport.mode === 'poll') return t('transportPoll');
    return t('transportUnknown');
  }

  function detailRow(key, value, title) {
    const row = document.createElement('div');
    row.className = 'detail-row';
    const name = document.createElement('span');
    name.className = 'detail-key';
    name.textContent = key;
    const val = document.createElement('span');
    val.className = 'detail-val';
    val.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    if (title) val.title = title;
    row.append(name, val);
    return row;
  }

  /** Shell path, startup directory, size and output channel — the old status bar. */
  function renderDetails() {
    const entry = activeEntry();
    const tab = entry ? entry.tab : null;
    dom.detailsBody.textContent = '';
    if (!tab) {
      dom.detailsBody.appendChild(popoverNote(t('detailNoTab')));
      return;
    }
    const titles = tabTitles();
    const rows = [
      ['detailName', titles.get(tab.id) || tab.title, ''],
      ['detailShell', `${tab.shellLabel}${tab.pid ? ` · PID ${tab.pid}` : ''}`, ''],
      ['detailPath', tab.shellPath, tab.shellPath],
      ['detailCwd', tab.cwd, tab.cwd],
      ['detailSize', `${tab.cols}×${tab.rows}`, ''],
      ['detailStatus', statusLabel(tab.status), ''],
      ['detailTransport', transportLabel(), ''],
    ];
    for (const [key, value, title] of rows) dom.detailsBody.appendChild(detailRow(t(key), value, title));
    const note = cwdNote(tab.cwdNote);
    if (note) dom.detailsBody.appendChild(popoverNote(note));
    dom.detailsBody.appendChild(popoverNote(t('detailCwdNote')));
  }

  function cwdNote(note) {
    if (note === 'no-project') return t('cwdNoProject');
    if (note === 'missing-directory') return t('cwdMissing');
    if (note === 'unc') return t('cwdUnc');
    return '';
  }

  function updateBannerForTab(tab) {
    if (tab.status === 'exited') {
      showBanner('error', t('exited', tab.exitCode === null ? '?' : tab.exitCode),
        `${tab.error ? `${tab.error}。` : ''}${t('restartHint')}`,
        { label: t('restart'), run: () => restartTab(tab.id) });
      return;
    }
    if (tab.status === 'error') {
      showBanner('error', t('stateError'), tab.error || '', null);
      return;
    }
    const note = cwdNote(tab.cwdNote);
    if (note) {
      showBanner('notice', note, tab.cwd || '', null);
      return;
    }
    hideBanner();
  }

  let bannerTimer = null;
  function showBanner(kind, title, message, action) {
    dom.banner.hidden = false;
    dom.banner.dataset.kind = kind;
    dom.bannerTitle.textContent = title || '';
    dom.bannerMsg.textContent = message || '';
    if (action) {
      dom.bannerAction.hidden = false;
      dom.bannerAction.textContent = action.label;
      dom.bannerAction.onclick = () => {
        hideBanner();
        action.run();
      };
    } else {
      dom.bannerAction.hidden = true;
      dom.bannerAction.onclick = null;
    }
    if (bannerTimer) clearTimeout(bannerTimer);
    if (kind === 'notice') {
      bannerTimer = setTimeout(() => hideBanner(), 6000);
    }
  }

  function hideBanner() {
    dom.banner.hidden = true;
    dom.bannerAction.hidden = true;
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  }

  // ---------------------------------------------------------------- popovers & menus

  // ---------------------------------------------------------------- popovers

  let currentPopover = null;
  let popoverAnchor = null;
  let focusBeforePopover = null;

  function popoverFor(name) {
    return {
      sessions: dom.sessionsPopover,
      shells: dom.shellPopover,
      more: dom.morePopover,
      details: dom.detailsPopover,
    }[name] || null;
  }

  function popoverItems(scope) {
    return [...scope.querySelectorAll('.item')].filter((node) => !node.disabled);
  }

  function popoverNote(text) {
    const note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = text;
    return note;
  }

  /** Place a popover near its anchor, clamped so it never leaves the panel. */
  function placePopover(el, anchor) {
    el.style.left = '0px';
    el.style.top = '0px';
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const anchorRect = anchor ? anchor.getBoundingClientRect() : { top: 0, bottom: 0, right: window.innerWidth };
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const left = Math.min(Math.max(margin, anchorRect.right - rect.width), maxLeft);
    let top = anchorRect.bottom + 4;
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, anchorRect.top - rect.height - 4);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function syncExpandedState() {
    const pairs = [
      [dom.sessionButton, dom.sessionsPopover],
      [dom.newShellButton, dom.shellPopover],
      [dom.moreButton, dom.morePopover],
    ];
    for (const [button, popover] of pairs) {
      if (!button || !popover) continue;
      if (currentPopover === popover) button.setAttribute('aria-expanded', 'true');
      else button.removeAttribute('aria-expanded');
    }
  }

  function showPopover(name, anchor) {
    const el = popoverFor(name);
    if (!el) return;
    if (name === 'sessions') renderSessionList();
    else if (name === 'shells') renderShellMenu();
    else if (name === 'more') renderMoreMenu();
    else if (name === 'details') renderDetails();

    if (currentPopover && currentPopover !== el) currentPopover.hidden = true;
    if (!currentPopover) focusBeforePopover = document.activeElement;
    currentPopover = el;
    popoverAnchor = anchor || anchorFor(name);
    el.hidden = false;
    syncExpandedState();
    placePopover(el, popoverAnchor);
    const first = popoverItems(el)[0] || el.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  function closePopover(restoreFocus) {
    if (!currentPopover) return;
    const el = currentPopover;
    const anchor = popoverAnchor;
    currentPopover = null;
    popoverAnchor = null;
    el.hidden = true;
    syncExpandedState();
    const target = restoreFocus ? anchor || focusBeforePopover : null;
    focusBeforePopover = null;
    if (target && typeof target.focus === 'function') target.focus();
  }

  function togglePopover(name) {
    const el = popoverFor(name);
    if (!el) return;
    if (currentPopover === el) closePopover(true);
    else showPopover(name, anchorFor(name));
  }

  function movePopoverFocus(direction) {
    if (!currentPopover) return;
    const items = popoverItems(currentPopover);
    if (!items.length) return;
    if (direction === 'first') {
      items[0].focus();
      return;
    }
    if (direction === 'last') {
      items[items.length - 1].focus();
      return;
    }
    const index = items.indexOf(document.activeElement);
    const next = index < 0 ? 0 : (index + direction + items.length) % items.length;
    items[next].focus();
  }

  function wireMenuActions(scope) {
    scope.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.action;
      if (action === 'details') {
        showPopover('details', dom.moreButton);
        return;
      }
      const tabId = state.menuTabId || state.activeId;
      const entry = tabId ? ensureTerminal(tabId) : null;
      closePopover();
      if (!entry) return;
      if (action === 'copy') copySelection(entry);
      else if (action === 'paste') pasteClipboard(entry);
      else if (action === 'clear') clearTab(tabId);
      else if (action === 'restart') restartTab(tabId);
      else if (action === 'close') closeTab(tabId);
    });
  }

  function renderMoreMenu() {
    const entry = activeEntry();
    const hasTab = Boolean(entry && entry.tab);
    for (const item of dom.morePopover.querySelectorAll('button[data-action]')) {
      if (item.dataset.action === 'details') continue;
      item.disabled = !hasTab;
    }
  }

  /** The terminal's own context menu, opened at a point inside the panel. */
  function openMenu(x, y, tabId) {
    closePopover();
    state.menuTabId = tabId;
    dom.menu.hidden = false;
    currentPopover = dom.menu;
    popoverAnchor = null;
    const rect = dom.menu.getBoundingClientRect();
    const left = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - rect.width - 6));
    const top = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - rect.height - 6));
    dom.menu.style.left = `${Math.round(left)}px`;
    dom.menu.style.top = `${Math.round(top)}px`;
    const first = popoverItems(dom.menu)[0];
    if (first) first.focus();
  }

  function closeMenu() {
    if (currentPopover === dom.menu) closePopover();
  }

  async function copySelection(entry) {
    const selection = entry.term ? entry.term.getSelection() : '';
    if (!selection) {
      showBanner('notice', t('copyEmpty'), '', null);
      return;
    }
    try {
      await tunnel('copyText', { text: selection });
      showBanner('notice', t('copied'), '', null);
    } catch (error) {
      showBanner('error', t('copyFailed'), error.message || String(error), null);
    }
  }

  async function pasteClipboard(entry) {
    try {
      const reply = await tunnel('pasteText');
      const text = reply && typeof reply.text === 'string' ? reply.text : '';
      if (text.length === 0) {
        showBanner('notice', t('pasteEmpty'), '', null);
        return;
      }
      entry.term.paste(text);
    } catch (error) {
      showBanner('error', t('pasteFailed'), error.message || String(error), null);
    }
  }

  // ---------------------------------------------------------------- transport

  function reportTransport(mode, message) {
    const previous = state.transport.mode;
    state.transport.mode = mode;
    renderStatus();
    if (mode === 'poll' && previous === 'sse' && message) {
      // The event feed went away but the terminal keeps working; say it once
      // instead of keeping a permanent status bar for it.
      showBanner('notice', `${t('transportSse')} → ${t('transportPoll')}`, message, null);
    }
    tunnel('report', { transport: mode, message: message || '' }).catch(() => {});
  }

  function startEvents(transport) {
    stopEvents();
    const tab = transport;
    const url = `http://127.0.0.1:${tab.port}${tab.path}?token=${encodeURIComponent(tab.token)}`;
    let opened = false;
    let source;
    try {
      source = new EventSource(url);
    } catch (error) {
      reportTransport('poll', `EventSource refused: ${error && error.message ? error.message : error}`);
      startPolling();
      return;
    }
    state.transport.eventSource = source;
    const timeout = setTimeout(() => {
      if (!opened) {
        reportTransport('poll', 'event stream did not open in time');
        stopEvents();
        startPolling();
      }
    }, SSE_OPEN_TIMEOUT_MS);

    source.onopen = () => {
      opened = true;
      clearTimeout(timeout);
      reportTransport('sse', '');
      void catchUp();
    };
    source.onmessage = (event) => {
      try {
        handleFrame(JSON.parse(event.data));
      } catch {
        // A malformed frame is ignored rather than breaking the stream.
      }
    };
    source.onerror = () => {
      if (!opened) {
        clearTimeout(timeout);
        reportTransport('poll', 'event stream error before open');
        stopEvents();
        startPolling();
        return;
      }
      state.transport.failures += 1;
      if (state.transport.failures >= 3) {
        reportTransport('poll', 'event stream kept failing');
        stopEvents();
        startPolling();
      }
    };
  }

  function stopEvents() {
    const source = state.transport.eventSource;
    state.transport.eventSource = null;
    if (source) {
      try {
        source.close();
      } catch {
        // ignored
      }
    }
  }

  function startPolling() {
    if (state.poll.timer) return;
    const tick = async () => {
      if (state.poll.running) return;
      state.poll.running = true;
      let received = 0;
      try {
        const reply = await tunnel('read', { cursors: state.cursors, maxBytes: 192 * 1024 });
        for (const [tabId, entry] of Object.entries(reply.tabs || {})) {
          for (const chunk of entry.chunks || []) {
            received += 1;
            deliverOutput(tabId, chunk.seq, chunk.data);
          }
          applyTabState(tabId, entry);
        }
      } catch (error) {
        state.poll.failures = (state.poll.failures || 0) + 1;
        if (state.poll.failures === 1) {
          showBanner('error', t('stateError'), error.message || String(error), null);
        }
      } finally {
        state.poll.running = false;
        state.poll.timer = setTimeout(tick, received > 0 ? POLL_BUSY_MS : POLL_IDLE_MS);
      }
    };
    state.poll.timer = setTimeout(tick, 0);
  }

  function stopPolling() {
    if (state.poll.timer) {
      clearTimeout(state.poll.timer);
      state.poll.timer = null;
    }
  }

  async function catchUp() {
    try {
      const reply = await tunnel('read', { cursors: state.cursors, maxBytes: 192 * 1024 });
      for (const [tabId, entry] of Object.entries(reply.tabs || {})) {
        for (const chunk of entry.chunks || []) {
          deliverOutput(tabId, chunk.seq, chunk.data);
        }
        applyTabState(tabId, entry);
      }
    } catch {
      // The stream itself will carry the next frames.
    }
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.kind === 'output') {
      deliverOutput(frame.tabId, frame.seq, frame.data);
      return;
    }
    if (frame.kind === 'status' && frame.tab) {
      applyTabSummary(frame.tab);
      return;
    }
    if (frame.kind === 'notice') {
      if (frame.code === 'OUTPUT_DROPPED') {
        showBanner('notice', t('dropped', frame.droppedBytes || 0), '', null);
      }
      return;
    }
    if (frame.kind === 'closed') {
      removeTabLocally(frame.tabId);
    }
  }

  function deliverOutput(tabId, seq, data) {
    if (!state.tabs.has(tabId)) return;
    if (Number.isFinite(seq)) {
      const cursor = state.cursors[tabId] || 0;
      if (seq <= cursor) return;
      state.cursors[tabId] = seq;
    }
    const entry = ensureTerminal(tabId);
    if (!entry) return;
    try {
      enqueueOutput(entry, fromBase64(data));
    } catch {
      // ignored
    }
  }

  function applyTabState(tabId, info) {
    const entry = state.tabs.get(tabId);
    if (!entry || !entry.tab) return;
    if (info.status) entry.tab.status = info.status;
    if (info.exitCode !== undefined) entry.tab.exitCode = info.exitCode;
    if (info.error !== undefined) entry.tab.error = info.error;
    if (info.cols) entry.tab.cols = info.cols;
    if (info.rows) entry.tab.rows = info.rows;
    if (Number.isFinite(info.seq)) state.cursors[tabId] = Math.max(state.cursors[tabId] || 0, info.seq);
    renderTabs();
    renderStatus();
  }

  function applyTabSummary(tab) {
    const entry = state.tabs.get(tab.id);
    if (!entry) return;
    entry.tab = tab;
    if (Number.isFinite(tab.cursor) && !Number.isFinite(state.cursors[tab.id])) {
      state.cursors[tab.id] = 0;
    }
    renderTabs();
    renderStatus();
  }

  function removeTabLocally(tabId) {
    const entry = state.tabs.get(tabId);
    if (entry && entry.term) {
      try {
        entry.term.dispose();
      } catch {
        // ignored
      }
    }
    if (entry && entry.host) entry.host.remove();
    state.tabs.delete(tabId);
    state.order = state.order.filter((id) => id !== tabId);
    delete state.cursors[tabId];
    if (state.activeId === tabId) {
      state.activeId = state.order[0] || null;
      if (state.activeId) activate(state.activeId);
    }
    renderTabs();
    renderStatus();
  }

  // ---------------------------------------------------------------- snapshot

  function applySnapshot(snapshot) {
    state.catalog = snapshot.shells || state.catalog;
    state.limits = snapshot.limits || state.limits;
    state.ready = true;
    state.stateError = false;
    renderShellMenu();

    const seen = new Set();
    for (const tab of snapshot.tabs || []) {
      seen.add(tab.id);
      const entry = state.tabs.get(tab.id) || { tabId: tab.id, tab: null, queue: [], queuedBytes: 0 };
      entry.tab = tab;
      state.tabs.set(tab.id, entry);
      if (!state.order.includes(tab.id)) state.order.push(tab.id);
      if (!Number.isFinite(state.cursors[tab.id])) state.cursors[tab.id] = 0;
    }
    for (const tabId of [...state.order]) {
      if (!seen.has(tabId)) removeTabLocally(tabId);
    }
    if (!state.activeId || !state.tabs.has(state.activeId)) {
      state.activeId = state.order[0] || null;
    }
    if (state.activeId) activate(state.activeId);
    renderTabs();
    renderStatus();
  }

  function renderShellMenu() {
    const shells = availableShells();
    const maxTabs = state.limits.maxTabs || 8;
    const atLimit = state.order.length >= maxTabs;
    dom.shellPopover.textContent = '';
    if (!shells.length) {
      dom.shellPopover.appendChild(popoverNote(emptyHintText()));
      return;
    }
    if (atLimit) dom.shellPopover.appendChild(popoverNote(t('shellLimit', maxTabs)));
    const list = document.createElement('div');
    list.className = 'pop-scroll';
    for (const shell of shells) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'item';
      item.setAttribute('role', 'menuitem');
      item.disabled = atLimit;
      const grow = document.createElement('span');
      grow.className = 'grow';
      grow.textContent = shell.label;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = shell.path || '';
      sub.title = shell.path || '';
      item.append(grow, sub);
      item.addEventListener('click', () => {
        const picked = shell.id;
        closePopover();
        void createTab(picked);
      });
      list.appendChild(item);
    }
    dom.shellPopover.appendChild(list);
  }

  // ---------------------------------------------------------------- actions

  async function refreshSnapshot() {
    const snapshot = await tunnel('state', { needTransport: state.transport.mode === 'unknown' });
    applySnapshot(snapshot);
    return snapshot;
  }

  async function createTab(shellId) {
    try {
      const wanted = shellId || state.catalog.defaultShellId || undefined;
      const reply = await tunnel('create', { shellId: wanted, cols: 0, rows: 0 });
      applySnapshot(reply.state);
      if (reply.tab) activate(reply.tab.id);
      if (state.transport.mode !== 'sse') await catchUp();
    } catch (error) {
      showBanner('error', t('stateError'), error.message || String(error), null);
    }
  }

  async function closeTab(tabId) {
    try {
      const reply = await tunnel('close', { tabId });
      if (reply.state) applySnapshot(reply.state);
      renderStatus();
    } catch (error) {
      showBanner('error', t('stateError'), error.message || String(error), null);
    }
  }

  async function restartTab(tabId) {
    try {
      hideBanner();
      const entry = state.tabs.get(tabId);
      if (entry && entry.term) entry.term.reset();
      state.cursors[tabId] = 0;
      const reply = await tunnel('restart', { tabId });
      if (reply.state) applySnapshot(reply.state);
      if (state.transport.mode !== 'sse') await catchUp();
    } catch (error) {
      showBanner('error', t('stateError'), error.message || String(error), null);
    }
  }

  async function clearTab(tabId) {
    const entry = state.tabs.get(tabId);
    if (entry && entry.term) entry.term.reset();
    try {
      await tunnel('clear', { tabId });
    } catch {
      // Clearing the screen locally already did the visible half.
    }
  }

  function fitActive() {
    const entry = activeEntry();
    if (!entry || !entry.term) return;
    try {
      entry.fit.fit();
    } catch {
      // ignored
    }
  }

  /** After switching or creating a terminal the keyboard belongs to it again. */
  function focusTerminal() {
    const entry = activeEntry();
    if (!entry || !entry.term) return;
    try {
      entry.term.focus();
    } catch {
      // ignored
    }
  }

  function anchorFor(name) {
    if (name === 'sessions') return dom.sessionButton;
    if (name === 'shells') return dom.newShellButton;
    return dom.moreButton;
  }

  function wireUi() {
    dom.sessionButton.addEventListener('click', () => togglePopover('sessions'));
    dom.newButton.addEventListener('click', () => {
      closePopover();
      void createTab();
    });
    dom.newShellButton.addEventListener('click', () => togglePopover('shells'));
    dom.moreButton.addEventListener('click', () => togglePopover('more'));
    dom.emptyNew.addEventListener('click', () => void createTab());
    dom.bannerClose.addEventListener('click', () => hideBanner());
    dom.detailsClose.addEventListener('click', () => closePopover(true));

    wireMenuActions(dom.morePopover);
    wireMenuActions(dom.menu);

    window.addEventListener(
      'mousedown',
      (event) => {
        if (!currentPopover) return;
        if (currentPopover.contains(event.target)) return;
        if (event.target === dom.sessionButton || event.target === dom.newShellButton || event.target === dom.moreButton) return;
        closePopover();
      },
      true,
    );
    window.addEventListener('blur', () => closePopover());
    window.addEventListener('resize', () => {
      closePopover();
      fitActive();
    });
    document.addEventListener('keydown', (event) => {
      if (!currentPopover) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopover(true);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        movePopoverFocus(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        movePopoverFocus(event.key === 'Home' ? 'first' : 'last');
        return;
      }
      if (event.key === 'Tab') closePopover();
    });

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          closePopover();
          fitActive();
        });
      });
      observer.observe(dom.stage);
    }
    window.addEventListener('pagehide', () => {
      stopEvents();
      stopPolling();
    });
  }

  async function boot() {
    applyAppearance(null);
    wireUi();
    if (bridge && typeof bridge.on === 'function') {
      bridge.on('appearance:changed', applyAppearance);
    }
    try {
      applyAppearance(await invoke('app.getAppearance'));
    } catch {
      // Appearance is cosmetic; a failure must not stop the terminal.
    }

    await connect();
  }

  /**
   * One state exchange with the plugin. Retryable from the banner: a failed
   * first attempt (for example while the plugin is still starting) must not
   * leave the panel stuck on an empty screen claiming there are no shells.
   */
  async function connect() {
    let snapshot = null;
    try {
      snapshot = await refreshSnapshot();
    } catch (error) {
      state.stateError = true;
      renderEmptyHint();
      showBanner('error', t('stateError'), error.message || String(error), {
        label: t('retry'),
        run: () => { void connect(); },
      });
      return;
    }
    hideBanner();

    if (state.transport.mode === 'unknown') {
      if (snapshot.transport && snapshot.transport.port) {
        startEvents(snapshot.transport);
      } else {
        reportTransport('poll', 'no loopback endpoint');
        startPolling();
      }
    }

    if (state.order.length === 0 && state.catalog.helperAvailable && availableShells().length > 0) {
      await createTab();
    }
    renderStatus();
  }

  void boot();
})();
