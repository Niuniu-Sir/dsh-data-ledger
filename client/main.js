// 数据台账 · client 半：右侧面板（纯 DOM、零框架、无第三方依赖）
// 契约：window.__ModuleLoader__.load 工厂返回 { name, inject, apply }
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

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const fmtSize = (bytes) => {
      if (bytes === null || bytes === undefined) return "—";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
      return (bytes / 1073741824).toFixed(2) + " GB";
    };
    const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—");

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
        border: "1px solid #d1d5db", background: danger ? "#fef2f2" : "#f9fafb",
        color: danger ? "#b91c1c" : "#374151", borderRadius: "6px", padding: "2px 8px",
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
    function doClearAllLs() {
      if (!window.confirm("清除 DSH 页面的全部浏览器存储？\n（界面布局、面板偏好会重置）")) return;
      if (!window.confirm("再次确认：全部清除？")) return;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      for (const k of keys) localStorage.removeItem(k);
      toast("已全部清除"); refresh();
    }

    function itemRow(item, groupId) {
      const row = document.createElement("div");
      Object.assign(row.style, { borderBottom: "1px solid #f3f4f6", padding: "8px 10px", fontSize: "12px" });
      const head = document.createElement("div");
      const daysLeft = groupId === "trash" && item.expiresAt
        ? ` · <span style="color:#b45309">${Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 86400000))} 天后自动清除</span>`
        : "";
      head.innerHTML = `<b style="font-size:13px">${esc(item.name)}</b> ` +
        `<span style="background:#eef2ff;color:#4338ca;border-radius:4px;padding:1px 6px;font-size:11px">${esc(item.origin)}</span> ` +
        `<span style="color:#6b7280">${fmtSize(item.size)}${item.approx ? "（近似）" : ""} · ${fmtTime(item.mtime)}</span>${daysLeft}`;
      row.appendChild(head);
      const pathLine = document.createElement("div");
      pathLine.innerHTML = `<span style="color:#9ca3af;font-family:Consolas,monospace;font-size:11px;word-break:break-all;cursor:pointer" title="点击复制">${esc(item.path || "(已无磁盘文件)")}</span>`;
      pathLine.addEventListener("click", () => item.path && copyText(item.path));
      row.appendChild(pathLine);
      const sum = document.createElement("div");
      sum.textContent = item.summary || "";
      sum.style.color = "#4b5563"; sum.style.margin = "3px 0 5px";
      row.appendChild(sum);
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
      head.innerHTML = `<b>${esc(group.title)}</b> <span style="color:#9ca3af">(${group.items.length})</span>`;
      Object.assign(head.style, { padding: "8px 10px", background: "#f9fafb", fontSize: "13px" });
      g.appendChild(head);
      if (group.items.length === 0) {
        const e = document.createElement("div");
        e.textContent = "（空）"; e.style.padding = "6px 10px"; e.style.color = "#9ca3af"; e.style.fontSize = "12px";
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
      head.innerHTML = `<b>浏览器本地存储</b> <span style="color:#9ca3af">(${keys.length} 个键 · ${fmtSize(total)})</span>`;
      Object.assign(head.style, { padding: "8px 10px", background: "#f9fafb", fontSize: "13px" });
      g.appendChild(head);
      if (keys.length === 0) {
        const e = document.createElement("div"); e.textContent = "（空）"; e.style.padding = "6px 10px"; e.style.color = "#9ca3af"; e.style.fontSize = "12px"; g.appendChild(e);
      }
      for (const k of keys.sort()) {
        const size = (localStorage.getItem(k) || "").length * 2;
        const row = document.createElement("div");
        Object.assign(row.style, { borderBottom: "1px solid #f3f4f6", padding: "6px 10px", fontSize: "12px" });
        row.innerHTML = `<span style="font-family:Consolas,monospace;font-size:11px;word-break:break-all">${esc(k)}</span> ` +
          `<span style="background:#eef2ff;color:#4338ca;border-radius:4px;padding:1px 6px;font-size:11px">${esc(lsOrigin(k))}</span> ` +
          `<span style="color:#6b7280">${fmtSize(size)}</span>`;
        const ops = document.createElement("div");
        ops.appendChild(actionBtn("清除", () => doClearLskey(k, lsOrigin(k)), true));
        row.appendChild(ops);
        g.appendChild(row);
      }
      if (keys.length > 0) {
        const opsAll = document.createElement("div");
        opsAll.style.padding = "6px 10px";
        opsAll.appendChild(actionBtn("全部清除（重置界面状态）", doClearAllLs, true));
        g.appendChild(opsAll);
      }
      return g;
    }

    function readonlyBlock(items) {
      const g = document.createElement("div");
      const head = document.createElement("div");
      head.innerHTML = `<b>只读参考（不可删）</b> <span style="color:#9ca3af">(${items.length})</span>`;
      Object.assign(head.style, { padding: "8px 10px", background: "#f9fafb", fontSize: "13px" });
      g.appendChild(head);
      for (const it of items) {
        const row = document.createElement("div");
        Object.assign(row.style, { borderBottom: "1px solid #f3f4f6", padding: "8px 10px", fontSize: "12px" });
        row.innerHTML = `<b>${esc(it.name)}</b> ` +
          `<span style="background:#f3f4f6;color:#4b5563;border-radius:4px;padding:1px 6px;font-size:11px">${esc(it.origin)}</span> ` +
          `<span style="color:#6b7280">${fmtSize(it.size)}${it.approx ? "（近似）" : ""}</span>` +
          `<div style="color:#9ca3af;font-family:Consolas,monospace;font-size:11px;word-break:break-all;cursor:pointer" title="点击复制">${esc(it.path)}</div>` +
          `<div style="color:#4b5563;margin-top:3px">${esc(it.summary || "")}</div>`;
        row.querySelector("div[title='点击复制']").addEventListener("click", () => copyText(it.path));
        const ops = document.createElement("div");
        ops.appendChild(actionBtn("复制路径", () => copyText(it.path)));
        ops.appendChild(actionBtn("打开位置", () => doOpen(it)));
        row.appendChild(ops);
        g.appendChild(row);
      }
      return g;
    }

    async function refresh() {
      try {
        const cfg = await api("/config");
        refreshSeconds = Number(cfg.refreshSeconds ?? 20);
        trashDays = Number(cfg.trashDays ?? 30);
        const inv = await api("/inventory");
        if (!inv.ok) { contentEl.innerHTML = `<div style="padding:12px;color:#b91c1c">盘点失败: ${esc(inv.error || "未知错误")}</div>`; return; }
        contentEl.innerHTML = "";
        const total = document.createElement("div");
        total.innerHTML = `📊 <b>总览</b>：可删数据 ${esc(inv.totals.deletableSize)} · ` +
          Object.entries(inv.totals.groupCounts).map(([k, v]) => `${esc(k)} ${v}`).join(" · ") +
          ` · <span style="color:#9ca3af">${esc(inv.dshHome)}</span>`;
        Object.assign(total.style, { padding: "10px", fontSize: "12px", color: "#374151", borderBottom: "1px solid #e5e7eb", background: "#fffbeb" });
        contentEl.appendChild(total);
        for (const g of inv.groups) contentEl.appendChild(groupBlock(g));
        contentEl.appendChild(lsBlock());
        contentEl.appendChild(readonlyBlock(inv.readonly || []));
      } catch (e) {
        contentEl.innerHTML = `<div style="padding:12px;color:#b91c1c">加载失败: ${esc(e.message)}</div>`;
      } finally {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, refreshSeconds * 1000);
      }
    }

    function mountPanel() {
      if (document.getElementById("data-ledger-panel")) return;
      // 面板
      panel = document.createElement("div");
      panel.id = "data-ledger-panel";
      Object.assign(panel.style, {
        position: "fixed", top: "0", right: "0", bottom: "0", width: "400px",
        background: "#ffffff", color: "#111827", boxShadow: "-4px 0 16px rgba(0,0,0,.12)",
        zIndex: "2147482900", transform: "translateX(100%)", transition: "transform .2s",
        display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif",
      });
      const bar = document.createElement("div");
      Object.assign(bar.style, { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "#111827", color: "#fff" });
      bar.innerHTML = `<b style="font-size:14px">📋 数据台账</b><span style="font-size:11px;color:#9ca3af">${esc(fmtTime(Date.now()))}</span>`;
      const btns = document.createElement("div");
      const refBtn = document.createElement("button");
      refBtn.textContent = "刷新"; Object.assign(refBtn.style, { marginRight: "8px", cursor: "pointer", background: "#374151", color: "#fff", border: "none", borderRadius: "6px", padding: "3px 10px", fontSize: "12px" });
      refBtn.addEventListener("click", refresh);
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "关闭"; Object.assign(closeBtn.style, { cursor: "pointer", background: "#4b5563", color: "#fff", border: "none", borderRadius: "6px", padding: "3px 10px", fontSize: "12px" });
      closeBtn.addEventListener("click", () => { panel.style.transform = "translateX(100%)"; });
      btns.appendChild(refBtn); btns.appendChild(closeBtn);
      bar.appendChild(btns);
      panel.appendChild(bar);
      contentEl = document.createElement("div");
      Object.assign(contentEl.style, { flex: "1", overflowY: "auto", fontSize: "12px" });
      panel.appendChild(contentEl);
      document.body.appendChild(panel);
      // 入口按钮（右侧中部）
      btn = document.createElement("button");
      btn.textContent = "台账";
      Object.assign(btn.style, {
        position: "fixed", right: "0", top: "46%", zIndex: "2147482800",
        background: "#111827", color: "#fff", border: "none", borderTopLeftRadius: "10px",
        borderBottomLeftRadius: "10px", padding: "12px 6px", fontSize: "13px",
        cursor: "pointer", writingMode: "vertical-rl", letterSpacing: "4px",
        boxShadow: "-2px 0 8px rgba(0,0,0,.18)",
      });
      btn.addEventListener("click", () => {
        const open = panel.style.transform !== "none";
        panel.style.transform = open ? "none" : "translateX(100%)";
      });
      document.body.appendChild(btn);
      refresh();
    }

    function apply(ctx) {
      if (window.__DATA_LEDGER_MOUNTED__) return;
      window.__DATA_LEDGER_MOUNTED__ = true;
      // 等 DOM 就绪再挂载，避免与官方壳竞争
      if (document.body) mountPanel();
      else document.addEventListener("DOMContentLoaded", mountPanel);
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
