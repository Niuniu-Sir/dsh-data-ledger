// 数据管理 · client 半：右侧面板（纯 DOM、零框架、无第三方依赖）
// 契约：window.__ModuleLoader__.load 工厂返回 { name, inject, apply }
// 配色：运行时从 body 直读官方 CSS 变量当前值（浅色=白底黑字 / 深色=深底白字），
// 主题切换（body[data-ds-dark-theme]）经 MutationObserver 即时跟随。
window.__ModuleLoader__.load({
  id: "dsh-data-ledger",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const name = "dsh-data-ledger";
    const inject = [];
    const API = "/api/data-ledger";
    const LS_PREFIX_ORIGIN = [
      ["dsh-better-sidebar", "插件 dsh-better-sidebar · 布局/偏好"],
      ["dsh-milestone", "插件 dsh-milestone（已卸载）· 书签残留"],
      ["track", "插件 dsh-track · 面板状态"],
      ["balance", "插件 dsh-balance-meter · 偏好"],
      ["dsh.", "官方 · 界面状态"],
      ["dsh-", "官方 · 界面状态"],
    ];

    // ---- 主题桥：从 body 读官方变量，就浅色/深色两种 ----
    const FALLBACK = {
      bg: "#ffffff", text: "#111827", secondary: "#4b5563", tertiary: "#9ca3af",
      dimmed: "#6b7280", border: "rgba(128,128,128,.25)", hover: "#f9fafb",
      accent: "#fffbeb", brand: "#4338ca", danger: "#b91c1c", dangerBg: "#fef2f2",
    };
    let palette = { ...FALLBACK };
    function readPalette() {
      try {
        const cs = getComputedStyle(document.body);
        const pick = (n, fb) => { const v = cs.getPropertyValue(n).trim(); return v || fb; };
        palette = {
          bg: pick("--dsw-alias-bg-base", FALLBACK.bg),
          text: pick("--dsw-alias-label-primary", FALLBACK.text),
          secondary: pick("--dsw-alias-label-secondary", FALLBACK.secondary),
          tertiary: pick("--dsw-alias-label-tertiary", FALLBACK.tertiary),
          dimmed: pick("--dsw-alias-label-dimmed", FALLBACK.dimmed),
          border: pick("--dsw-alias-border-l", FALLBACK.border),
          hover: pick("--dsw-alias-interactive-bg-hover", FALLBACK.hover),
          accent: pick("--dsw-alias-interactive-bg-hover-accent", FALLBACK.accent),
          brand: pick("--dsw-alias-brand-text", FALLBACK.brand),
          danger: pick("--dsw-alias-state-error-primary", FALLBACK.danger),
          dangerBg: pick("--dsw-alias-interactive-bg-hover-danger", FALLBACK.dangerBg),
        };
      } catch { palette = { ...FALLBACK }; }
    }
    const C = () => palette;

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const fmtSize = (bytes) => {
      if (bytes === null || bytes === undefined) return "—";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
      return (bytes / 1073741824).toFixed(2) + " GB";
    };
    const fmtTime = (ms) => {
      if (!ms) return "—";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const trunc = (s, n = 12) => {
      s = String(s ?? "");
      return s.length > n ? s.slice(0, n) + "…" : s;
    };

    async function api(path, opts) {
      const r = await fetch(API + path, opts ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opts) } : undefined);
      return await r.json();
    }

    let panel = null, btn = null, contentEl = null, refreshTimer = null, refreshSeconds = 20, trashDays = 30;

    function toast(msg) {
      const t = document.createElement("div");
      t.textContent = msg;
      Object.assign(t.style, {
        position: "fixed", bottom: "80px", right: "420px", zIndex: "2147483000",
        background: "#1f2937", color: "#fff", padding: "8px 14px", borderRadius: "8px",
        fontSize: "13px", boxShadow: "0 4px 12px rgba(0,0,0,.25)", transition: "opacity .3s",
      });
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 350); }, 2200);
    }

    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); toast("已复制路径"); }
      catch {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); toast("已复制路径"); } catch { toast("复制失败"); }
        ta.remove();
      }
    }

    function actionBtn(label, onClick, danger) {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        border: "1px solid " + C().border, background: danger ? C().dangerBg : C().hover,
        color: danger ? C().danger : C().secondary, borderRadius: "6px", padding: "2px 8px",
        fontSize: "12px", cursor: "pointer", marginRight: "4px",
      });
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return b;
    }

    function lsOrigin(key) {
      for (const [prefix, label] of LS_PREFIX_ORIGIN) if (key.startsWith(prefix)) return label;
      return "未知来源（待认领）";
    }

    async function doDelete(item) {
      if (!item.deletable || !item.path) return;
      if (!window.confirm(`删除「${item.name}」（${fmtSize(item.size)}）？\n将移入回收站，${trashDays} 天内可恢复。`)) return;
      const r = await api("/delete", { path: item.path });
      toast(r.ok ? "已移入回收站" : "删除失败: " + (r.error || ""));
      refresh();
    }
    async function doRestore(item) {
      if (!window.confirm(`恢复「${item.name}」到原位置？`)) return;
      const r = await api("/restore", { path: item.path });
      toast(r.ok ? "已恢复" : "恢复失败: " + (r.error || ""));
      refresh();
    }
    async function doPurge(item) {
      if (!window.confirm(`【真删】「${item.name}」将无法恢复，确定？`)) return;
      if (!window.confirm("再次确认：永久删除该回收站条目？")) return;
      const r = await api("/purge", { path: item.path });
      toast(r.ok ? "已彻底删除" : "删除失败: " + (r.error || ""));
      refresh();
    }
    async function doOpen(item) {
      if (!item.path) return;
      const r = await api("/open-path", { path: item.path });
      if (!r.ok) toast("无法打开: " + (r.error || ""));
    }
    function doClearLskey(key, label) {
      if (!window.confirm(`清除浏览器存储键「${key}」（${fmtSize((localStorage.getItem(key) || "").length * 2)}）？\n所属: ${label}`)) return;
      localStorage.removeItem(key);
      toast("已清除"); refresh();
    }

    const GROUP_ZH = { sessions: "对话", storages: "数据文件", skills: "技能", memory: "记忆库", logs: "日志", trash: "回收站" };

    function itemRow(item, groupId) {
      const row = document.createElement("div");
      Object.assign(row.style, { borderBottom: "1px solid " + C().border, padding: "10px 12px", fontSize: "12px" });
      // 行 1：来源（蓝字，贴左）在前，类型徽章在后
      const kindBadge = item.kind === "subagent"
        ? `<span style="background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 6px;font-size:11px">AI 子代理</span> `
        : item.kind === "main"
          ? `<span style="background:#d1fae5;color:#065f46;border-radius:4px;padding:1px 6px;font-size:11px">主对话</span> `
          : item.kind === "fork"
            ? `<span style="background:#e0e7ff;color:#3730a3;border-radius:4px;padding:1px 6px;font-size:11px">分支</span> `
            : "";
      const line1 = document.createElement("div");
      line1.innerHTML = `<span style="color:${C().brand};font-size:11px">${esc(item.origin)}</span> ` + kindBadge;
      line1.style.marginBottom = "4px";
      row.appendChild(line1);
      // 行 2：名称（最长 12 字符）
      const line2 = document.createElement("div");
      line2.innerHTML = `<b style="font-size:13px">${esc(trunc(item.name))}</b>`;
      line2.style.marginBottom = "4px";
      row.appendChild(line2);
      // 行 3：大小 · 时间（回收站附倒计时）
      const daysLeft = groupId === "trash" && item.expiresAt
        ? ` · <span style="color:${C().danger}">${Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 86400000))} 天后自动清除</span>`
        : "";
      const line3 = document.createElement("div");
      line3.innerHTML = `<span style="color:${C().dimmed};font-size:11px">${fmtSize(item.size)}${item.approx ? "（近似）" : ""} · ${fmtTime(item.mtime)}</span>${daysLeft}`;
      line3.style.marginBottom = "4px";
      row.appendChild(line3);
      // 行 4：主对话归属 / 内容摘要
      if (item.summary) {
        const line4 = document.createElement("div");
        line4.textContent = item.summary;
        line4.style.color = C().secondary;
        line4.style.marginBottom = "6px";
        row.appendChild(line4);
      }
      // 行 5：按钮
      const ops = document.createElement("div");
      if (item.path) {
        ops.appendChild(actionBtn("复制路径", () => copyText(item.path)));
        ops.appendChild(actionBtn("打开位置", () => doOpen(item)));
      }
      if (groupId === "trash") {
        ops.appendChild(actionBtn("恢复", () => doRestore(item)));
        ops.appendChild(actionBtn("彻底删除", () => doPurge(item), true));
      } else if (item.deletable) {
        ops.appendChild(actionBtn("删除", () => doDelete(item), true));
      }
      row.appendChild(ops);
      return row;
    }

    function groupBlock(group) {
      const g = document.createElement("div");
      const head = document.createElement("div");
      head.innerHTML = `<b>${esc(group.title)} ${esc(group.id)}</b> <span style="color:${C().tertiary}">(${group.items.length})</span>`;
      Object.assign(head.style, { padding: "8px 10px", background: C().hover, fontSize: "13px" });
      g.appendChild(head);
      if (group.items.length === 0) {
        const e = document.createElement("div");
        e.textContent = "（空）"; e.style.padding = "6px 10px"; e.style.color = C().tertiary; e.style.fontSize = "12px";
        g.appendChild(e);
      }
      for (const it of group.items) g.appendChild(itemRow(it, group.id));
      return g;
    }

    function lsBlock() {
      const g = document.createElement("div");
      const head = document.createElement("div");
      let total = 0;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) { keys.push(k); total += (localStorage.getItem(k) || "").length * 2; } }
      head.innerHTML = `<b>浏览器存储 localStorage</b> <span style="color:${C().tertiary}">(${keys.length} 个键 · ${fmtSize(total)})</span>`;
      Object.assign(head.style, { padding: "8px 10px", background: C().hover, fontSize: "13px" });
      g.appendChild(head);
      if (keys.length === 0) {
        const e = document.createElement("div"); e.textContent = "（空）"; e.style.padding = "6px 10px"; e.style.color = C().tertiary; e.style.fontSize = "12px"; g.appendChild(e);
      }
      for (const k of keys.sort()) {
        const size = (localStorage.getItem(k) || "").length * 2;
        const masked = k.length > 23 ? k.slice(0, 10) + "***" + k.slice(-10) : k;
        const row = document.createElement("div");
        Object.assign(row.style, { borderBottom: "1px solid " + C().border, padding: "10px 12px", fontSize: "12px" });
        const line1 = document.createElement("div");
        line1.innerHTML = `<span style="color:${C().brand};font-size:11px">${esc(lsOrigin(k))}</span>`;
        line1.style.marginBottom = "4px";
        row.appendChild(line1);
        const line2 = document.createElement("div");
        line2.innerHTML = `<span style="font-family:Consolas,monospace;font-size:11px">${esc(masked)}</span>`;
        line2.style.marginBottom = "4px";
        row.appendChild(line2);
        const line3 = document.createElement("div");
        line3.innerHTML = `<span style="color:${C().dimmed};font-size:11px">${fmtSize(size)}</span> `;
        line3.appendChild(actionBtn("清除", () => doClearLskey(k, lsOrigin(k)), true));
        row.appendChild(line3);
        g.appendChild(row);
      }
      return g;
    }

    function readonlyBlock(items) {
      const g = document.createElement("div");
      const head = document.createElement("div");
      head.innerHTML = `<b>只读参考 readonly</b> <span style="color:${C().tertiary}">(${items.length})</span>`;
      Object.assign(head.style, { padding: "8px 10px", background: C().hover, fontSize: "13px" });
      g.appendChild(head);
      for (const it of items) {
        const row = document.createElement("div");
        Object.assign(row.style, { borderBottom: "1px solid " + C().border, padding: "10px 12px", fontSize: "12px" });
        const line1 = document.createElement("div");
        line1.innerHTML = `<span style="color:${C().brand};font-size:11px">${esc(it.origin)}</span>`;
        line1.style.marginBottom = "4px";
        row.appendChild(line1);
        const line2 = document.createElement("div");
        line2.textContent = it.summary || "";
        line2.style.color = C().secondary;
        line2.style.marginBottom = "4px";
        row.appendChild(line2);
        if (it.showPath) {
          const line3 = document.createElement("div");
          line3.innerHTML = `<span style="color:${C().tertiary};font-family:Consolas,monospace;font-size:11px;word-break:break-all;cursor:pointer" title="点击复制">${esc(it.path)}</span>`;
          line3.addEventListener("click", () => copyText(it.path));
          row.appendChild(line3);
        }
        const ops = document.createElement("div");
        ops.appendChild(actionBtn("复制路径", () => copyText(it.path)));
        ops.appendChild(actionBtn("打开位置", () => doOpen(it)));
        row.appendChild(ops);
        g.appendChild(row);
      }
      return g;
    }

    async function refresh() {
      readPalette();
      try {
        const cfg = await api("/config");
        refreshSeconds = Number(cfg.refreshSeconds ?? 20);
        trashDays = Number(cfg.trashDays ?? 30);
        const inv = await api("/inventory");
        if (!inv.ok) { contentEl.innerHTML = `<div style="padding:12px;color:${C().danger}">盘点失败: ${esc(inv.error || "未知错误")}</div>`; return; }
        contentEl.innerHTML = "";
        const total = document.createElement("div");
        const lsCount = (() => { let n = 0; for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)) n++; return n; })();
        const entries = [
          ...Object.entries(inv.totals.groupCounts).map(([k, v]) => `${GROUP_ZH[k] ?? k} ${k} · ${v}`),
          `浏览器存储 localStorage · ${lsCount}`,
          `只读参考 readonly · ${(inv.readonly || []).length}`,
        ];
        const rows = [];
        for (let i = 0; i < entries.length; i += 3) rows.push(entries.slice(i, i + 3).join("　"));
        total.innerHTML = `📊 <b>总览</b>：可删数据 <b>${esc(inv.totals.deletableSize)}</b>` +
          rows.map((r) => `<div style="margin-top:5px;color:${C().secondary}">${r}</div>`).join("") +
          `<div style="margin-top:3px;color:${C().tertiary};font-size:11px">${esc(inv.dshHome)}</div>`;
        Object.assign(total.style, { padding: "10px", fontSize: "12px", color: C().text, borderBottom: "1px solid " + C().border, background: C().accent });
        contentEl.appendChild(total);
        for (const g of inv.groups) contentEl.appendChild(groupBlock(g));
        contentEl.appendChild(lsBlock());
        contentEl.appendChild(readonlyBlock(inv.readonly || []));
      } catch (e) {
        contentEl.innerHTML = `<div style="padding:12px;color:${C().danger}">加载失败: ${esc(e.message)}</div>`;
      } finally {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, refreshSeconds * 1000);
      }
    }

    function mountPanel() {
      if (document.getElementById("data-ledger-panel")) return;
      readPalette();
      panel = document.createElement("div");
      panel.id = "data-ledger-panel";
      Object.assign(panel.style, {
        position: "fixed", top: "0", right: "0", bottom: "0", width: "400px",
        background: C().bg, color: C().text, boxShadow: "-4px 0 16px rgba(0,0,0,.25)",
        zIndex: "2147482900", transform: "translateX(100%)", transition: "transform .2s",
        display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif",
      });
      const bar = document.createElement("div");
      Object.assign(bar.style, { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "#111827", color: "#fff" });
      bar.innerHTML = `<b style="font-size:14px">📋 数据管理</b><span style="font-size:11px;color:#9ca3af">${esc(fmtTime(Date.now()))}</span>`;
      const btns = document.createElement("div");
      const refBtn = document.createElement("button");
      refBtn.textContent = "刷新"; Object.assign(refBtn.style, { cursor: "pointer", background: "#374151", color: "#fff", border: "none", borderRadius: "6px", padding: "3px 10px", fontSize: "12px" });
      refBtn.addEventListener("click", refresh);
      btns.appendChild(refBtn);
      bar.appendChild(btns);
      panel.appendChild(bar);
      contentEl = document.createElement("div");
      Object.assign(contentEl.style, { flex: "1", overflowY: "auto", fontSize: "12px" });
      panel.appendChild(contentEl);
      document.body.appendChild(panel);
      btn = document.createElement("button");
      btn.textContent = "数据管理";
      Object.assign(btn.style, {
        position: "fixed", right: "0", top: "46%", zIndex: "2147482800",
        background: "#111827", color: "#fff", border: "none", borderTopLeftRadius: "10px",
        borderBottomLeftRadius: "10px", padding: "12px 6px", fontSize: "13px",
        cursor: "pointer", writingMode: "vertical-rl", letterSpacing: "4px",
        boxShadow: "-2px 0 8px rgba(0,0,0,.3)",
      });
      let panelOpen = false;
      const setOpen = (open) => {
        panelOpen = open;
        panel.style.transform = open ? "none" : "translateX(100%)";
      };
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(!panelOpen);
      });
      document.addEventListener("click", (event) => {
        if (!panelOpen) return;
        const t = event.target;
        if (panel.contains(t) || (btn && btn.contains(t))) return;
        setOpen(false);
      });
      document.body.appendChild(btn);
      refresh();
    }

    // 主题切换即时跟随
    new MutationObserver(() => {
      readPalette();
      if (panel) {
        panel.style.background = C().bg;
        panel.style.color = C().text;
        refresh();
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });

    function apply(ctx) {
      if (window.__DATA_LEDGER_MOUNTED__) return;
      window.__DATA_LEDGER_MOUNTED__ = true;
      if (document.body) mountPanel();
      else document.addEventListener("DOMContentLoaded", mountPanel);
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
