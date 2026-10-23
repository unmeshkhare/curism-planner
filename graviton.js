// ============================================================
//  GRAVITON project desk  (second workspace inside the same app)
//  Collections:  gprojects/{id}  = project properties + status
//                gnotes/{id}     = modeller / animator / assembler note rows
//  Edit account: everything.   View account: change status + edit notes only.
// ============================================================
import { collection, doc, onSnapshot, setDoc, updateDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const G_CREDIT = "Made by Unmesh Khare for GRAVITON";

// ---------- settings you may want to edit ----------
const STATUSES = [
  { name: "Enquiry",            color: "#8c93a0" },
  { name: "Quoted",             color: "#6fb7ff" },
  { name: "Approved",           color: "#b79cff" },
  { name: "In progress",        color: "#ff9a3c" },
  { name: "Waiting for client", color: "#ff7ac6" },
  { name: "Review",             color: "#fdcb06" },
  { name: "Delivered",          color: "#6dffb0" },
  { name: "On hold",            color: "#6b6858" }
];
const DONE = "Delivered";                       // delivered projects sink to the bottom
const TYPES = ["3D printing", "Product development", "3D animation"];
const PRIORITIES = ["", "Low", "Medium", "High"];
const SECTIONS = [
  { key: "modeller",  title: "MODELLER’S NOTES",  ph: "Note for the modeller…" },
  { key: "animator",  title: "ANIMATOR’S NOTES",  ph: "Note for the animator…" },
  { key: "assembler", title: "ASSEMBLER’S NOTES", ph: "Note for the assembler…" }
];

export function createGraviton(c) {
  const { root, $, $$, esc, store, newId, autosize, safeUrl, linkKind, defaultLabel, toast, modal, canEdit, dataError } = c;
  const db = () => c.db();

  const S = {
    projects: [], loaded: false,
    view: store.get("graviton.view", "all"), q: "", fStatus: "", fType: "",
    collapsed: store.get("graviton.collapsed", {})
  };
  let unsub = null;

  const statusObj = n => STATUSES.find(s => s.name === n) || STATUSES[0];
  const isDone = p => p.status === DONE;
  const statusOptions = sel => STATUSES.map(s => `<option value="${esc(s.name)}"${s.name === sel ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  const typeOptions = sel => `<option value="">— not set —</option>` + TYPES.map(t => `<option value="${esc(t)}"${t === sel ? " selected" : ""}>${esc(t)}</option>`).join("");
  const sortP = list => list.slice().sort((a, b) =>
    (isDone(a) - isDone(b)) || ((a.order ?? 0) - (b.order ?? 0)) || ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || a.id.localeCompare(b.id));
  const fmtDate = v => {
    if (!v) return "";
    const d = new Date(v + "T00:00:00");
    return isNaN(d) ? v : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const overdue = p => !!p.deadline && !isDone(p) && p.status !== "On hold" && new Date(p.deadline + "T23:59:59") < new Date();

  // ---------- data ----------
  function start() {
    stop(); S.loaded = false;
    unsub = onSnapshot(collection(db(), "gprojects"), snap => {
      S.projects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      S.loaded = true; c.changed();
    }, dataError);
  }
  function stop() { if (unsub) unsub(); unsub = null; S.loaded = false; }
  const isLoaded = () => S.loaded;

  // ============================================================
  //  HOME (project list)
  // ============================================================
  function renderHome() {
    c.setPage({ page: "ghome" });
    const ed = canEdit();
    root.innerHTML = `<div class="wrap">
      <header class="top">
        <div class="brand"><div class="brand-text"><img class="gword" src="graviton.png" alt="Graviton"><p class="tagline">Project desk</p></div></div>
        <div class="top-actions">
          ${ed ? `<button class="btn primary" data-act="g-new">+ New project</button>`
               : `<span class="badge" title="You can change status and edit notes, but not create or delete projects">Team access</span>`}
          <a class="btn ghost" href="#/" title="Switch between Curism and Graviton">Switch</a>
          <button class="btn ghost" data-act="lock">Lock</button>
        </div>
      </header>
      <section class="controls" id="gControls">
        <div class="seg">
          <button data-act="g-view" data-view="all">All projects</button>
          <button data-act="g-view" data-view="type">By type</button>
        </div>
        <input class="inp" id="gq" type="search" placeholder="Search projects…" value="${esc(S.q)}" aria-label="Search">
        <select class="sel" id="gfStatus" data-act="g-f-status" aria-label="Filter by status"></select>
        <select class="sel" id="gfType" data-act="g-f-type" aria-label="Filter by type"></select>
        <span class="muted" id="gcount"></span>
      </section>
      <main id="gListArea"></main>
      <p class="foot">${esc(G_CREDIT)}</p>
    </div>`;
    refreshFilters(); updateViewButtons(); renderList();
  }
  function updateViewButtons() {
    $$("[data-act=g-view]").forEach(b => b.classList.toggle("on", b.dataset.view === S.view));
    const t = $("#gfType"); if (t) t.hidden = S.view === "type";
  }
  function refreshFilters() {
    const fs = $("#gfStatus"), ft = $("#gfType"); if (!fs || !ft) return;
    fs.innerHTML = `<option value="">All statuses</option><option value="__active">Not delivered</option>` +
      STATUSES.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
    fs.value = S.fStatus;
    ft.innerHTML = `<option value="">All types</option>` + TYPES.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("") + `<option value="__none">No type</option>`;
    ft.value = S.fType;
  }
  function visible() {
    const q = S.q.trim().toLowerCase();
    return S.projects.filter(p => {
      if (q && !`${p.name || ""} ${p.description || ""} ${p.assigned || ""}`.toLowerCase().includes(q)) return false;
      if (S.fStatus === "__active") { if (isDone(p)) return false; }
      else if (S.fStatus && p.status !== S.fStatus) return false;
      if (S.view === "all" && S.fType) {
        if (S.fType === "__none" ? !!p.type : p.type !== S.fType) return false;
      }
      return true;
    });
  }
  function rowHTML(p, i, items) {
    const ed = canEdit(), done = isDone(p), st = statusObj(p.status);
    const prev = items[i - 1], next = items[i + 1];
    const upOff = !prev || isDone(prev) !== done, downOff = !next || isDone(next) !== done;
    const firstDone = done && i > 0 && !isDone(prev);
    const bits = [p.assigned ? "Assigned: " + p.assigned : "", p.priority ? p.priority + " priority" : ""].filter(Boolean).join(" · ");
    return `<tr data-gid="${esc(p.id)}" class="${done ? "done" : ""}${firstDone ? " first-done" : ""}">
      ${ed ? `<td class="c-move"><span class="handle" title="Drag to reorder">⋮⋮</span><span class="arrows">
        <button class="icon-btn" data-act="g-mv-up" ${upOff ? "disabled" : ""} title="Move up" aria-label="Move up">↑</button>
        <button class="icon-btn" data-act="g-mv-down" ${downOff ? "disabled" : ""} title="Move down" aria-label="Move down">↓</button></span></td>` : ""}
      <td class="c-name"><a href="#/g/project/${esc(p.id)}">${esc(p.name || "Untitled")}</a>${bits ? `<div class="sub">${esc(bits)}</div>` : ""}</td>
      <td class="c-desc">${esc(p.description || "")}</td>
      <td class="c-cat"><span class="ro-text">${esc(p.type || "—")}</span></td>
      <td class="c-dead${overdue(p) ? " late" : ""}">${esc(fmtDate(p.deadline))}</td>
      <td class="c-status"><select class="sel status" data-act="g-set-status" style="--c:${st.color}" aria-label="Status">${statusOptions(p.status)}</select></td>
      ${ed ? `<td class="c-del"><button class="icon-btn danger" data-act="g-del" title="Delete project" aria-label="Delete project">✕</button></td>` : ""}
    </tr>`;
  }
  function tableHTML(items) {
    const ed = canEdit();
    return `<table class="list-table"><thead><tr>${ed ? "<th></th>" : ""}<th>Project</th><th>Description</th><th>Type</th><th>Deadline</th><th>Status</th>${ed ? "<th></th>" : ""}</tr></thead>
      <tbody>${items.map((p, i) => rowHTML(p, i, items)).join("")}</tbody></table>`;
  }
  function renderList() {
    const area = $("#gListArea"); if (!area) return;
    const vis = sortP(visible()), total = S.projects.length;
    $("#gcount").textContent = total ? `${vis.length} of ${total} projects · ${S.projects.filter(isDone).length} delivered` : "";
    if (!total) {
      area.innerHTML = `<div class="empty"><p>No projects yet.</p>${canEdit() ? `<button class="btn primary" data-act="g-new">+ Create your first project</button>` : ""}</div>`;
      return;
    }
    if (!vis.length) { area.innerHTML = `<div class="empty"><p>No projects match your filters.</p></div>`; return; }
    if (S.view === "all") area.innerHTML = `<div class="card">${tableHTML(vis)}</div>`;
    else {
      const groups = [...TYPES.map(t => ({ key: t, name: t, items: [] })), { key: "__none", name: "No type", items: [] }];
      vis.forEach(p => (groups.find(g => g.key === p.type) || groups[groups.length - 1]).items.push(p));
      const filtering = S.q || S.fStatus;
      area.innerHTML = groups.filter(g => g.items.length || (!filtering && g.key !== "__none")).map(g => {
        const col = !!S.collapsed[g.key];
        return `<section class="group ${col ? "collapsed" : ""}">
          <button class="group-head" data-act="g-toggle" data-key="${esc(g.key)}" aria-expanded="${!col}">
            <span class="chev"></span><span class="gname">${esc(g.name)}</span><span class="gcount">${g.items.length}</span></button>
          <div class="card group-body">${g.items.length ? tableHTML(g.items) : `<div class="group-empty">No projects of this type yet.</div>`}</div>
        </section>`;
      }).join("");
    }
    if (window.Sortable && canEdit()) {
      $$("#gListArea tbody").forEach(tb => window.Sortable.create(tb, {
        handle: ".handle", animation: 160, ghostClass: "drag-ghost",
        onEnd: () => applyOrder($$("tr[data-gid]", tb).map(tr => tr.dataset.gid))
      }));
    }
  }
  async function applyOrder(ids) {
    const byId = Object.fromEntries(S.projects.map(p => [p.id, p]));
    ids = ids.filter(id => byId[id]);
    const orders = ids.map(id => byId[id].order ?? 0).sort((a, b) => a - b);
    const batch = writeBatch(db()); let n = 0;
    ids.forEach((id, k) => { if (byId[id].order !== orders[k]) { batch.update(doc(db(), "gprojects", id), { order: orders[k] }); n++; } });
    try { if (n) await batch.commit(); else renderList(); } catch (e) { dataError(e); }
  }

  // ============================================================
  //  NEW / DELETE
  // ============================================================
  function openNew() {
    const m = modal(`<h3>New project</h3>
      <form id="gnForm">
        <label for="gn-name">Project name</label>
        <input class="inp" id="gn-name" required maxlength="140" autocomplete="off" placeholder="e.g. Hospital lobby miniature model">
        <label for="gn-type">Project type</label>
        <select class="sel" id="gn-type">${typeOptions("")}</select>
        <label for="gn-desc">Short description</label>
        <textarea class="inp area" id="gn-desc" rows="3" placeholder="One or two lines about this project"></textarea>
        <p class="err" id="gn-err"></p>
        <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Create &amp; open</button></div>
      </form>`);
    $("#gn-desc", m).addEventListener("input", e => autosize(e.target));
    $("#gn-name", m).focus();
    $("#gnForm", m).addEventListener("submit", async e => {
      e.preventDefault();
      const name = $("#gn-name", m).value.trim(); if (!name) return;
      const btn = $("button[type=submit]", m); btn.disabled = true;
      try {
        const ref = doc(collection(db(), "gprojects"));
        const maxOrder = Math.max(0, ...S.projects.map(p => p.order ?? 0)), now = Date.now();
        const b = writeBatch(db());
        b.set(ref, {
          name, type: $("#gn-type", m).value, description: $("#gn-desc", m).value.trim(), status: STATUSES[0].name,
          order: maxOrder + 1, startDate: new Date().toISOString().slice(0, 10), createdAt: now, updatedAt: now
        });
        b.set(doc(db(), "gnotes", ref.id), { modeller: [], animator: [], assembler: [], updatedAt: now });
        await b.commit();
        m.close(); location.hash = "#/g/project/" + ref.id;
      } catch (err) { btn.disabled = false; $("#gn-err", m).textContent = "Could not create: " + (err.code || err.message); }
    });
  }
  function openDelete(p) {
    const m = modal(`<h3>Delete project</h3>
      <p>This permanently deletes <b>${esc(p.name)}</b> and all its notes. It cannot be undone.</p>
      <label for="gdn">Type the project name to confirm</label>
      <input class="inp" id="gdn" autocomplete="off" placeholder="${esc(p.name)}">
      <label for="gdp">Password</label>
      <input class="inp" id="gdp" type="password" autocomplete="current-password">
      <p class="err" id="gderr"></p>
      <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="gdgo" disabled>Delete forever</button></div>`);
    const dn = $("#gdn", m), dp = $("#gdp", m), go = $("#gdgo", m), err = $("#gderr", m);
    const check = () => { go.disabled = !(dn.value.trim().toLowerCase() === (p.name || "").trim().toLowerCase() && dp.value.length > 0); };
    dn.addEventListener("input", check); dp.addEventListener("input", check);
    dp.addEventListener("keydown", e => { if (e.key === "Enter" && !go.disabled) go.click(); });
    dn.focus();
    go.addEventListener("click", async () => {
      go.disabled = true; err.textContent = "";
      try { await c.reauth(dp.value); } catch (e) { err.textContent = c.authMsg(e); go.disabled = false; return; }
      try {
        if (openId === p.id) { discard(); location.hash = "#/g"; }
        const b = writeBatch(db());
        b.delete(doc(db(), "gprojects", p.id));
        b.delete(doc(db(), "gnotes", p.id));
        await b.commit();
        m.close(); toast("Project deleted.");
      } catch (e) { err.textContent = "Could not delete: " + (e.code || e.message); go.disabled = false; }
    });
  }

  // ============================================================
  //  PROJECT PAGE
  // ============================================================
  let openId = null, notesUnsub = null;
  let notes = null;                    // { modeller:[], animator:[], assembler:[] }
  let dirty = new Set(), notesTimer = null;
  let patch = {}, hdrTimer = null;
  const openProject = () => S.projects.find(p => p.id === openId);
  const newRow = () => ({ id: newId("n"), note: "", links: [] });
  const cleanRow = r => ({ id: r.id, note: r.note || "", links: (r.links || []).map(l => ({ url: l.url, label: l.label || "" })) });
  const setSave = (text, cls = "") => { const el = $("#gSave"); if (el) { el.textContent = text; el.className = "save-state " + cls; } };

  const FIELDS = [
    { key: "startDate",   label: "Project start date", type: "date" },
    { key: "deadline",    label: "Deadline",           type: "date" },
    { key: "assigned",    label: "Assigned to",        type: "text", ph: "Person or team" },
    { key: "description", label: "Project description", type: "area", ph: "What is this project? Scope, client, anything the team should know." }
  ];
  function fieldHTML(f) {
    const ro = canEdit() ? "" : " readonly", ph = f.ph && canEdit() ? ` placeholder="${esc(f.ph)}"` : "";
    if (f.type === "area") return `<textarea class="inp area" rows="1" data-gf="${f.key}"${ph}${ro}></textarea>`;
    if (f.type === "date") return `<input class="inp" type="date" data-gf="${f.key}"${ro}>`;
    return `<input class="inp" type="text" data-gf="${f.key}"${ph}${ro}>`;
  }

  function renderProject(id) {
    const p = S.projects.find(x => x.id === id);
    if (!p) {
      c.setPage({ page: "gmissing" });
      root.innerHTML = `<div class="wrap"><div class="empty"><p>That project was not found.</p><a class="btn" href="#/g">← All projects</a></div></div>`;
      return;
    }
    c.setPage({ page: "gproject", id }); openId = id;
    notes = null; dirty = new Set(); patch = {};
    const ed = canEdit();
    root.innerHTML = `<div class="wrap">
      <header class="top">
        <a class="btn ghost" href="#/g">← All projects</a>
        <div class="top-actions">
          <span class="save-state" id="gSave"></span>
          ${ed ? "" : `<span class="badge" title="You can change status and edit notes, but not the project details">Team access</span>`}
          <button class="btn" data-act="g-export">Export PDF</button>
          ${ed ? `<button class="btn danger" data-act="g-del-open">Delete</button>` : ""}
          <a class="btn ghost" href="#/" title="Switch between Curism and Graviton">Switch</a>
          <button class="btn ghost" data-act="lock">Lock</button>
        </div>
      </header>
      <section class="titlebar">
        <input class="inp title-input" data-gf="name" placeholder="Project name" aria-label="Project name"${ed ? "" : " readonly"}>
        <div class="pills">
          <label>Status<select class="sel status" id="gp-status" data-act="g-tp-status">${statusOptions("")}</select></label>
          ${ed ? `<label>Type<select class="sel" data-gf="type">${typeOptions("")}</select></label>
          <label>Priority<select class="sel" data-gf="priority">${PRIORITIES.map(x => `<option value="${x}">${x || "—"}</option>`).join("")}</select></label>` : `
          <label>Type<span class="ro-text" id="gro-type"></span></label>
          <label>Priority<span class="ro-text" id="gro-pri"></span></label>`}
        </div>
      </section>
      <section class="card details">${FIELDS.map(f => `<div class="d-label">${f.label}</div><div class="d-val">${fieldHTML(f)}</div>`).join("")}</section>
      ${SECTIONS.map(s => `<section class="card gnotes" data-sec="${s.key}">
        <div class="script-head"><h2>${s.title}</h2><span class="muted" data-count="${s.key}"></span></div>
        <table class="script-table mod-table">
          <thead><tr><th>#</th><th>Note</th><th>Links</th><th></th></tr></thead>
          <tbody data-body="${s.key}"></tbody>
        </table>
        <div class="script-foot"><button class="btn" data-act="g-add-row" data-sec="${s.key}">+ Add row</button></div>
      </section>`).join("")}
      <p class="foot">${esc(G_CREDIT)}</p>
    </div>`;
    fillHeader(p);
    notesUnsub = onSnapshot(doc(db(), "gnotes", id), snap => {
      if (openId !== id || snap.metadata.hasPendingWrites) return;
      const d = snap.exists() ? snap.data() : {};
      if (notes === null) {
        notes = {}; SECTIONS.forEach(s => { notes[s.key] = Array.isArray(d[s.key]) ? d[s.key] : []; });
        SECTIONS.forEach(s => renderSection(s.key)); return;
      }
      SECTIONS.forEach(s => {
        const remote = Array.isArray(d[s.key]) ? d[s.key] : [];
        if (dirty.has(s.key)) return;
        const body = $(`[data-body="${s.key}"]`);
        if (body && body.contains(document.activeElement)) return;
        if (JSON.stringify(remote) === JSON.stringify(notes[s.key])) return;
        notes[s.key] = remote; renderSection(s.key);
      });
    }, dataError);
  }

  function fillHeader(p) {
    const active = document.activeElement;
    $$("[data-gf]").forEach(el => {
      const k = el.dataset.gf;
      if (el === active || (k in patch)) return;
      const v = p[k] ?? ""; if (el.value !== v) el.value = v;
      if (el.tagName === "TEXTAREA") autosize(el);
    });
    const ss = $("#gp-status");
    if (ss && ss !== active) { ss.value = p.status || STATUSES[0].name; ss.style.setProperty("--c", statusObj(p.status).color); }
    const rt = $("#gro-type"); if (rt) rt.textContent = p.type || "—";
    const rp = $("#gro-pri"); if (rp) rp.textContent = p.priority || "—";
  }
  function scheduleHeader() { setSave("Saving…"); clearTimeout(hdrTimer); hdrTimer = setTimeout(flushHeader, 700); }
  async function flushHeader() {
    clearTimeout(hdrTimer);
    const id = openId; if (!id || !Object.keys(patch).length) return;
    const data = patch; patch = {};
    try { await updateDoc(doc(db(), "gprojects", id), { ...data, updatedAt: Date.now() }); if (openId === id) setSave("Saved ✓", "ok"); }
    catch (e) {
      if (openId === id) { patch = { ...data, ...patch }; setSave("Save failed - retrying", "err"); hdrTimer = setTimeout(flushHeader, 4000); }
      dataError(e);
    }
  }
  function markNotes(key) { dirty.add(key); setSave("Saving…"); clearTimeout(notesTimer); notesTimer = setTimeout(flushNotes, 700); }
  async function flushNotes() {
    clearTimeout(notesTimer);
    const id = openId; if (!id || !notes || !dirty.size) return;
    const keys = [...dirty]; dirty = new Set();
    const data = { updatedAt: Date.now() };
    keys.forEach(k => { data[k] = notes[k].map(cleanRow); });
    try { await setDoc(doc(db(), "gnotes", id), data, { merge: true }); if (openId === id && !dirty.size) setSave("Saved ✓", "ok"); }
    catch (e) {
      if (openId === id) { keys.forEach(k => dirty.add(k)); setSave("Save failed - retrying", "err"); notesTimer = setTimeout(flushNotes, 4000); }
      dataError(e);
    }
  }
  function discard() { clearTimeout(hdrTimer); clearTimeout(notesTimer); patch = {}; dirty = new Set(); }
  function leave() {
    if (!openId) return;
    flushHeader(); flushNotes();
    if (notesUnsub) notesUnsub(); notesUnsub = null;
    openId = null; notes = null;
  }
  window.addEventListener("beforeunload", e => {
    if (openId && (dirty.size || Object.keys(patch).length)) { flushNotes(); flushHeader(); e.preventDefault(); e.returnValue = ""; }
  });
  function onData() {
    if (c.page().page === "ghome") { refreshFilters(); renderList(); }
    else if (c.page().page === "gproject") {
      const p = openProject();
      if (!p) { discard(); location.hash = "#/g"; toast("That project no longer exists."); }
      else fillHeader(p);
    }
  }

  // ---- note rows ----
  function chipHTML(l, k) {
    const u = safeUrl(l.url);
    return `<span class="chip ${linkKind(u)}"><a href="${esc(u || "#")}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(l.label || defaultLabel(u))}</a><button class="x" data-act="g-link-rm" data-i="${k}" title="Remove link" aria-label="Remove link">×</button></span>`;
  }
  function rowHTML2(sec, r, i, n) {
    const s = SECTIONS.find(x => x.key === sec);
    return `<tr data-gr="${esc(r.id)}" data-sec="${sec}">
      <td class="c-num" data-label=""><span class="num">${i + 1}</span><span class="rowtools">
        <button class="icon-btn" data-act="g-row-up" ${i === 0 ? "disabled" : ""} title="Move up" aria-label="Move row up">↑</button>
        <button class="icon-btn" data-act="g-row-down" ${i === n - 1 ? "disabled" : ""} title="Move down" aria-label="Move row down">↓</button></span></td>
      <td data-label="Note"><textarea class="inp area" data-gn="note" rows="2" placeholder="${esc(s.ph)}">\n${esc(r.note)}</textarea></td>
      <td data-label="Links">
        <div class="links">${(r.links || []).map(chipHTML).join("")}</div>
        <div class="linkform" hidden>
          <input class="inp glf-url" type="text" inputmode="url" placeholder="Paste link (image, video, YouTube…)">
          <input class="inp glf-label" type="text" placeholder="Label (optional)">
          <div class="lf-actions"><button class="btn small primary" data-act="g-link-save">Add</button><button class="btn small ghost" data-act="g-link-cancel">Cancel</button></div>
        </div>
        <button class="btn small ghost" data-act="g-link-add">+ link</button>
      </td>
      <td class="c-act"><button class="icon-btn" data-act="g-row-add" title="Insert row below" aria-label="Insert row below">＋</button><button class="icon-btn danger" data-act="g-row-del" title="Delete row" aria-label="Delete row">✕</button></td>
    </tr>`;
  }
  function renderSection(key) {
    const body = $(`[data-body="${key}"]`); if (!body || !notes) return;
    const list = notes[key];
    body.innerHTML = list.map((r, i) => rowHTML2(key, r, i, list.length)).join("");
    $$("textarea", body).forEach(autosize);
    const cnt = $(`[data-count="${key}"]`); if (cnt) cnt.textContent = list.length ? `${list.length} row${list.length === 1 ? "" : "s"}` : "";
    const tbl = body.closest("table"); if (tbl) tbl.hidden = !list.length;
  }
  function rowCtx(el) {
    const tr = el.closest("tr[data-gr]"); if (!tr || !notes) return {};
    const sec = tr.dataset.sec, list = notes[sec] || [];
    const i = list.findIndex(r => r.id === tr.dataset.gr);
    return { tr, sec, list, i, row: list[i] };
  }

  // ---------- PDF ----------
  async function exportPdf() {
    const base = openProject(); if (!base || !notes) return;
    const p = { ...base, ...patch };
    const det = [["Status", p.status || STATUSES[0].name], ["Type", p.type], ["Priority", p.priority],
      ["Project start date", fmtDate(p.startDate)], ["Deadline", fmtDate(p.deadline)], ["Assigned to", p.assigned], ["Description", p.description]]
      .filter(([, v]) => String(v || "").trim()).map(([l, v]) => `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>`).join("");
    const secHTML = SECTIONS.map(s => {
      const used = notes[s.key].filter(r => (r.note || "").trim() || (r.links || []).length);
      if (!used.length) return "";
      return `<h2 class="ps-h2">${esc(s.title.charAt(0) + s.title.slice(1).toLowerCase())}</h2>
        <table class="ps-script ps-mod"><thead><tr><th class="n">#</th><th>Note</th><th>Links</th></tr></thead><tbody>
        ${used.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${esc(r.note)}</td><td>${(r.links || []).map(l => { const u = safeUrl(l.url); return u ? `<div class="lk"><a href="${esc(u)}">${esc(l.label || defaultLabel(u))}</a><span class="u">${esc(u)}</span></div>` : ""; }).join("")}</td></tr>`).join("")}
        </tbody></table>`;
    }).join("");
    const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const old = $("#printSheet"); if (old) old.remove();
    const sheet = document.createElement("div");
    sheet.id = "printSheet"; sheet.className = "g";
    sheet.innerHTML = `<div class="ps-head"><img class="ps-g" src="graviton-print.png" alt=""><div class="ps-brand">Project desk</div><div class="ps-date">Exported ${esc(today)}</div></div>
      <h1 class="ps-title">${esc(p.name || "Untitled")}</h1>
      <table class="ps-details"><tbody>${det}</tbody></table>
      ${secHTML || `<p class="ps-voicestat">No notes yet.</p>`}
      <p class="ps-foot">${esc(G_CREDIT)}</p>`;
    document.body.appendChild(sheet);
    const oldTitle = document.title;
    document.title = (String(p.name || "Project").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Project");
    const cleanup = () => { sheet.remove(); document.title = oldTitle; window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    await Promise.all($$("img", sheet).map(i => (i.decode ? i.decode().catch(() => {}) : Promise.resolve())));
    toast("Choose “Save as PDF” in the print window.");
    setTimeout(() => window.print(), 120);
  }

  // ============================================================
  //  EVENTS
  // ============================================================
  const onPage = () => /^g/.test(c.page().page || "");
  root.addEventListener("input", e => {
    if (!onPage()) return;
    const el = e.target;
    if (el.id === "gq") { S.q = el.value; renderList(); return; }
    if (c.page().page !== "gproject") return;
    if (el.dataset.gf) {
      if (!canEdit()) return;                                                  // only the edit login changes details
      const k = el.dataset.gf;
      if (k === "name" && !el.value.trim()) return;
      patch[k] = el.value; if (el.tagName === "TEXTAREA") autosize(el); scheduleHeader();
    } else if (el.dataset.gn) {
      const { row, sec } = rowCtx(el); if (!row) return;
      row[el.dataset.gn] = el.value; autosize(el); markNotes(sec);
    }
  });
  root.addEventListener("change", async e => {
    if (!onPage()) return;
    const el = e.target, act = el.dataset.act;
    try {
      if (el.dataset.gf === "type" || el.dataset.gf === "priority") {
        if (!canEdit()) return;
        patch[el.dataset.gf] = el.value; scheduleHeader(); return;
      }
      if (!act) return;
      if (act === "g-f-status") { S.fStatus = el.value; renderList(); }
      else if (act === "g-f-type") { S.fType = el.value; renderList(); }
      else if (act === "g-set-status") {
        const tr = el.closest("tr[data-gid]");
        el.style.setProperty("--c", statusObj(el.value).color);
        await updateDoc(doc(db(), "gprojects", tr.dataset.gid), { status: el.value, updatedAt: Date.now() });
      } else if (act === "g-tp-status") {
        el.style.setProperty("--c", statusObj(el.value).color);
        await updateDoc(doc(db(), "gprojects", openId), { status: el.value, updatedAt: Date.now() });
        setSave("Saved ✓", "ok");
      }
    } catch (err) { dataError(err); }
  });
  root.addEventListener("keydown", e => {
    const t = e.target;
    if (onPage() && t.matches && t.matches(".glf-url,.glf-label")) {
      const f = t.closest(".linkform");
      if (e.key === "Enter") { e.preventDefault(); $("[data-act=g-link-save]", f).click(); }
      if (e.key === "Escape") { e.preventDefault(); $("[data-act=g-link-cancel]", f).click(); }
    }
  });
  const ADMIN_ONLY = new Set(["g-new", "g-del", "g-del-open", "g-mv-up", "g-mv-down"]);
  root.addEventListener("click", async e => {
    if (!onPage()) return;
    if (!e.target.closest("[data-act]")) {
      const tr = e.target.closest("#gListArea tr[data-gid]");
      if (tr && !e.target.closest("select,a,input,.handle")) location.hash = "#/g/project/" + tr.dataset.gid;
      return;
    }
    const btn = e.target.closest("[data-act]"), act = btn.dataset.act;
    if (!act.startsWith("g-") || btn.tagName === "SELECT" || btn.tagName === "OPTION") return;
    if (!canEdit() && ADMIN_ONLY.has(act)) return;                             // view login can never create / delete / reorder
    switch (act) {
      case "g-new": openNew(); return;
      case "g-view": S.view = btn.dataset.view; store.set("graviton.view", S.view); updateViewButtons(); renderList(); return;
      case "g-toggle": { const k = btn.dataset.key; S.collapsed[k] = !S.collapsed[k]; store.set("graviton.collapsed", S.collapsed); renderList(); return; }
      case "g-mv-up": case "g-mv-down": {
        const tr = btn.closest("tr[data-gid]"), ids = $$("tr[data-gid]", tr.parentElement).map(r => r.dataset.gid);
        const i = ids.indexOf(tr.dataset.gid), j = i + (act === "g-mv-up" ? -1 : 1);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]]; await applyOrder(ids); return;
      }
      case "g-del": { const p = S.projects.find(x => x.id === btn.closest("tr[data-gid]").dataset.gid); if (p) openDelete(p); return; }
      case "g-del-open": { const p = openProject(); if (p) openDelete(p); return; }
      case "g-export": await exportPdf(); return;
      case "g-add-row": {
        const sec = btn.dataset.sec; if (!notes) return;
        notes[sec].push(newRow()); renderSection(sec); markNotes(sec);
        const tas = $$(`[data-body="${sec}"] textarea`); if (tas.length) tas[tas.length - 1].focus();
        return;
      }
    }
    const { tr, sec, list, i, row } = rowCtx(btn); if (!row) return;
    const redraw = () => renderSection(sec);
    switch (act) {
      case "g-row-up": if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); markNotes(sec); } break;
      case "g-row-down": if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; redraw(); markNotes(sec); } break;
      case "g-row-add": {
        list.splice(i + 1, 0, newRow()); redraw(); markNotes(sec);
        const tas = $$(`[data-body="${sec}"] textarea`); if (tas[i + 1]) tas[i + 1].focus();
        break;
      }
      case "g-row-del":
        if ((!row.note && !(row.links || []).length) || btn.dataset.armed) { list.splice(i, 1); redraw(); markNotes(sec); }
        else {
          btn.dataset.armed = "1"; btn.textContent = "Sure?"; btn.classList.add("armed");
          setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "✕"; btn.classList.remove("armed"); } }, 2500);
        }
        break;
      case "g-link-add": { const f = $(".linkform", tr); f.hidden = false; btn.hidden = true; $(".glf-url", f).focus(); break; }
      case "g-link-cancel": { $(".linkform", tr).hidden = true; $("[data-act=g-link-add]", tr).hidden = false; break; }
      case "g-link-save": {
        const f = $(".linkform", tr), urlEl = $(".glf-url", f), url = safeUrl(urlEl.value);
        if (!url) { urlEl.classList.add("bad"); urlEl.focus(); break; }
        row.links = [...(row.links || []), { url, label: $(".glf-label", f).value.trim() }];
        redraw(); markNotes(sec); break;
      }
      case "g-link-rm": row.links.splice(Number(btn.dataset.i), 1); redraw(); markNotes(sec); break;
    }
  });

  return {
    start, stop, isLoaded, renderHome, renderProject, onData, leave, discard,
    flush: () => { flushHeader(); flushNotes(); }
  };
}
