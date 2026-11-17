/* Luck-Mail 主界面 — 前端交互（假数据演示，后端未接线） */
/* 聚合分类按上传文件：所有收件箱 / 所有未读 / 所有草稿 / 所有已发送 / 所有已删除 */
/* 邮箱列表平铺。 */
(function () {
    'use strict';

    var ACCOUNTS = [
        { email: 'demo1@163.com', unread: 0 },
        { email: 'demo2@163.com', unread: 1 },
        { email: 'demo3@163.com', unread: 0 },
        { email: 'demo4@163.com', unread: 0 }
    ];

    var WH_BODY = '<p>White House News — Monday, November 16, 2026 (checked ~5:00 AM America/Los_Angeles)</p>'
        + '<p class="font-bold mt-6 mb-2 text-slate-800">1. Trump threatens renewed strikes on Iran; says no formal Iran deal needed</p>'
        + '<p>President Trump said at a White House press conference alongside Qatari Prime Minister Sheikh Mohammed bin Abdulrahman Al Thani that the United States does not need a formal diplomatic agreement with Iran, and warned he would not hesitate to resume military strikes if necessary amid ongoing violations of the June 14-point truce memorandum, while the Strait of Hormuz remains blocked.</p>'
        + '<p class="font-bold mt-6 mb-2 text-slate-800">2. U.S. envoys head to Moscow and Dublin after Abu Dhabi trilateral talks</p>'
        + '<p>U.S. envoys Jared Kushner and Steve Witkoff concluded two days of trilateral negotiations in Abu Dhabi and are traveling to Moscow to meet Russian President Vladimir Putin and to Dublin to brief Ukrainian President Volodymyr Zelenskyy on the peace negotiations.</p>'
        + '<p class="font-bold mt-6 mb-2 text-slate-800">3. White House Counsel\'s warning to incoming Oversight Chair draws new response</p>'
        + '<p>White House Counsel William Scharf\'s letter to Rep. Robert Garcia, the incoming House Oversight Committee chair, warned that congressional oversight "may cross the line into blatant criminality." In a new Bloomberg Law column published Nov 16, Noah Feldman argues Congress has every right to investigate the President.</p>'
        + '<hr class="my-6 border-blue-50">'
        + '<p class="text-xs text-slate-500 bg-blue-50/50 p-4 rounded-lg border border-blue-100/50"><strong>Check note:</strong> The White House official website (whitehouse.gov/news) was checked at ~5:00 AM America/Los Angeles on Nov 16, 2026; its latest post remains the Nov 15 ICYMI on Secretary Duffy\'s ground stop response, unchanged since the 4:00 AM check. The next check will run at 9:00 AM America/Los_Angeles.</p>';

    var MESSAGES = [
        { id: 'm1', account: 'demo3@163.com', folder: 'inbox', from: 'demo@example.com', to: 'demo3@163.com', subject: 'White House News - Nov 16, 2026 5:00 AM', snippet: 'President Trump said at a White House press conference alongside Qatari Prime Minister Sheikh Mohammed...', body: WH_BODY, time: '20:59', date: '2026-11-16 20:59', unread: false },
        { id: 'm2', account: 'demo2@163.com', folder: 'inbox', from: 'demo@example.com', to: 'demo2@163.com', subject: '白宫新闻汇总 - 2026-11-16', snippet: '您好，以下是白宫最新新闻汇总 (2026-11-16)。有关最新的地缘政治谈判情况...', body: '<p>您好，以下是白宫最新新闻汇总 (2026-11-16)。</p><p>有关最新的地缘政治谈判情况，请见正文。</p>', time: '04:35', date: '2026-11-16 04:35', unread: true },
        { id: 'm3', account: 'demo1@163.com', folder: 'inbox', from: 'demo@example.com', to: 'demo1@163.com', subject: 'White House News — Monday, Nov 16', snippet: 'U.S. envoys Jared Kushner and Steve Witkoff concluded two days of trilateral negotiations in Abu Dhabi...', body: '<p>U.S. envoys Jared Kushner and Steve Witkoff concluded two days of trilateral negotiations in Abu Dhabi and are traveling to Moscow to meet Russian President Vladimir Putin.</p>', time: '昨天', date: '2026-11-15 21:10', unread: false },
        { id: 'm4', account: 'demo3@163.com', folder: 'sent', from: 'demo3@163.com', to: 'demo1@163.com', subject: '回复：sdfsaf', snippet: 'sdfsaf', body: '<p>sdfsaf</p>', time: '19:55', date: '2026-11-16 19:55', unread: false },
        { id: 'm5', account: 'demo3@163.com', folder: 'sent', from: 'demo3@163.com', to: 'demo1@163.com', subject: 'sdfasfasdf', snippet: 'sdfasfasdf', body: '<p>sdfasfasdf</p>', time: '19:53', date: '2026-11-16 19:53', unread: false },
        { id: 'm6', account: 'demo1@163.com', folder: 'drafts', from: 'demo1@163.com', to: '', subject: '（无主题）', snippet: '草稿尚未写完...', body: '<p>草稿尚未写完...</p>', time: '18:20', date: '2026-11-16 18:20', unread: false },
        { id: 'm7', account: 'demo2@163.com', folder: 'trash', from: 'demo@example.com', to: 'demo2@163.com', subject: '旧通知（已删除）', snippet: '这封邮件已被删除，放在已删除文件夹里。', body: '<p>这封邮件已被删除，放在已删除文件夹里。</p>', time: '11:02', date: '2026-11-16 11:02', unread: false },
        { id: 'm8', account: 'demo1@163.com', folder: 'spam', from: 'promo@spam-example.com', to: 'demo1@163.com', subject: '【演示】限时优惠（垃圾邮件示例）', snippet: '这是一封演示用的垃圾邮件示例，验证垃圾邮件文件夹可正常打开。', body: '<p>这是一封演示用的垃圾邮件示例。</p>', time: '09:12', date: '2026-11-16 09:12', unread: false }
    ];

    var currentNav = 'all-inbox';
    var currentLabel = '所有收件箱';
    var currentMsgId = 'm1';
    var searchQuery = '';

    var $ = function (sel) { return document.querySelector(sel); };
    var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function isMobile() { return window.innerWidth < 768; }
    function setMView(v) { document.body.setAttribute('data-mview', v); }

    function filterMessages() {
        var q = searchQuery.trim().toLowerCase();
        var list = MESSAGES.filter(function (m) {
            var ok = false;
            if (currentNav === 'all-inbox') ok = m.folder === 'inbox';
            else if (currentNav === 'all-unread') ok = m.folder === 'inbox' && m.unread;
            else if (currentNav === 'all-drafts') ok = m.folder === 'drafts';
            else if (currentNav === 'all-sent') ok = m.folder === 'sent';
            else if (currentNav === 'all-trash') ok = m.folder === 'trash';
            else if (currentNav.indexOf('inbox-') === 0) ok = m.folder === 'inbox' && m.account === currentNav.slice(6);
            else if (currentNav.indexOf('acct-') === 0) ok = m.account === currentNav.slice(5) && m.folder === 'inbox';
            else if (currentNav.indexOf('f|') === 0) { var fp = currentNav.split('|'); ok = m.account === fp[1] && m.folder === fp[2]; }
            else ok = m.folder === 'inbox';
            if (!ok) return false;
            if (!q) return true;
            return (m.subject + ' ' + m.from + ' ' + m.snippet).toLowerCase().indexOf(q) !== -1;
        });
        return list;
    }

    function renderList() {
        var host = $('#message-list');
        var list = filterMessages();
        $('#list-title').textContent = currentLabel;
        var mt = $('#mobile-list-title');
        if (mt) mt.textContent = currentLabel;
        if (!list.length) {
            host.innerHTML = '<div class="p-6 text-center text-xs text-slate-400">这里没有邮件</div>';
            return;
        }
        host.innerHTML = list.map(function (m) {
            var active = m.id === currentMsgId;
            var cls = active
                ? 'relative bg-blue-50 border-l-4 border-blue-400 p-3 cursor-pointer border-b border-blue-100/50'
                : 'relative p-3 cursor-pointer border-b border-slate-50 hover:bg-blue-50/50 transition-colors';
            var avCls = active ? 'bg-blue-200 text-blue-700' : 'bg-blue-100 text-blue-500';
            var fromCls = active ? 'font-bold text-blue-900' : (m.unread ? 'font-bold text-slate-800' : 'font-medium text-slate-700');
            var subjCls = active ? 'font-bold text-slate-800' : (m.unread ? 'font-bold text-slate-800' : 'font-medium text-slate-700');
            var timeCls = active ? 'text-blue-500' : 'text-slate-400';
            return '<div class="' + cls + '" data-msg="' + m.id + '">'
                + '<div class="flex items-center justify-between mb-1">'
                + '<div class="flex items-center gap-2">'
                + '<div class="w-6 h-6 rounded-full ' + avCls + ' flex items-center justify-center text-xs font-bold">' + esc((m.from || '?')[0].toUpperCase()) + '</div>'
                + '<span class="' + fromCls + ' truncate w-32">' + esc(m.from) + '</span>'
                + '</div><span class="text-[10px] ' + timeCls + '">' + esc(m.time) + '</span></div>'
                + '<div class="text-sm ' + subjCls + ' truncate mb-1">' + esc(m.subject) + '</div>'
                + '<div class="text-xs text-slate-500 line-clamp-2 leading-relaxed">' + esc(m.snippet) + '</div>'
                + '</div>';
        }).join('');
        $$('#message-list [data-msg]').forEach(function (el) {
            el.addEventListener('click', function () { openMessage(el.getAttribute('data-msg')); });
        });
    }

    function renderReading() {
        var host = $('#reading-body');
        var m = null;
        for (var i = 0; i < MESSAGES.length; i++) {
            if (MESSAGES[i].id === currentMsgId) { m = MESSAGES[i]; break; }
        }
        if (!m) {
            host.innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 text-sm">在此查看列表中选中的邮件。</div>';
            return;
        }
        host.innerHTML = '<div class="mb-8">'
            + '<h1 class="text-2xl font-bold text-slate-800 mb-6">' + esc(m.subject) + '</h1>'
            + '<div class="flex items-start justify-between">'
            + '<div class="flex items-center gap-3">'
            + '<div class="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-lg font-bold">' + esc((m.from || '?')[0].toUpperCase()) + '</div>'
            + '<div><div class="flex items-center gap-2"><span class="font-bold text-slate-800 text-base">' + esc(m.from) + '</span></div>'
            + '<div class="text-xs text-slate-500 mt-0.5">发至 <span class="text-blue-500">' + esc(m.to || '') + '</span></div></div></div>'
            + '<div class="text-xs text-slate-400 mt-1 flex flex-col items-end"><span>' + esc(m.date) + '</span></div>'
            + '</div></div>'
            + '<div class="text-sm text-slate-700 leading-relaxed font-sans">' + m.body + '</div>';
    }

    function openMessage(id) {
        currentMsgId = id;
        for (var i = 0; i < MESSAGES.length; i++) {
            if (MESSAGES[i].id === id) MESSAGES[i].unread = false;
        }
        renderList();
        renderReading();
        if (isMobile()) setMView('read');
    }

    function setNav(nav, label) {
        currentNav = nav;
        currentLabel = label;
        searchQuery = '';
        var si = $('#search-input');
        if (si) si.value = '';
        var list = filterMessages();
        currentMsgId = list.length ? list[0].id : null;
        renderList();
        renderReading();
        if (isMobile()) setMView('list');
    }

    function bindNav() {
        $$('[data-nav]').forEach(function (el) {
            el.addEventListener('click', function () {
                $$('[data-nav]').forEach(function (x) {
                    x.classList.remove('bg-blue-100', 'text-blue-700', 'font-medium');
                });
                el.classList.add('bg-blue-100', 'text-blue-700', 'font-medium');
                setNav(el.getAttribute('data-nav'), el.getAttribute('data-nav-label') || el.textContent.trim());
            });
        });
    }

    function bindSearch() {
        var si = $('#search-input');
        if (!si) return;
        si.addEventListener('input', function () {
            searchQuery = si.value;
            renderList();
        });
    }

    function bindCompose() {
        var modal = $('#compose-modal');
        var open = function () { modal.classList.remove('hidden'); modal.classList.add('flex'); };
        var close = function () { modal.classList.add('hidden'); modal.classList.remove('flex'); };
        var cb = $('#btn-compose');
        if (cb) cb.addEventListener('click', open);
        $$('[data-close-compose]').forEach(function (b) { b.addEventListener('click', close); });
        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        var send = $('[data-send-compose]');
        if (send) send.addEventListener('click', function () {
            var to = $('#compose-to').value.trim();
            var subj = $('#compose-subject').value.trim() || '（无主题）';
            var body = $('#compose-body').value.trim();
            MESSAGES.unshift({ id: 'm' + Date.now(), account: 'demo3@163.com', folder: 'sent', from: 'demo3@163.com', to: to, subject: subj, snippet: body.slice(0, 60), body: '<p>' + esc(body).replace(/\n/g, '<br>') + '</p>', time: '刚刚', date: '刚刚', unread: false });
            $('#compose-to').value = ''; $('#compose-subject').value = ''; $('#compose-body').value = '';
            close();
            setNav('all-sent', '所有已发送');
        });
        var draft = $('[data-save-draft]');
        if (draft) draft.addEventListener('click', function () {
            var subj = $('#compose-subject').value.trim() || '（无主题）';
            var body = $('#compose-body').value.trim();
            MESSAGES.unshift({ id: 'm' + Date.now(), account: 'demo3@163.com', folder: 'drafts', from: 'demo3@163.com', to: $('#compose-to').value.trim(), subject: subj, snippet: body.slice(0, 60), body: '<p>' + esc(body).replace(/\n/g, '<br>') + '</p>', time: '刚刚', date: '刚刚', unread: false });
            close();
            setNav('all-drafts', '所有草稿');
        });
    }

    function bindReadingActions() {
        $$('#reading [data-act]').forEach(function (b) {
            b.addEventListener('click', function () {
                var act = b.getAttribute('data-act');
                if (act === 'delete' && currentMsgId) {
                    for (var i = 0; i < MESSAGES.length; i++) {
                        if (MESSAGES[i].id === currentMsgId) MESSAGES[i].folder = 'trash';
                    }
                    var list = filterMessages();
                    currentMsgId = list.length ? list[0].id : null;
                    renderList(); renderReading();
                } else if (act === 'reply' || act === 'forward') {
                    var m = null;
                    for (var j = 0; j < MESSAGES.length; j++) {
                        if (MESSAGES[j].id === currentMsgId) { m = MESSAGES[j]; break; }
                    }
                    if (m) {
                        $('#compose-to').value = act === 'forward' ? '' : m.from;
                        $('#compose-subject').value = (act === 'forward' ? '转发：' : '回复：') + m.subject;
                        $('#compose-body').value = '';
                        var modal = $('#compose-modal');
                        modal.classList.remove('hidden'); modal.classList.add('flex');
                    }
                }
            });
        });
        var rf = $('#btn-refresh');
        if (rf) rf.addEventListener('click', function () { renderList(); renderReading(); });
        /* 全部刷新：刷新全部邮箱（演示版：转圈 + 重渲染；接线后改为调全部账号的刷新接口） */
        var rfa = $('#btn-refresh-all');
        if (rfa) rfa.addEventListener('click', function () {
            var icon = rfa.querySelector('i');
            if (icon) icon.classList.add('fa-spin');
            renderList(); renderReading();
            setTimeout(function () { if (icon) icon.classList.remove('fa-spin'); }, 900);
        });
    }

    function bindMobile() {
        $$('[data-mback]').forEach(function (b) {
            b.addEventListener('click', function () {
                setMView(b.getAttribute('data-mback'));
            });
        });
        window.addEventListener('resize', function () {
            if (!isMobile()) setMView('nav');
        });
    }

    function bindSys() {
        $$('[data-act="settings"], [data-act="change-password"], [data-act="logout"]').forEach(function (b) {
            b.addEventListener('click', function () {
                /* 演示版：系统操作尚未接线 */
            });
        });
    }

    /* 邮箱文件夹（163 标准 5 个真实文件夹；假数据。接线时把 FOLDERS 换成 IMAP LIST 返回的真实文件夹） */
    var FOLDERS = [
        { key: 'inbox', label: '收件箱', icon: 'fa-solid fa-inbox' },
        { key: 'drafts', label: '草稿箱', icon: 'fa-regular fa-file-lines' },
        { key: 'sent', label: '已发送', icon: 'fa-regular fa-paper-plane' },
        { key: 'trash', label: '已删除', icon: 'fa-regular fa-trash-can' },
        { key: 'spam', label: '垃圾邮件', icon: 'fa-solid fa-ban' }
    ];

    function renderAcctFolders() {
        $$('#account-list .acct-item').forEach(function (item) {
            var acct = item.getAttribute('data-acct');
            var host = item.querySelector('.acct-folders');
            if (!host || !acct) return;
            host.innerHTML = FOLDERS.map(function (f) {
                return '<div class="flex items-center gap-2 px-2 py-1 text-slate-600 hover:bg-blue-100/50 rounded cursor-pointer" data-nav="f|' + acct + '|' + f.key + '" data-nav-label="' + esc(acct) + ' - ' + f.label + '">'
                    + '<i class="' + f.icon + ' w-3 text-center text-slate-400 text-xs"></i>'
                    + '<span class="truncate text-xs">' + f.label + '</span></div>';
            }).join('');
        });
    }

    function bindAcctToggle() {
        $$('[data-acct-toggle]').forEach(function (row) {
            row.addEventListener('click', function (e) {
                e.stopPropagation();
                var item = row.closest('.acct-item');
                if (item) item.classList.toggle('expanded');
            });
        });
    }

    /* 主题配色（localStorage 记忆，默认蓝色） */
    var THEMES = ['blue', 'green', 'red', 'purple', 'orange', 'teal'];
    var THEME_KEY = 'luck-mail-theme';

    function currentTheme() {
        var t = document.body.getAttribute('data-theme') || 'blue';
        return THEMES.indexOf(t) === -1 ? 'blue' : t;
    }

    function applyTheme(name) {
        if (THEMES.indexOf(name) === -1) name = 'blue';
        document.body.setAttribute('data-theme', name);
        try { localStorage.setItem(THEME_KEY, name); } catch (e) {}
        $$('#theme-panel [data-theme-pick]').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-theme-pick') === name);
        });
    }

    function bindTheme() {
        var panel = $('#theme-panel');
        if (!panel) return;
        var open = false;
        var positionPanel = function (anchor) {
            panel.classList.remove('hidden');
            var pw = panel.offsetWidth, ph = panel.offsetHeight;
            var r = anchor.getBoundingClientRect();
            var left = r.right + 8, top = r.bottom - ph;
            if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
            if (left < 8) left = Math.max(8, (window.innerWidth - pw) / 2);
            if (top < 8) top = 8;
            if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        };
        var close = function () { panel.classList.add('hidden'); open = false; };
        $$('[data-theme-btn]').forEach(function (b) {
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                if (open) { close(); return; }
                positionPanel(b);
                open = true;
            });
        });
        $$('#theme-panel [data-theme-pick]').forEach(function (el) {
            el.addEventListener('click', function (e) {
                e.stopPropagation();
                applyTheme(el.getAttribute('data-theme-pick'));
                close();
            });
        });
        document.addEventListener('click', function (e) {
            if (open && !panel.contains(e.target)) close();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) close(); });
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
        if (saved && THEMES.indexOf(saved) !== -1) document.body.setAttribute('data-theme', saved);
        $$('#theme-panel [data-theme-pick]').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-theme-pick') === currentTheme());
        });
    }

    renderAcctFolders();
    bindNav();
    bindSearch();
    bindCompose();
    bindReadingActions();
    bindMobile();
    bindSys();
    bindAcctToggle();
    bindTheme();
    renderList();
    renderReading();
})();
