// ============================================================
//  CURISM Shorts planner
//  Plain JavaScript + Firebase (Auth + Firestore). No build step.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as cfg from "./firebase-config.js";

const firebaseConfig = cfg.firebaseConfig;
const SHARED_EMAIL = String(cfg.SHARED_EMAIL || "").toLowerCase();                       // admin (edit) account
const VIEWER_EMAIL = String(cfg.VIEWER_EMAIL || "curism-viewer@example.com").toLowerCase(); // view-only account
const CREDIT = "Made by Unmesh Khare for CURISM";

// ---------- settings you may want to edit ----------
const STATUSES = [
  { name: "Not started yet",  color: "#9a9482" },
  { name: "Researching",      color: "#6fb7ff" },
  { name: "Scripting",        color: "#b79cff" },
  { name: "Script ready",     color: "#4fe0c4" },
  { name: "Voiceover done",   color: "#ff7ac6" },
  { name: "Animating",        color: "#ff9a3c" },
  { name: "Editing & review", color: "#fdcb06" },
  { name: "Video complete",   color: "#6dffb0" },
  { name: "On hold",          color: "#6b6858" }
];
const DONE_STATUS = "Video complete";          // topics with this status sink to the bottom
const SAMPLE_CATEGORY = { id: "c-how-things-work", name: "How Things Work" };
const PRIORITIES = ["", "Low", "Medium", "High"];

// Fields shown on each topic page (after name / status / category / priority)
const FIELDS = [
  { key: "writer",        label: "Writer",                type: "text" },
  { key: "startDate",     label: "Project starting date", type: "date" },
  { key: "project",       label: "Project",               type: "text", ph: "e.g. 3476 - working title" },
  { key: "link",          label: "Link",                  type: "url" },
  { key: "researchUrl",   label: "Research document",     type: "url" },
  { key: "description",   label: "Description",           type: "area", ph: "Short description (shown on the front page)" },
  { key: "writerNotes",   label: "Writer notes",          type: "area" },
  { key: "animatorNotes", label: "Animator notes",        type: "area" },
  { key: "version",       label: "Version",               type: "text", ph: "V1" },
  { key: "publishDate",   label: "Target publish date",   type: "date" },
  { key: "length",        label: "Estimated length",      type: "text", ph: "e.g. 45 sec" },
  { key: "titles",        label: "Title options",         type: "titles" },
  { key: "finalUrl",      label: "Final video link",      type: "url" }
];

// ---------- tiny helpers ----------
const root = document.getElementById("app");
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
};
const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const statusObj = n => STATUSES.find(s => s.name === n) || STATUSES[0];
const isDone = t => t.status === DONE_STATUS;
const autosize = el => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };

function safeUrl(v) {
  v = (v || "").trim();
  if (!v) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = "https://" + v;
  try { const u = new URL(v); return (u.protocol === "http:" || u.protocol === "https:") ? u.href : ""; } catch { return ""; }
}
function linkKind(u) {
  if (/youtube\.com|youtu\.be|vimeo\.com|\.(mp4|mov|webm)(\?|$)/i.test(u)) return "video";
  if (/\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(u)) return "image";
  return "link";
}
function defaultLabel(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return /youtube\.com|youtu\.be/.test(h) ? "YouTube" : h;
  } catch { return "Link"; }
}
let toastTimer;
function toast(msg) {
  const el = $("#toast"); if (!el) return;
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ---------- state ----------
const state = {
  topics: [], cats: [], topicsLoaded: false, catsLoaded: false,
  view: store.get("curism.view", "all"),
  q: "", fStatus: "", fCat: "",
  collapsed: store.get("curism.collapsed", {})
};
let current = { page: "boot" };
let unsubs = [];

// ---------- firebase ----------
const configured = !String(firebaseConfig.apiKey || "").startsWith("PASTE");
let auth, db;
if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
}
// Who is signed in? Only the admin account may change anything (Firestore rules enforce this too).
const canEdit = () => !!(auth && auth.currentUser && String(auth.currentUser.email || "").toLowerCase() === SHARED_EMAIL);
const ROLE_KEY = "curism.role";
const catName = t => (state.cats.find(c => c.id === catIdOf(t)) || {}).name || "Uncategorized";

function authMsg(e) {
  const c = e && e.code;
  if (["auth/invalid-credential", "auth/wrong-password", "auth/invalid-login-credentials"].includes(c)) return "Wrong password.";
  if (c === "auth/user-not-found") return "That account was not found. Create it in Firebase > Authentication > Users.";
  if (c === "auth/too-many-requests") return "Too many attempts. Wait a few minutes and try again.";
  if (c === "auth/network-request-failed") return "No connection.";
  if (c === "auth/operation-not-allowed") return "Email/Password sign-in is not switched on in Firebase.";
  return "Could not sign in (" + (c || "error") + ").";
}

// ---------- lock screen ----------
function renderLock(msg = "") {
  current = { page: "lock" };
  if (!configured) {
    root.innerHTML = `<div class="lock"><div class="lock-card setup-note">
      <img class="logo big" src="logo.png" alt="Curism">
      <img class="wordmark big" src="wordmark.png" alt="curism">
      <p class="tagline">Setup needed</p>
      <p style="font-size:14px;color:var(--text)">Open <b>firebase-config.js</b> and paste your Firebase settings, then upload it again to GitHub.</p>
    </div></div>`;
    return;
  }
  let role = store.get(ROLE_KEY, "viewer") === "admin" ? "admin" : "viewer";
  root.innerHTML = `<div class="lock"><form class="lock-card" id="lockForm">
    <img class="logo big" src="logo.png" alt="Curism">
    <img class="wordmark big" src="wordmark.png" alt="curism">
    <p class="tagline">Shorts planner</p>
    <div class="seg role-seg" role="group" aria-label="Access level">
      <button type="button" data-role="viewer" class="${role === "viewer" ? "on" : ""}">View</button>
      <button type="button" data-role="admin" class="${role === "admin" ? "on" : ""}">Edit</button>
    </div>
    <input class="inp" id="pw" type="password" autocomplete="current-password" placeholder="password" aria-label="Password" autofocus>
    <button class="btn primary wide" type="submit">Enter</button>
    <p class="err" id="lockErr">${esc(msg)}</p>
  </form></div>`;
  $$("[data-role]").forEach(b => b.addEventListener("click", () => {
    role = b.dataset.role; store.set(ROLE_KEY, role);
    $$("[data-role]").forEach(x => x.classList.toggle("on", x === b));
    $("#lockErr").textContent = ""; $("#pw").focus();
  }));
  $("#lockForm").addEventListener("submit", async e => {
    e.preventDefault();
    const pw = $("#pw").value; if (!pw) return;
    const btn = $("#lockForm button[type=submit]"); btn.disabled = true;
    try { await signInWithEmailAndPassword(auth, role === "admin" ? SHARED_EMAIL : VIEWER_EMAIL, pw); }
    catch (err) {
      btn.disabled = false;
      const m = authMsg(err);
      $("#lockErr").textContent = m === "Wrong password." ? `Wrong password for ${role === "admin" ? "edit" : "view"} access.` : m;
      $("#pw").select();
    }
  });
}

// ---------- data ----------
function startData() {
  stopData();
  state.topicsLoaded = false; state.catsLoaded = false;
  unsubs.push(onSnapshot(collection(db, "topics"), snap => {
    state.topics = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.topicsLoaded = true; onData();
  }, dataError));
  unsubs.push(onSnapshot(doc(db, "meta", "categories"), snap => {
    if (!snap.exists()) {
      state.cats = [];
      if (!snap.metadata.fromCache && canEdit()) setDoc(doc(db, "meta", "categories"), { list: [SAMPLE_CATEGORY] }).catch(dataError);
    } else state.cats = snap.data().list || [];
    state.catsLoaded = true; onData();
  }, dataError));
  route();
}
function stopData() { unsubs.forEach(u => u()); unsubs = []; }
function dataError(err) {
  console.error(err);
  toast(err && err.code === "permission-denied"
    ? "Database says no access. Check the Firestore rules."
    : "Database error: " + ((err && (err.code || err.message)) || "unknown"));
}

function catIdOf(t) { return state.cats.some(c => c.id === t.categoryId) ? t.categoryId : ""; }
function sortTopics(list) {
  return list.slice().sort((a, b) =>
    (isDone(a) - isDone(b)) || ((a.order ?? 0) - (b.order ?? 0)) || ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || a.id.localeCompare(b.id));
}
const catOptions = sel => `<option value="">Uncategorized</option>` +
  state.cats.map(c => `<option value="${esc(c.id)}"${c.id === sel ? " selected" : ""}>${esc(c.name)}</option>`).join("");
const statusOptions = sel => STATUSES.map(s => `<option value="${esc(s.name)}"${s.name === sel ? " selected" : ""}>${esc(s.name)}</option>`).join("");
const saveCats = list => setDoc(doc(db, "meta", "categories"), { list });

function onData() {
  if (!(state.topicsLoaded && state.catsLoaded)) return;
  if (current.page === "loading") { route(); return; }
  if (current.page === "home") { refreshFilters(); renderList(); }
  else if (current.page === "topic") {
    const t = openTopic();
    if (!t) { discardPending(); location.hash = "#/"; toast("That topic no longer exists."); }
    else fillHeader(t);
  }
  if (catModal && !(document.activeElement && document.activeElement.matches("input") && catModal.contains(document.activeElement))) renderCatList();
}

// ---------- routing ----------
function route() {
  document.body.classList.toggle("ro", !!(auth && auth.currentUser) && !canEdit());
  if (!auth || !auth.currentUser) { renderLock(); return; }
  leaveTopic();
  if (!(state.topicsLoaded && state.catsLoaded)) {
    current = { page: "loading" };
    root.innerHTML = `<div class="loading"><img class="logo big" src="logo.png" alt=""><p class="muted">Loading…</p></div>`;
    return;
  }
  const m = (location.hash || "#/").match(/^#\/topic\/([^/?]+)/);
  if (m) renderTopic(decodeURIComponent(m[1])); else renderHome();
}
window.addEventListener("hashchange", route);

if (configured) {
  onAuthStateChanged(auth, user => { if (user) startData(); else { stopData(); renderLock(); } });
} else renderLock();

// ============================================================
//  HOME PAGE
// ============================================================
function renderHome() {
  current = { page: "home" };
  root.innerHTML = `<div class="wrap">
    <header class="top">
      <div class="brand"><img class="logo" src="logo.png" alt="Curism logo"><div class="brand-text"><img class="wordmark" src="wordmark.png" alt="curism"><p class="tagline">Shorts planner</p></div></div>
      <div class="top-actions">
        ${canEdit() ? `<button class="btn primary" data-act="new">+ New topic</button>
        <button class="btn" data-act="cats">Categories</button>` : `<span class="badge" title="You can view, copy, open links and export, but not change anything">View only</span>`}
        <button class="btn ghost" data-act="lock">Lock</button>
      </div>
    </header>
    <section class="controls ${state.view === "cat" ? "view-cat" : ""}" id="controls">
      <div class="seg">
        <button data-act="view" data-view="all">All topics</button>
        <button data-act="view" data-view="cat">By category</button>
      </div>
      <input class="inp" id="q" type="search" placeholder="Search topics…" value="${esc(state.q)}" aria-label="Search">
      <select class="sel" id="fStatus" data-act="f-status" aria-label="Filter by status"></select>
      <select class="sel" id="fCat" data-act="f-cat" aria-label="Filter by category"></select>
      <span class="muted" id="count"></span>
    </section>
    <main id="listArea"></main>
    <p class="foot">${esc(CREDIT)}</p>
  </div>`;
  refreshFilters(); updateViewButtons(); renderList();
}
function updateViewButtons() {
  $$("[data-act=view]").forEach(b => b.classList.toggle("on", b.dataset.view === state.view));
  const c = $("#controls"); if (c) c.classList.toggle("view-cat", state.view === "cat");
}
function refreshFilters() {
  const fs = $("#fStatus"), fc = $("#fCat"); if (!fs || !fc) return;
  fs.innerHTML = `<option value="">All statuses</option><option value="__active">Not complete</option>` +
    STATUSES.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
  fs.value = state.fStatus;
  fc.innerHTML = `<option value="">All categories</option>` +
    state.cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("") +
    `<option value="__none">Uncategorized</option>`;
  fc.value = state.fCat;
  if (fc.value !== state.fCat) state.fCat = "";
}
function visibleTopics() {
  const q = state.q.trim().toLowerCase();
  return state.topics.filter(t => {
    if (q && !`${t.name || ""} ${t.description || ""} ${t.project || ""}`.toLowerCase().includes(q)) return false;
    if (state.fStatus === "__active") { if (isDone(t)) return false; }
    else if (state.fStatus && t.status !== state.fStatus) return false;
    if (state.view === "all" && state.fCat) {
      const cid = catIdOf(t);
      if (state.fCat === "__none" ? cid !== "" : cid !== state.fCat) return false;
    }
    return true;
  });
}
function rowHTML(t, i, items) {
  const ed = canEdit();
  const done = isDone(t), st = statusObj(t.status);
  const prev = items[i - 1], next = items[i + 1];
  const upOff = !prev || isDone(prev) !== done;
  const downOff = !next || isDone(next) !== done;
  const firstDone = done && i > 0 && !isDone(prev);
  return `<tr data-id="${esc(t.id)}" class="${done ? "done" : ""}${firstDone ? " first-done" : ""}">
    ${ed ? `<td class="c-move"><span class="handle" title="Drag to reorder">⋮⋮</span><span class="arrows">
      <button class="icon-btn" data-act="mv-up" ${upOff ? "disabled" : ""} title="Move up" aria-label="Move up">↑</button>
      <button class="icon-btn" data-act="mv-down" ${downOff ? "disabled" : ""} title="Move down" aria-label="Move down">↓</button></span></td>` : ""}
    <td class="c-name"><a href="#/topic/${esc(t.id)}">${esc(t.name || "Untitled")}</a>${t.project ? `<div class="sub">${esc(t.project)}</div>` : ""}</td>
    <td class="c-desc">${esc(t.description || "")}</td>
    <td class="c-cat">${ed
      ? `<select class="sel" data-act="set-cat" aria-label="Category">${catOptions(catIdOf(t))}</select>`
      : `<span class="ro-text">${esc(catName(t))}</span>`}</td>
    <td class="c-status">${ed
      ? `<select class="sel status" data-act="set-status" style="--c:${st.color}" aria-label="Status">${statusOptions(t.status)}</select>`
      : `<span class="pill-ro" style="--c:${st.color}">${esc(t.status || STATUSES[0].name)}</span>`}</td>
    ${ed ? `<td class="c-del"><button class="icon-btn danger" data-act="del-topic" title="Delete topic" aria-label="Delete topic">✕</button></td>` : ""}
  </tr>`;
}
function tableHTML(items) {
  const ed = canEdit();
  return `<table class="list-table"><thead><tr>${ed ? "<th></th>" : ""}<th>Topic</th><th>Description</th><th>Category</th><th>Status</th>${ed ? "<th></th>" : ""}</tr></thead>
    <tbody>${items.map((t, i) => rowHTML(t, i, items)).join("")}</tbody></table>`;
}
function renderList() {
  const area = $("#listArea"); if (!area) return;
  const vis = sortTopics(visibleTopics());
  const total = state.topics.length;
  $("#count").textContent = total ? `${vis.length} of ${total} topics · ${state.topics.filter(isDone).length} complete` : "";
  if (!total) {
    area.innerHTML = `<div class="empty"><p>No topics yet.</p>${canEdit() ? `<button class="btn primary" data-act="new">+ Create your first topic</button>` : ""}</div>`;
    return;
  }
  if (!vis.length) { area.innerHTML = `<div class="empty"><p>No topics match your filters.</p></div>`; return; }
  if (state.view === "all") {
    area.innerHTML = `<div class="card">${tableHTML(vis)}</div>`;
  } else {
    const groups = state.cats.map(c => ({ id: c.id, name: c.name, items: [] }));
    const none = { id: "", name: "Uncategorized", items: [] };
    vis.forEach(t => (groups.find(g => g.id === catIdOf(t)) || none).items.push(t));
    groups.push(none);
    const filtering = state.q || state.fStatus;
    area.innerHTML = groups.filter(g => g.items.length || (!filtering && g.id !== "")).map(g => {
      const key = g.id || "__none", col = !!state.collapsed[key];
      return `<section class="group ${col ? "collapsed" : ""}">
        <button class="group-head" data-act="toggle" data-key="${esc(key)}" aria-expanded="${!col}">
          <span class="chev"></span><span class="gname">${esc(g.name)}</span><span class="gcount">${g.items.length}</span></button>
        <div class="card group-body">${g.items.length ? tableHTML(g.items) : `<div class="group-empty">No topics in this category yet.</div>`}</div>
      </section>`;
    }).join("");
  }
  if (window.Sortable && canEdit()) {
    $$("#listArea tbody").forEach(tb => window.Sortable.create(tb, {
      handle: ".handle", animation: 160, ghostClass: "drag-ghost", forceFallback: false,
      onEnd: () => applyOrder($$("tr[data-id]", tb).map(tr => tr.dataset.id))
    }));
  }
}
// Reassign the existing order numbers among the given topics, in the new sequence.
async function applyOrder(ids) {
  const byId = Object.fromEntries(state.topics.map(t => [t.id, t]));
  ids = ids.filter(id => byId[id]);
  const orders = ids.map(id => byId[id].order ?? 0).sort((a, b) => a - b);
  const batch = writeBatch(db); let n = 0;
  ids.forEach((id, k) => {
    if (byId[id].order !== orders[k]) { batch.update(doc(db, "topics", id), { order: orders[k] }); n++; }
  });
  try { if (n) await batch.commit(); else renderList(); } catch (e) { dataError(e); }
}

// ============================================================
//  MODALS
// ============================================================
function modal(html) {
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  wrap.close = () => { wrap.remove(); if (wrap.onClose) wrap.onClose(); };
  wrap.addEventListener("mousedown", e => { if (e.target === wrap) wrap.close(); });
  wrap.addEventListener("click", e => { if (e.target.closest("[data-close]")) wrap.close(); });
  return wrap;
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { const m = $$(".modal-wrap").pop(); if (m && m.close) m.close(); }
});

function openNewTopic() {
  const preset = state.view === "all" && state.cats.some(c => c.id === state.fCat) ? state.fCat : "";
  const m = modal(`<h3>New topic</h3>
    <form id="ntForm">
      <label for="nt-name">Topic name</label>
      <input class="inp" id="nt-name" required maxlength="140" autocomplete="off" placeholder="e.g. Why farmers use blow torches on cow udders">
      <label for="nt-desc">Short description</label>
      <textarea class="inp area" id="nt-desc" rows="3" placeholder="One or two lines about this Short"></textarea>
      <label for="nt-cat">Category</label>
      <select class="sel" id="nt-cat">${catOptions(preset)}<option value="__new">+ New category…</option></select>
      <input class="inp hidden" id="nt-newcat" maxlength="60" placeholder="New category name" style="margin-top:8px">
      <p class="err" id="nt-err"></p>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Create &amp; open</button></div>
    </form>`);
  const sel = $("#nt-cat", m), nc = $("#nt-newcat", m);
  sel.addEventListener("change", () => { nc.classList.toggle("hidden", sel.value !== "__new"); if (sel.value === "__new") nc.focus(); });
  $("#nt-desc", m).addEventListener("input", e => autosize(e.target));
  $("#nt-name", m).focus();
  $("#ntForm", m).addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#nt-name", m).value.trim(); if (!name) return;
    const btn = $("button[type=submit]", m); btn.disabled = true;
    try {
      let categoryId = sel.value;
      if (categoryId === "__new") {
        const nm = nc.value.trim();
        if (!nm) { btn.disabled = false; nc.focus(); return; }
        const existing = state.cats.find(c => c.name.toLowerCase() === nm.toLowerCase());
        if (existing) categoryId = existing.id;
        else { const c = { id: newId("c"), name: nm }; await saveCats([...state.cats, c]); categoryId = c.id; }
      }
      const ref = doc(collection(db, "topics"));
      const maxOrder = Math.max(0, ...state.topics.map(t => t.order ?? 0));
      const now = Date.now();
      const batch = writeBatch(db);
      batch.set(ref, {
        name, description: $("#nt-desc", m).value.trim(), categoryId, status: STATUSES[0].name,
        order: maxOrder + 1, version: "V1", createdAt: now, updatedAt: now
      });
      batch.set(doc(db, "scripts", ref.id), { rows: [newRow()], updatedAt: now });
      await batch.commit();
      m.close();
      location.hash = "#/topic/" + ref.id;
    } catch (err) { btn.disabled = false; $("#nt-err", m).textContent = "Could not create: " + (err.code || err.message); }
  });
}

function openDeleteModal(t) {
  const m = modal(`<h3>Delete topic</h3>
    <p>This permanently deletes <b>${esc(t.name)}</b> and its whole script. It cannot be undone.</p>
    <label for="dn">Type the topic name to confirm</label>
    <input class="inp" id="dn" autocomplete="off" placeholder="${esc(t.name)}">
    <label for="dp">Password</label>
    <input class="inp" id="dp" type="password" autocomplete="current-password">
    <p class="err" id="derr"></p>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="dgo" disabled>Delete forever</button></div>`);
  const dn = $("#dn", m), dp = $("#dp", m), go = $("#dgo", m), err = $("#derr", m);
  const check = () => { go.disabled = !(dn.value.trim().toLowerCase() === (t.name || "").trim().toLowerCase() && dp.value.length > 0); };
  dn.addEventListener("input", check); dp.addEventListener("input", check);
  dp.addEventListener("keydown", e => { if (e.key === "Enter" && !go.disabled) go.click(); });
  dn.focus();
  go.addEventListener("click", async () => {
    go.disabled = true; err.textContent = "";
    try {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(SHARED_EMAIL, dp.value));
    } catch (e) { err.textContent = authMsg(e); go.disabled = false; return; }
    try {
      if (current.page === "topic" && current.id === t.id) { discardPending(); location.hash = "#/"; }
      const b = writeBatch(db);
      b.delete(doc(db, "topics", t.id));
      b.delete(doc(db, "scripts", t.id));
      await b.commit();
      m.close(); toast("Topic deleted.");
    } catch (e) { err.textContent = "Could not delete: " + (e.code || e.message); go.disabled = false; }
  });
}

let catModal = null;
function openCats() {
  const m = modal(`<h3>Categories</h3>
    <p class="muted" style="font-size:13.5px;margin:0 0 14px">Rename them anytime. Deleting a category keeps its topics and moves them to “Uncategorized”.</p>
    <div id="catList"></div>
    <form class="cat-add" id="catAdd"><input class="inp" id="catNew" maxlength="60" placeholder="New category name" autocomplete="off"><button class="btn primary small" type="submit">Add</button></form>
    <div class="modal-actions"><button class="btn ghost" data-close>Done</button></div>`);
  catModal = m; m.onClose = () => { catModal = null; };
  renderCatList();
  $("#catAdd", m).addEventListener("submit", async e => {
    e.preventDefault();
    const inp = $("#catNew", m), nm = inp.value.trim(); if (!nm) return;
    if (state.cats.some(c => c.name.toLowerCase() === nm.toLowerCase())) { toast("That category already exists."); return; }
    inp.value = "";
    try { await saveCats([...state.cats, { id: newId("c"), name: nm }]); } catch (err) { dataError(err); }
  });
  m.addEventListener("change", async e => {
    const inp = e.target.closest("[data-act=cat-rename]"); if (!inp) return;
    const id = inp.closest(".cat-row").dataset.id, nm = inp.value.trim();
    if (!nm) { renderCatList(); return; }
    try { await saveCats(state.cats.map(c => c.id === id ? { ...c, name: nm } : c)); } catch (err) { dataError(err); }
  });
  m.addEventListener("click", async e => {
    const btn = e.target.closest("[data-act=cat-del]"); if (!btn) return;
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1"; btn.textContent = "Delete?"; btn.classList.add("armed");
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "✕"; btn.classList.remove("armed"); } }, 2800);
      return;
    }
    const id = btn.closest(".cat-row").dataset.id;
    try {
      const b = writeBatch(db);
      b.set(doc(db, "meta", "categories"), { list: state.cats.filter(c => c.id !== id) });
      state.topics.filter(t => t.categoryId === id).forEach(t => b.update(doc(db, "topics", t.id), { categoryId: "" }));
      await b.commit();
    } catch (err) { dataError(err); }
  });
}
function renderCatList() {
  const box = catModal && $("#catList", catModal); if (!box) return;
  box.innerHTML = state.cats.length ? state.cats.map(c => {
    const n = state.topics.filter(t => t.categoryId === c.id).length;
    return `<div class="cat-row" data-id="${esc(c.id)}"><input class="inp" data-act="cat-rename" value="${esc(c.name)}" maxlength="60" aria-label="Category name">
      <span class="muted">${n} topic${n === 1 ? "" : "s"}</span>
      <button class="icon-btn danger" data-act="cat-del" title="Delete category" aria-label="Delete category">✕</button></div>`;
  }).join("") : `<p class="muted">No categories yet.</p>`;
}

// ============================================================
//  TOPIC PAGE
// ============================================================
let openTopicId = null, scriptUnsub = null;
let rows = null, rowsDirty = false, rowsTimer = null;
let headerPatch = {}, hdrTimer = null;

const newRow = () => ({ id: newId("r"), line: "", anim: "", links: [] });
const cleanRow = r => ({ id: r.id, line: r.line || "", anim: r.anim || "", links: (r.links || []).map(l => ({ url: l.url, label: l.label || "" })) });
// modellers' notes: a second list on the same page (note + links)
let mrows = null;
const newMRow = () => ({ id: newId("m"), note: "", links: [] });
const cleanMRow = r => ({ id: r.id, note: r.note || "", links: (r.links || []).map(l => ({ url: l.url, label: l.label || "" })) });
const openTopic = () => state.topics.find(t => t.id === openTopicId);
function setSave(text, cls = "") { const el = $("#saveState"); if (el) { el.textContent = text; el.className = "save-state " + cls; } }

function fieldInput(f) {
  const ed = canEdit(), ro = ed ? "" : " readonly";
  const ph = f.ph && ed ? ` placeholder="${esc(f.ph)}"` : "";
  if (f.type === "titles") return `<div class="titles" data-titles></div>`;
  if (f.type === "area") return `<textarea class="inp area" rows="1" data-field="${f.key}"${ph}${ro}></textarea>`;
  if (f.type === "date") return `<input class="inp" type="date" data-field="${f.key}"${ro}>`;
  if (f.type === "url") return `<div class="urlrow"><input class="inp" type="text" inputmode="url" data-field="${f.key}"${ed ? ' placeholder="https://…"' : ""}${ro}><a class="open" target="_blank" rel="noopener noreferrer" hidden title="Open link" aria-label="Open link">↗</a></div>`;
  return `<input class="inp" type="text" data-field="${f.key}"${ph}${ro}>`;
}

// ---- title options: a list you can add to / remove from ----
const titlesOf = t => Array.isArray(t.titles)
  ? t.titles.map(x => String(x ?? ""))
  : (String(t.hook ?? "").trim() ? [String(t.hook).trim()] : []);     // older topics kept one "hook" text
const collectTitles = () => $$(".title-opt").map(i => i.value.trim()).filter(Boolean);
const titleRowHTML = v => `<div class="title-row"><input class="inp title-opt" type="text" value="${esc(v)}" placeholder="Title option" aria-label="Title option"><button class="icon-btn danger" data-act="title-rm" title="Remove this option" aria-label="Remove title option">✕</button></div>`;
function renderTitles(t) {
  const box = $("[data-titles]"); if (!box) return;
  if ("titles" in headerPatch) return;                                  // your unsaved edits win
  const ed = canEdit();
  if (ed && box.contains(document.activeElement)) return;
  const list = titlesOf(t).filter(x => x.trim());
  if (!ed) {
    box.innerHTML = list.length ? `<ol class="title-list">${list.map(x => `<li>${esc(x)}</li>`).join("")}</ol>` : `<span class="muted">—</span>`;
    return;
  }
  box.innerHTML = list.map(titleRowHTML).join("") + `<button class="btn small ghost" data-act="title-add">+ Add title option</button>`;
}

function renderTopic(id) {
  const t = state.topics.find(x => x.id === id);
  if (!t) {
    current = { page: "missing" };
    root.innerHTML = `<div class="wrap"><div class="empty"><p>That topic was not found.</p><a class="btn" href="#/">← All topics</a></div></div>`;
    return;
  }
  current = { page: "topic", id }; openTopicId = id;
  rows = null; mrows = null; rowsDirty = false; headerPatch = {};
  const ed = canEdit();
  root.innerHTML = `<div class="wrap">
    <header class="top">
      <a class="btn ghost" href="#/">← All topics</a>
      <div class="top-actions">
        ${ed ? `<span class="save-state" id="saveState"></span>` : `<span class="badge" title="You can view, copy, open links and export, but not change anything">View only</span>`}
        <button class="btn" data-act="export-pdf">Export PDF</button>
        ${ed ? `<button class="btn danger" data-act="delete-topic">Delete</button>` : ""}
        <button class="btn ghost" data-act="lock">Lock</button>
      </div>
    </header>
    <section class="titlebar">
      <input class="inp title-input" data-field="name" placeholder="Topic name" aria-label="Topic name"${ed ? "" : " readonly"}>
      <div class="pills">${ed ? `
        <label>Status<select class="sel status" id="tp-status" data-act="tp-status">${statusOptions("")}</select></label>
        <label>Category<select class="sel" id="tp-cat" data-act="tp-cat"></select></label>
        <label>Priority<select class="sel" data-field="priority">${PRIORITIES.map(p => `<option value="${p}">${p || "—"}</option>`).join("")}</select></label>` : `
        <label>Status<span class="pill-ro" id="ro-status"></span></label>
        <label>Category<span class="ro-text" id="ro-cat"></span></label>
        <label>Priority<span class="ro-text" id="ro-pri"></span></label>`}
      </div>
    </section>
    <section class="card details">${FIELDS.map(f => `<div class="d-label">${f.label}</div><div class="d-val">${fieldInput(f)}</div>`).join("")}</section>
    <section class="card">
      <div class="script-head"><h2>MODELLERS’ NOTES</h2><span class="muted" id="mrowCount"></span></div>
      <table class="script-table mod-table">
        <thead><tr><th>#</th><th>Note</th><th>Links</th>${ed ? "<th></th>" : ""}</tr></thead>
        <tbody id="mrows"></tbody>
      </table>
      <p class="muted empty-note" id="mEmpty" hidden>No notes for the modellers yet.</p>
      ${ed ? `<div class="script-foot"><button class="btn" data-act="add-mrow-end">+ Add row</button></div>` : ""}
    </section>
    <section class="card">
      <div class="script-head"><h2>SCRIPT</h2><span class="muted" id="rowCount"></span>
        <button class="btn small" data-act="copy-voice" title="Copy all script lines as one paragraph">Copy as paragraph</button></div>
      <table class="script-table">
        <thead><tr><th>#</th><th>Script line</th><th>Animation description</th><th>Reference links</th>${ed ? "<th></th>" : ""}</tr></thead>
        <tbody id="rows"></tbody>
      </table>
      ${ed ? `<div class="script-foot"><button class="btn" data-act="add-row-end">+ Add row</button></div>` : ""}
    </section>
    <section class="card voice">
      <div class="script-head"><h2>VOICEOVER TEXT</h2><span class="muted" id="voiceStats"></span></div>
      <div class="voice-body">
        <textarea class="inp area" id="voiceText" readonly rows="3" aria-label="Script as one paragraph" placeholder="Your script lines will appear here as one paragraph, ready to copy."></textarea>
        <div class="voice-actions"><button class="btn primary" data-act="copy-voice">Copy paragraph</button></div>
      </div>
    </section>
    <p class="foot">${esc(CREDIT)}</p>
  </div>`;
  fillHeader(t);
  scriptUnsub = onSnapshot(doc(db, "scripts", id), snap => {
    if (openTopicId !== id || snap.metadata.hasPendingWrites) return;
    const remote = snap.exists() ? (snap.data().rows || []) : [];
    const remoteM = snap.exists() ? (snap.data().mrows || []) : [];
    if (rows === null) { rows = remote.length ? remote : [newRow()]; mrows = remoteM; renderRows(); renderMRows(); return; }
    if (rowsDirty || (canEdit() && document.activeElement && document.activeElement.closest("#rows,#mrows"))) return;
    if (JSON.stringify(remote) === JSON.stringify(rows) && JSON.stringify(remoteM) === JSON.stringify(mrows)) return;
    rows = remote.length ? remote : [newRow()]; mrows = remoteM; renderRows(); renderMRows();
  }, dataError);
}

function fillHeader(t) {
  const active = document.activeElement;
  const setVal = (el, val, key) => { if (!el || el === active || (key in headerPatch)) return; if (el.value !== val) el.value = val; };
  setVal($("[data-field=name]"), t.name || "", "name");
  setVal($("[data-field=priority]"), t.priority || "", "priority");
  FIELDS.forEach(f => {
    const el = $(`[data-field="${f.key}"]`); if (!el) return;
    setVal(el, t[f.key] ?? "", f.key);
    if (f.type === "url") updateOpen(el);
    if (f.type === "area") autosize(el);
  });
  const ss = $("#tp-status");
  if (ss && ss !== active) { ss.value = t.status || STATUSES[0].name; ss.style.setProperty("--c", statusObj(t.status).color); }
  const sc = $("#tp-cat");
  if (sc && sc !== active) sc.innerHTML = catOptions(catIdOf(t));
  // view-only pages show plain text instead of dropdowns
  const rs = $("#ro-status"); if (rs) { rs.textContent = t.status || STATUSES[0].name; rs.style.setProperty("--c", statusObj(t.status).color); }
  const rc = $("#ro-cat"); if (rc) rc.textContent = catName(t);
  const rp = $("#ro-pri"); if (rp) rp.textContent = t.priority || "—";
  renderTitles(t);
}
function updateOpen(el) {
  const a = el.parentElement.querySelector(".open"); if (!a) return;
  const u = safeUrl(el.value); a.hidden = !u; a.href = u || "#";
}

function scheduleHeaderSave() { setSave("Saving…"); clearTimeout(hdrTimer); hdrTimer = setTimeout(flushHeader, 700); }
async function flushHeader() {
  clearTimeout(hdrTimer);
  const id = openTopicId;
  if (!id || !Object.keys(headerPatch).length) return;
  const patch = headerPatch; headerPatch = {};
  try { await updateDoc(doc(db, "topics", id), { ...patch, updatedAt: Date.now() }); if (openTopicId === id) setSave("Saved ✓", "ok"); }
  catch (e) {
    if (openTopicId === id) { headerPatch = { ...patch, ...headerPatch }; setSave("Save failed - retrying", "err"); hdrTimer = setTimeout(flushHeader, 4000); }
    dataError(e);
  }
}
function markRows() { rowsDirty = true; setSave("Saving…"); clearTimeout(rowsTimer); rowsTimer = setTimeout(flushRows, 700); }
async function flushRows() {
  clearTimeout(rowsTimer);
  const id = openTopicId;
  if (!id || !rowsDirty || !rows) return;
  const data = rows.map(cleanRow), mdata = (mrows || []).map(cleanMRow); rowsDirty = false;
  try { await setDoc(doc(db, "scripts", id), { rows: data, mrows: mdata, updatedAt: Date.now() }); if (openTopicId === id && !rowsDirty) setSave("Saved ✓", "ok"); }
  catch (e) {
    if (openTopicId === id) { rowsDirty = true; setSave("Save failed - retrying", "err"); rowsTimer = setTimeout(flushRows, 4000); }
    dataError(e);
  }
}
function discardPending() {
  clearTimeout(hdrTimer); clearTimeout(rowsTimer); headerPatch = {}; rowsDirty = false;
}
function leaveTopic() {
  if (current.page !== "topic") return;
  flushHeader(); flushRows();
  if (scriptUnsub) scriptUnsub(); scriptUnsub = null;
  openTopicId = null;
}
window.addEventListener("beforeunload", e => {
  if (rowsDirty || Object.keys(headerPatch).length) { flushRows(); flushHeader(); e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.hidden && current.page === "topic") { flushRows(); flushHeader(); } });

// ---- PDF export (clean white print layout -> browser "Save as PDF") ----
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v + "T00:00:00");
  return isNaN(d) ? v : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function psValue(f, v) {
  if (f.type === "url") { const u = safeUrl(v); return u ? `<a href="${esc(u)}">${esc(String(v).trim())}</a>` : esc(v); }
  if (f.type === "date") return esc(fmtDate(v));
  return esc(v);
}
async function exportPdf() {
  const base = openTopic(); if (!base || !rows) return;
  const t = { ...base, ...headerPatch };               // include anything typed but not yet saved
  const cat = state.cats.find(c => c.id === catIdOf(t));
  const meta = [["Status", t.status || STATUSES[0].name], ["Category", cat ? cat.name : "Uncategorized"]];
  if (t.priority) meta.push(["Priority", t.priority]);
  const detailRows = [
    ...meta.map(([l, v]) => `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>`),
    ...FIELDS.map(f => {
      if (f.type === "titles") {
        const list = titlesOf(t).map(x => x.trim()).filter(Boolean);
        return list.length ? `<tr><th>${esc(f.label)}</th><td><ol class="ps-titles">${list.map(x => `<li>${esc(x)}</li>`).join("")}</ol></td></tr>` : "";
      }
      return String(t[f.key] ?? "").trim() ? `<tr><th>${esc(f.label)}</th><td>${psValue(f, t[f.key])}</td></tr>` : "";
    })
  ].join("");
  const used = rows.filter(r => (r.line || "").trim() || (r.anim || "").trim() || (r.links || []).length);
  const scriptRows = used.length ? used.map((r, i) => `<tr>
      <td class="n">${i + 1}</td><td>${esc(r.line)}</td><td>${esc(r.anim)}</td>
      <td>${(r.links || []).map(l => { const u = safeUrl(l.url); return u ? `<div class="lk"><a href="${esc(u)}">${esc(l.label || defaultLabel(u))}</a><span class="u">${esc(u)}</span></div>` : ""; }).join("")}</td>
    </tr>`).join("") : `<tr><td colspan="4">No script rows yet.</td></tr>`;
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const vt = voiceText();
  const voiceHTML = vt
    ? `<h2 class="ps-h2">Voiceover text</h2><p class="ps-voice">${esc(vt)}</p><p class="ps-voicestat">${esc(voiceStatsText(vt))}</p>`
    : "";

  const mUsed = (mrows || []).filter(r => (r.note || "").trim() || (r.links || []).length);
  const modHTML = mUsed.length ? `<h2 class="ps-h2">Modellers’ notes</h2>
    <table class="ps-script ps-mod">
      <thead><tr><th class="n">#</th><th>Note</th><th>Links</th></tr></thead>
      <tbody>${mUsed.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${esc(r.note)}</td>
        <td>${(r.links || []).map(l => { const u = safeUrl(l.url); return u ? `<div class="lk"><a href="${esc(u)}">${esc(l.label || defaultLabel(u))}</a><span class="u">${esc(u)}</span></div>` : ""; }).join("")}</td></tr>`).join("")}</tbody>
    </table>` : "";

  const old = $("#printSheet"); if (old) old.remove();
  const sheet = document.createElement("div");
  sheet.id = "printSheet";
  sheet.innerHTML = `
    <div class="ps-head"><img src="logo.png" alt=""><div class="ps-brand">Curism · Shorts planner</div><div class="ps-date">Exported ${esc(today)}</div></div>
    <h1 class="ps-title">${esc(t.name || "Untitled")}</h1>
    <table class="ps-details"><tbody>${detailRows}</tbody></table>
    ${voiceHTML}
    ${modHTML}
    <h2 class="ps-h2">Script</h2>
    <table class="ps-script">
      <thead><tr><th class="n">#</th><th>Script line</th><th>Animation description</th><th>Reference links</th></tr></thead>
      <tbody>${scriptRows}</tbody>
    </table>
    <p class="ps-foot">${esc(CREDIT)}</p>`;
  document.body.appendChild(sheet);

  const oldTitle = document.title;
  document.title = (String(t.name || "Script").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Script");
  const cleanup = () => { sheet.remove(); document.title = oldTitle; window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  await Promise.all($$("img", sheet).map(i => (i.decode ? i.decode().catch(() => {}) : Promise.resolve())));
  toast("Choose “Save as PDF” in the print window.");
  setTimeout(() => window.print(), 120);
}

// ---- script rows ----
function chipHTML(l, k) {
  const u = safeUrl(l.url);
  const x = canEdit() ? `<button class="x" data-act="link-rm" data-i="${k}" title="Remove link" aria-label="Remove link">×</button>` : "";
  return `<span class="chip ${linkKind(u)}"><a href="${esc(u || "#")}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(l.label || defaultLabel(u))}</a>${x}</span>`;
}
function rowRowHTML(r, i) {
  const ed = canEdit(), ro = ed ? "" : " readonly";
  return `<tr data-rid="${esc(r.id)}">
    <td class="c-num" data-label=""><span class="num">${i + 1}</span>${ed ? `<span class="rowtools">
      <button class="icon-btn" data-act="row-up" ${i === 0 ? "disabled" : ""} title="Move up" aria-label="Move row up">↑</button>
      <button class="icon-btn" data-act="row-down" ${i === rows.length - 1 ? "disabled" : ""} title="Move down" aria-label="Move row down">↓</button></span>` : ""}</td>
    <td data-label="Script line"><textarea class="inp area" data-f="line" rows="1"${ro}${ed ? ' placeholder="Narration line…"' : ""}>\n${esc(r.line)}</textarea></td>
    <td data-label="Animation description"><textarea class="inp area" data-f="anim" rows="2"${ro}${ed ? ' placeholder="Frame-by-frame description for the animator…"' : ""}>\n${esc(r.anim)}</textarea></td>
    <td data-label="Reference links">
      <div class="links">${(r.links || []).map(chipHTML).join("")}</div>
      ${ed ? `<div class="linkform" hidden>
        <input class="inp lf-url" type="text" inputmode="url" placeholder="Paste link (image, video, YouTube…)">
        <input class="inp lf-label" type="text" placeholder="Label (optional)">
        <div class="lf-actions"><button class="btn small primary" data-act="link-save">Add</button><button class="btn small ghost" data-act="link-cancel">Cancel</button></div>
      </div>
      <button class="btn small ghost" data-act="link-add">+ link</button>` : ""}
    </td>
    ${ed ? `<td class="c-act"><button class="icon-btn" data-act="row-add" title="Insert row below" aria-label="Insert row below">＋</button><button class="icon-btn danger" data-act="row-del" title="Delete row" aria-label="Delete row">✕</button></td>` : ""}
  </tr>`;
}
function linksCellHTML(r, ed) {
  return `<div class="links">${(r.links || []).map(chipHTML).join("")}</div>
      ${ed ? `<div class="linkform" hidden>
        <input class="inp lf-url" type="text" inputmode="url" placeholder="Paste link (image, video, YouTube…)">
        <input class="inp lf-label" type="text" placeholder="Label (optional)">
        <div class="lf-actions"><button class="btn small primary" data-act="link-save">Add</button><button class="btn small ghost" data-act="link-cancel">Cancel</button></div>
      </div>
      <button class="btn small ghost" data-act="link-add">+ link</button>` : ""}`;
}
function mrowHTML(r, i) {
  const ed = canEdit(), ro = ed ? "" : " readonly";
  return `<tr data-rid="${esc(r.id)}" data-list="m">
    <td class="c-num" data-label=""><span class="num">${i + 1}</span>${ed ? `<span class="rowtools">
      <button class="icon-btn" data-act="row-up" ${i === 0 ? "disabled" : ""} title="Move up" aria-label="Move row up">↑</button>
      <button class="icon-btn" data-act="row-down" ${i === mrows.length - 1 ? "disabled" : ""} title="Move down" aria-label="Move row down">↓</button></span>` : ""}</td>
    <td data-label="Note"><textarea class="inp area" data-f="note" rows="2"${ro}${ed ? ' placeholder="Note for the modeller…"' : ""}>\n${esc(r.note)}</textarea></td>
    <td data-label="Links">${linksCellHTML(r, ed)}</td>
    ${ed ? `<td class="c-act"><button class="icon-btn" data-act="row-add" title="Insert row below" aria-label="Insert row below">＋</button><button class="icon-btn danger" data-act="row-del" title="Delete row" aria-label="Delete row">✕</button></td>` : ""}
  </tr>`;
}
function renderMRows() {
  const tb = $("#mrows"); if (!tb || !mrows) return;
  tb.innerHTML = mrows.map(mrowHTML).join("");
  $$("#mrows textarea").forEach(autosize);
  const rc = $("#mrowCount"); if (rc) rc.textContent = `${mrows.length} row${mrows.length === 1 ? "" : "s"}`;
  const tbl = tb.closest("table"); if (tbl) tbl.hidden = !mrows.length;
  const em = $("#mEmpty"); if (em) em.hidden = !!mrows.length || canEdit();
}
function renderRows() {
  const tb = $("#rows"); if (!tb || !rows) return;
  tb.innerHTML = rows.map(rowRowHTML).join("");
  $$("#rows textarea").forEach(autosize);
  const rc = $("#rowCount"); if (rc) rc.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  updateVoice();
}

// ---- voiceover paragraph: every script line joined into one paragraph ----
const voiceText = () => (rows || [])
  .map(r => String(r.line || "").replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join(" ");
function voiceStatsText(text) {
  const words = text ? text.split(/\s+/).length : 0;
  return words ? `${words} words · ${text.length} characters · ≈ ${Math.max(1, Math.round(words / 150 * 60))} sec read aloud` : "";
}
function updateVoice() {
  const ta = $("#voiceText"); if (!ta) return;
  const text = voiceText();
  ta.value = text; autosize(ta);
  const st = $("#voiceStats"); if (st) st.textContent = voiceStatsText(text);
}
async function copyVoice(btn) {
  const text = voiceText();
  if (!text) { toast("Nothing to copy yet. Add some script lines first."); return; }
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = $("#voiceText"); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length + 1);
    try { document.execCommand("copy"); } catch { toast("Could not copy. Select the text and copy it manually."); return; }
  }
  toast("Script copied as one paragraph.");
  const label = btn.textContent; btn.textContent = "Copied ✓";
  setTimeout(() => { if (btn.isConnected) btn.textContent = label; }, 1800);
}
function rowOf(el) {
  const tr = el.closest("tr[data-rid]"); if (!tr) return {};
  const m = tr.dataset.list === "m", list = (m ? mrows : rows) || [];
  const i = list.findIndex(r => r.id === tr.dataset.rid);
  return { tr, i, row: list[i], list, m };
}
function focusRow(i) { const tr = $$("#rows tr")[i]; if (tr) { const ta = $("textarea", tr); if (ta) ta.focus(); } }

// ============================================================
//  EVENTS (delegated, attached once)
// ============================================================
root.addEventListener("input", e => {
  const el = e.target;
  if (el.id === "q") { state.q = el.value; renderList(); return; }
  if (current.page !== "topic" || !canEdit()) return;                  // view-only users can never edit
  if (el.classList.contains("title-opt")) { headerPatch.titles = collectTitles(); scheduleHeaderSave(); return; }
  if (el.dataset.field) {
    const key = el.dataset.field;
    if (key === "name" && !el.value.trim()) return;
    headerPatch[key] = el.value;
    if (el.tagName === "TEXTAREA") autosize(el);
    if (el.type === "text" && el.closest(".urlrow")) updateOpen(el);
    scheduleHeaderSave();
  } else if (el.dataset.f && rows) {
    const { row, m } = rowOf(el); if (!row) return;
    row[el.dataset.f] = el.value; autosize(el); markRows(); if (!m) updateVoice();
  }
});

root.addEventListener("change", async e => {
  const el = e.target, act = el.dataset.act; if (!act) return;
  if (!canEdit() && ["set-status", "set-cat", "tp-status", "tp-cat"].includes(act)) return;
  try {
    if (act === "f-status") { state.fStatus = el.value; renderList(); }
    else if (act === "f-cat") { state.fCat = el.value; renderList(); }
    else if (act === "set-status") {
      const tr = el.closest("tr[data-id]");
      el.style.setProperty("--c", statusObj(el.value).color);
      await updateDoc(doc(db, "topics", tr.dataset.id), { status: el.value, updatedAt: Date.now() });
    } else if (act === "set-cat") {
      const tr = el.closest("tr[data-id]");
      await updateDoc(doc(db, "topics", tr.dataset.id), { categoryId: el.value, updatedAt: Date.now() });
    } else if (act === "tp-status") {
      el.style.setProperty("--c", statusObj(el.value).color);
      await updateDoc(doc(db, "topics", openTopicId), { status: el.value, updatedAt: Date.now() });
      setSave("Saved ✓", "ok");
    } else if (act === "tp-cat") {
      await updateDoc(doc(db, "topics", openTopicId), { categoryId: el.value, updatedAt: Date.now() });
      setSave("Saved ✓", "ok");
    }
  } catch (err) { dataError(err); }
});

root.addEventListener("keydown", e => {
  const t = e.target;
  if (t.matches && t.matches(".lf-url,.lf-label")) {
    if (e.key === "Enter") { e.preventDefault(); $("[data-act=link-save]", t.closest(".linkform")).click(); }
    if (e.key === "Escape") { e.preventDefault(); $("[data-act=link-cancel]", t.closest(".linkform")).click(); }
  }
});

const EDIT_ACTS = new Set(["new", "cats", "mv-up", "mv-down", "del-topic", "delete-topic", "add-row-end", "add-mrow-end",
  "row-up", "row-down", "row-add", "row-del", "link-add", "link-cancel", "link-save", "link-rm", "title-add", "title-rm"]);

root.addEventListener("click", async e => {
  if (e.target.id === "voiceText") { e.target.select(); return; }   // click selects the whole paragraph
  const btn = e.target.closest("[data-act]");
  if (!btn) {
    // click anywhere on a topic row (outside controls) opens it
    const tr = e.target.closest("#listArea tr[data-id]");
    if (tr && !e.target.closest("select,a,input,.handle")) location.hash = "#/topic/" + tr.dataset.id;
    return;
  }
  const act = btn.dataset.act;
  if (btn.tagName === "SELECT" || btn.tagName === "OPTION") return;
  if (!canEdit() && EDIT_ACTS.has(act)) return;                         // view-only users can never edit

  switch (act) {
    case "lock": discardPending(); leaveTopic(); await signOut(auth); return;
    case "new": openNewTopic(); return;
    case "cats": openCats(); return;
    case "view":
      state.view = btn.dataset.view; store.set("curism.view", state.view); updateViewButtons(); renderList(); return;
    case "toggle": {
      const k = btn.dataset.key; state.collapsed[k] = !state.collapsed[k]; store.set("curism.collapsed", state.collapsed); renderList(); return;
    }
    case "mv-up": case "mv-down": {
      const tr = btn.closest("tr[data-id]");
      const ids = $$("tr[data-id]", tr.parentElement).map(r => r.dataset.id);
      const i = ids.indexOf(tr.dataset.id), j = i + (act === "mv-up" ? -1 : 1);
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await applyOrder(ids); return;
    }
    case "del-topic": {
      const tr = btn.closest("tr[data-id]"); const t = state.topics.find(x => x.id === tr.dataset.id);
      if (t) openDeleteModal(t); return;
    }
    case "delete-topic": { const t = openTopic(); if (t) openDeleteModal(t); return; }
    case "export-pdf": await exportPdf(); return;
    case "copy-voice": await copyVoice(btn); return;
    case "add-row-end":
      rows.push(newRow()); renderRows(); focusRow(rows.length - 1); markRows(); return;
    case "add-mrow-end": {
      mrows.push(newMRow()); renderMRows(); markRows();
      const tas = $$("#mrows textarea"); if (tas.length) tas[tas.length - 1].focus();
      return;
    }
    case "title-add": {
      btn.insertAdjacentHTML("beforebegin", titleRowHTML(""));
      const inputs = $$(".title-opt", btn.parentElement); if (inputs.length) inputs[inputs.length - 1].focus();
      return;
    }
    case "title-rm":
      btn.closest(".title-row").remove(); headerPatch.titles = collectTitles(); scheduleHeaderSave(); return;
  }

  // script-row actions
  if (!rows) return;
  const { tr, i, row, list, m } = rowOf(btn); if (!row) return;
  const redraw = () => { if (m) renderMRows(); else renderRows(); };
  switch (act) {
    case "row-up": if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); markRows(); } break;
    case "row-down": if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; redraw(); markRows(); } break;
    case "row-add":
      list.splice(i + 1, 0, m ? newMRow() : newRow()); redraw();
      if (m) { const tas = $$("#mrows textarea"); if (tas[i + 1]) tas[i + 1].focus(); } else focusRow(i + 1);
      markRows(); break;
    case "row-del": {
      const empty = !(row.line || row.anim || row.note) && !(row.links || []).length;
      if (empty || btn.dataset.armed) {
        list.splice(i, 1); if (!list.length && !m) list.push(newRow()); redraw(); markRows();
      } else {
        btn.dataset.armed = "1"; btn.textContent = "Sure?"; btn.classList.add("armed");
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "✕"; btn.classList.remove("armed"); } }, 2500);
      }
      break;
    }
    case "link-add": {
      const f = $(".linkform", tr); f.hidden = false; btn.hidden = true; $(".lf-url", f).focus(); break;
    }
    case "link-cancel": {
      const f = $(".linkform", tr); f.hidden = true; $("[data-act=link-add]", tr).hidden = false; break;
    }
    case "link-save": {
      const f = $(".linkform", tr), urlEl = $(".lf-url", f), url = safeUrl(urlEl.value);
      if (!url) { urlEl.classList.add("bad"); urlEl.focus(); break; }
      row.links = [...(row.links || []), { url, label: $(".lf-label", f).value.trim() }];
      redraw(); markRows(); break;
    }
    case "link-rm": {
      row.links.splice(Number(btn.dataset.i), 1); redraw(); markRows(); break;
    }
  }
});
