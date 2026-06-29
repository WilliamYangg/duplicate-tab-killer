const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));

const faviEl = document.getElementById("favi");
const titleEl = document.getElementById("title");
const urlEl = document.getElementById("url");
const slistEl = document.getElementById("slist");
const newNameEl = document.getElementById("newName");
const createBtn = document.getElementById("createBtn");
const browseBtn = document.getElementById("browse");
const dontAskBtn = document.getElementById("dontAsk");

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function assignTo(id) {
  try {
    const r = await send({ type: "addTabToSession", id, tabId });
    if (r && r.ok) {
      window.close();
    } else {
      showError((r && r.error) || "Couldn't add the tab to that session.");
    }
  } catch (e) {
    showError(String((e && e.message) || e));
  }
}

function showError(msg) {
  let el = document.getElementById("chooserError");
  if (!el) {
    el = document.createElement("p");
    el.id = "chooserError";
    el.style.cssText =
      "color:#ef4444;font-size:12px;margin:12px 0 0;font-weight:600;";
    document.body.appendChild(el);
  }
  el.textContent = "⚠ " + msg;
}

function renderSessions(sessions) {
  slistEl.innerHTML = "";
  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.className = `schoice ${s.active ? "active" : ""}`.trim();
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.name;
    const state = document.createElement("span");
    state.className = "state";
    state.textContent = s.active ? "active" : "";
    btn.append(dot, name, state);
    btn.addEventListener("click", () => assignTo(s.id));
    slistEl.appendChild(btn);
  }
}

createBtn.addEventListener("click", async () => {
  const nm = newNameEl.value.trim();
  if (!nm) return;
  const { id } = await send({ type: "createSession", name: nm });
  await assignTo(id);
});
newNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createBtn.click();
});

// "Just browsing" — leave the tab unsorted (it stays in Individual tabs).
browseBtn.addEventListener("click", () => window.close());
dontAskBtn.addEventListener("click", async () => {
  await chrome.storage.sync.set({ askOnNewTab: false });
  window.close();
});

(async () => {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    window.close();
    return;
  }
  titleEl.textContent = tab.title || tab.url;
  urlEl.textContent = tab.url;
  if (tab.favIconUrl) faviEl.src = tab.favIconUrl;
  else faviEl.style.visibility = "hidden";

  const { sessions } = await send({ type: "getSessions" });
  renderSessions(sessions || []);
})();
