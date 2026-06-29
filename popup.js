const countEl = document.getElementById("count");
const closeBtn = document.getElementById("close");
const autoCloseEl = document.getElementById("autoClose");
const askNewTabEl = document.getElementById("askNewTab");
const statusEl = document.getElementById("status");
const chipsEl = document.getElementById("chips");
const newNameEl = document.getElementById("newSessionName");
const addSessionBtn = document.getElementById("addSession");
const openTabsEl = document.getElementById("openTabs");
const tabCountEl = document.getElementById("tabCount");
const ignoreToggle = document.getElementById("ignoreToggle");
const ignoreWrap = document.getElementById("ignoreWrap");
const ignoreInput = document.getElementById("ignoreInput");
const ignoreAdd = document.getElementById("ignoreAdd");
const ignoreAddCurrent = document.getElementById("ignoreAddCurrent");
const ignoreList = document.getElementById("ignoreList");
const logToggle = document.getElementById("logToggle");
const logWrap = document.getElementById("logWrap");
const logEl = document.getElementById("log");
const clearLogBtn = document.getElementById("clearLog");

const AUTO_CLOSE_KEY = "autoClose";
const ASK_KEY = "askOnNewTab";

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}
function isHttp(url) {
  return !!url && (url.startsWith("http://") || url.startsWith("https://"));
}

// --- small helpers --------------------------------------------------------

function range(start, end, step = 1) {
  const out = [];
  for (let n = start; n <= end; n += step) out.push(n);
  return out;
}
function makeSelect(options, selected) {
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.v;
    opt.textContent = o.t;
    if (o.v === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}
function makeBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = `sbtn ${cls || ""}`.trim();
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
// "HH:MM" (24h) -> { h, m, ap }
function parse24(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return { h: "", m: "", ap: "AM" };
  const [H, M] = hhmm.split(":").map(Number);
  const ap = H >= 12 ? "PM" : "AM";
  let h = H % 12;
  if (h === 0) h = 12;
  return { h: String(h), m: String(M).padStart(2, "0"), ap };
}
function to24(h, m, ap) {
  if (!h) return ""; // no hour = no auto-close
  const min = m || "00"; // hour alone defaults to :00
  let H = Number(h) % 12;
  if (ap === "PM") H += 12;
  return `${String(H).padStart(2, "0")}:${min}`;
}
function formatTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

// --- duplicate finder -----------------------------------------------------

async function refreshCount() {
  const { count } = await send({ type: "getCount" });
  if (count > 0) {
    countEl.innerHTML = `<strong>${count}</strong> duplicate tab${
      count === 1 ? "" : "s"
    }`;
    closeBtn.disabled = false;
  } else {
    countEl.textContent = "No duplicate tabs 🎉";
    closeBtn.disabled = true;
  }
}

closeBtn.addEventListener("click", async () => {
  closeBtn.disabled = true;
  const { closed } = await send({ type: "closeDuplicates" });
  statusEl.textContent = `Closed ${closed} tab${closed === 1 ? "" : "s"}.`;
  await refreshAll();
});

autoCloseEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [AUTO_CLOSE_KEY]: autoCloseEl.checked });
  statusEl.textContent = autoCloseEl.checked ? "Auto-close on." : "Auto-close off.";
  if (autoCloseEl.checked) await send({ type: "closeDuplicates" });
  await refreshAll();
});

askNewTabEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [ASK_KEY]: askNewTabEl.checked });
  statusEl.textContent = askNewTabEl.checked
    ? "Will ask which session for new tabs."
    : "Won't ask for new tabs.";
});

// --- sessions (expandable cards) ------------------------------------------

let sessionsCache = [];
const expanded = new Set(); // session ids whose card is open

function buildBody(s) {
  const body = document.createElement("div");
  body.className = "session-body";

  // Tab list: live tabs if active, otherwise the saved URLs.
  const list = document.createElement("div");
  list.className = "tablist";
  const items = s.active
    ? (s.tabs || []).map((t) => ({ label: t.title, title: t.url, tabId: t.tabId, key: t.key }))
    : (s.urlKeys || []).map((k) => ({ label: k, title: k, key: k }));

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "trow empty";
    empty.textContent = s.active
      ? "No tabs in this group."
      : "No saved tabs yet. Drag tabs onto this session.";
    list.appendChild(empty);
  } else {
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "trow";
      // Every row is draggable → drag a tab (or a saved URL) to another
      // session. Live tabs carry their tabId; saved URLs carry their key.
      row.draggable = true;
      row.style.cursor = "grab";
      row.addEventListener("dragstart", (e) => {
        if (it.tabId) e.dataTransfer.setData("text/plain", String(it.tabId));
        else e.dataTransfer.setData("application/x-session-key", it.key);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      const label = document.createElement("span");
      label.className = "tlabel";
      label.textContent = it.label;
      label.title = it.title;
      const x = document.createElement("button");
      x.className = "tx";
      x.textContent = "✕";
      x.title = it.tabId ? "Close tab & remove from session" : "Remove from session";
      x.addEventListener("click", async () => {
        await send({ type: "removeSessionItem", id: s.id, tabId: it.tabId, key: it.key });
        await refreshAll();
      });
      row.append(label, x);
      list.appendChild(row);
    }
  }
  body.appendChild(list);

  // End-time dropdowns
  const cur = parse24(s.endTime);
  const timeRow = document.createElement("div");
  timeRow.className = "session-row";
  const tl = document.createElement("span");
  tl.className = "muted";
  tl.textContent = "Auto-close:";
  const hourSel = makeSelect(
    [{ v: "", t: "--" }, ...range(1, 12).map((n) => ({ v: String(n), t: String(n) }))],
    cur.h
  );
  const minSel = makeSelect(
    [
      { v: "", t: "--" },
      ...range(0, 55, 5).map((n) => {
        const p = String(n).padStart(2, "0");
        return { v: p, t: p };
      }),
    ],
    cur.m
  );
  const apSel = makeSelect([{ v: "AM", t: "AM" }, { v: "PM", t: "PM" }], cur.ap);
  async function saveTime() {
    // Don't refreshAll() here — re-rendering would reset the dropdowns
    // mid-selection. Just persist the value.
    const endTime = to24(hourSel.value, minSel.value, apSel.value);
    await send({ type: "updateSession", id: s.id, endTime });
    if (endTime) {
      const t = parse24(endTime);
      statusEl.textContent = `“${s.name}” auto-closes at ${t.h}:${t.m} ${t.ap} once started.`;
    } else {
      statusEl.textContent = `“${s.name}” auto-close cleared.`;
    }
  }
  hourSel.addEventListener("change", saveTime);
  minSel.addEventListener("change", saveTime);
  apSel.addEventListener("change", saveTime);
  timeRow.append(tl, hourSel, minSel, apSel);
  body.appendChild(timeRow);

  // Actions
  const actions = document.createElement("div");
  actions.className = "session-row";
  if (s.active) {
    actions.append(
      makeBtn("End now", "primary", async () => {
        const r = await send({ type: "endSession", id: s.id });
        statusEl.textContent = `Closed ${r.closed} tab${r.closed === 1 ? "" : "s"}.`;
        await refreshAll();
      })
    );
  } else {
    actions.append(
      makeBtn("Start", "primary", async () => {
        const r = await send({ type: "startSession", id: s.id });
        statusEl.textContent = r.ok
          ? `Started — grouped ${r.grouped} tab${r.grouped === 1 ? "" : "s"}.`
          : r.error || "Couldn't start.";
        await refreshAll();
      })
    );
  }
  actions.append(
    makeBtn("Add current", "", async () => {
      const r = await send({ type: "addCurrentTab", id: s.id });
      statusEl.textContent = r.ok ? "Added current tab." : r.error || "Failed.";
      await refreshAll();
    }),
    makeBtn("Delete", "danger", async () => {
      await send({ type: "deleteSession", id: s.id });
      expanded.delete(s.id);
      await refreshAll();
    })
  );
  body.appendChild(actions);

  return body;
}

function renderSessionCard(s) {
  const card = document.createElement("div");
  card.className = `session ${s.active ? "active" : ""} ${
    expanded.has(s.id) ? "open" : ""
  }`.trim();

  const head = document.createElement("div");
  head.className = "session-head";

  // Drag handle to reorder sessions.
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  grip.title = "Drag to reorder";
  grip.draggable = true;
  grip.addEventListener("click", (e) => e.stopPropagation());
  grip.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-session-id", s.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  grip.addEventListener("dragend", () => card.classList.remove("dragging"));

  const dot = document.createElement("span");
  dot.className = "cdot";
  const name = document.createElement("span");
  name.className = "cname";
  name.textContent = s.name;
  const count = document.createElement("span");
  count.className = "ccount";
  const n = s.active ? (s.tabs || []).length : (s.urlKeys || []).length;
  count.textContent = `(${n})`;
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▸";
  head.append(grip, dot, name, count, caret);

  head.addEventListener("click", () => {
    if (expanded.has(s.id)) expanded.delete(s.id);
    else expanded.add(s.id);
    card.classList.toggle("open");
  });

  card.append(head, buildBody(s));

  // Drop target: drag a tab onto the card to add it to this session.
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("drop");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop"));
  card.addEventListener("drop", async (e) => {
    e.preventDefault();
    card.classList.remove("drop");
    // Reordering: another session card was dropped onto this one.
    const draggedId = e.dataTransfer.getData("application/x-session-id");
    if (draggedId) {
      if (draggedId !== s.id) await reorderSessions(draggedId, s.id);
      return;
    }
    const tabId = Number(e.dataTransfer.getData("text/plain"));
    const key = e.dataTransfer.getData("application/x-session-key");
    let r;
    if (tabId) {
      r = await send({ type: "addTabToSession", id: s.id, tabId });
    } else if (key) {
      r = await send({ type: "moveKeyToSession", id: s.id, key });
    } else {
      return;
    }
    statusEl.textContent = r.ok ? `Added to ${s.name}.` : r.error || "Failed.";
    await refreshAll();
  });

  return card;
}

// Move the dragged session to just before the target session, then persist.
async function reorderSessions(draggedId, targetId) {
  const ids = sessionsCache.map((s) => s.id).filter((id) => id !== draggedId);
  const idx = ids.indexOf(targetId);
  ids.splice(idx < 0 ? ids.length : idx, 0, draggedId);
  await send({ type: "setSessionOrder", order: ids });
  await refreshAll();
}

async function refreshSessions() {
  const { sessions } = await send({ type: "getSessions" });
  sessionsCache = sessions || [];
  chipsEl.innerHTML = "";
  for (const s of sessionsCache) chipsEl.appendChild(renderSessionCard(s));
  if (sessionsCache.length === 0) {
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = "No sessions yet — add one below.";
    chipsEl.appendChild(hint);
  }
}

addSessionBtn.addEventListener("click", async () => {
  const nm = newNameEl.value.trim();
  if (!nm) return;
  await send({ type: "createSession", name: nm });
  newNameEl.value = "";
  await refreshSessions();
});
newNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSessionBtn.click();
});

// --- individual tabs (not in any session, draggable) ----------------------

// Set of tabIds that already belong to an active session group.
function tabIdsInSessions() {
  const set = new Set();
  for (const s of sessionsCache) {
    if (s.active) for (const t of s.tabs || []) set.add(t.tabId);
  }
  return set;
}

async function refreshOpenTabs() {
  const inSession = tabIdsInSessions();
  const tabs = (await chrome.tabs.query({})).filter(
    (t) => isHttp(t.url) && !inSession.has(t.id)
  );
  tabCountEl.textContent = `(${tabs.length})`;
  openTabsEl.innerHTML = "";

  if (tabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "trow empty";
    empty.textContent = "No tabs outside a session.";
    openTabsEl.appendChild(empty);
    return;
  }

  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = "trow";
    row.draggable = true;

    const favi = document.createElement("img");
    favi.className = "favi";
    favi.src = tab.favIconUrl || "";
    favi.draggable = false; // don't let the image hijack the row drag
    favi.addEventListener("error", () => (favi.style.visibility = "hidden"));

    const label = document.createElement("span");
    label.className = "tlabel";
    label.textContent = tab.title || tab.url;
    label.title = tab.url;

    row.append(favi, label);

    const x = document.createElement("button");
    x.className = "tx";
    x.textContent = "✕";
    x.title = "Close tab";
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      await chrome.tabs.remove(tab.id);
      await refreshAll();
    });
    row.appendChild(x);

    // Click row -> switch to that tab (in its window).
    label.addEventListener("click", async () => {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    });

    // Drag -> drop on a session chip.
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(tab.id));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));

    openTabsEl.appendChild(row);
  }
}

// --- ignored sites (collapsible) ------------------------------------------

ignoreToggle.addEventListener("click", () => {
  const open = ignoreToggle.getAttribute("aria-expanded") === "true";
  ignoreToggle.setAttribute("aria-expanded", String(!open));
  ignoreWrap.hidden = open;
  if (!open) refreshIgnored();
});

function renderIgnored(list) {
  ignoreList.innerHTML = "";
  if (!list || list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "trow empty";
    empty.textContent = "No ignored sites.";
    ignoreList.appendChild(empty);
    return;
  }
  for (const domain of list) {
    const row = document.createElement("div");
    row.className = "trow";
    const label = document.createElement("span");
    label.className = "tlabel";
    label.textContent = domain;
    const x = document.createElement("button");
    x.className = "tx";
    x.textContent = "✕";
    x.title = "Stop ignoring";
    x.addEventListener("click", async () => {
      const { excluded } = await send({ type: "removeExcluded", domain });
      renderIgnored(excluded);
      await refreshCount();
    });
    row.append(label, x);
    ignoreList.appendChild(row);
  }
}

async function refreshIgnored() {
  const { excluded } = await send({ type: "getExcluded" });
  renderIgnored(excluded);
}

ignoreAdd.addEventListener("click", async () => {
  const d = ignoreInput.value.trim();
  if (!d) return;
  const { excluded } = await send({ type: "addExcluded", domain: d });
  ignoreInput.value = "";
  renderIgnored(excluded);
  await refreshCount();
});
ignoreInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") ignoreAdd.click();
});
ignoreAddCurrent.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isHttp(tab.url)) {
    statusEl.textContent = "No web page to ignore.";
    return;
  }
  const { excluded } = await send({ type: "addExcluded", domain: tab.url });
  renderIgnored(excluded);
  await refreshCount();
  await refreshOpenTabs();
});

// --- recently closed (collapsible) ----------------------------------------

logToggle.addEventListener("click", () => {
  const open = logToggle.getAttribute("aria-expanded") === "true";
  logToggle.setAttribute("aria-expanded", String(!open));
  logWrap.hidden = open;
  if (!open) refreshLog();
});

async function refreshLog() {
  const { log } = await send({ type: "getLog" });
  logEl.innerHTML = "";
  if (!log || log.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing closed yet.";
    logEl.appendChild(li);
    return;
  }
  for (const entry of log) {
    const li = document.createElement("li");
    const url = document.createElement("span");
    url.className = "url";
    url.textContent = entry.title || entry.url;
    url.title = entry.url;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${formatTime(entry.closedAt)} · ${entry.reason}`;
    li.append(url, meta);
    logEl.appendChild(li);
  }
}

clearLogBtn.addEventListener("click", async () => {
  await send({ type: "clearLog" });
  await refreshLog();
});

// --- orchestration --------------------------------------------------------

async function refreshAll() {
  await refreshCount();
  await refreshSessions();
  await refreshOpenTabs();
  if (logToggle.getAttribute("aria-expanded") === "true") await refreshLog();
}

(async () => {
  const data = await chrome.storage.sync.get([AUTO_CLOSE_KEY, ASK_KEY]);
  autoCloseEl.checked = Boolean(data[AUTO_CLOSE_KEY]);
  askNewTabEl.checked = Boolean(data[ASK_KEY]);
  await refreshAll();
})();
