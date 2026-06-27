// Duplicate Tab Killer — background service worker
//
// Responsibilities:
//   - Keep a badge count of how many duplicate tabs currently exist.
//   - Optionally auto-close duplicates the moment they appear (toggle in popup).
//
// "Duplicate" = same normalized URL. When closing, we KEEP the oldest tab
// (lowest tab id / earliest opened) and close the newer copies.

const AUTO_CLOSE_KEY = "autoClose";
const EXCLUDE_KEY = "excludedDomains"; // sync: array of hostnames to never dedupe
const LOG_KEY = "closeLog";
const LOG_MAX = 200; // keep the most recent N closed-tab entries

// Teaching sessions
const SESSIONS_KEY = "sessions"; // sync: array of {id, name, urlKeys, endTime}
const STATE_KEY = "sessionState"; // local: { [id]: {groupId, closeAt} }

// Idle-tab reminder
const IDLE_HOURS = 3;
const IDLE_MS = IDLE_HOURS * 60 * 60 * 1000;
const IDLE_SNOOZE_KEY = "idleSnooze"; // local: { [tabId]: snoozeUntil }
const IDLE_NOTICE_CAP = 5; // max notifications per hourly run

// Ask-on-new-tab
const ASK_KEY = "askOnNewTab"; // sync: boolean
const startedAt = Date.now(); // skip prompts for tabs restored at startup
const pendingAsk = new Set(); // tab ids created this run, awaiting first load

// Normalize a URL so trivial differences don't hide a real duplicate.
// - drop the hash fragment (e.g. #section)
// - drop a trailing slash on the path
// Tweak this if you want stricter or looser matching.
function normalizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    let s = u.toString();
    // remove a single trailing slash (but keep "http://host/")
    s = s.replace(/(?<=.)\/$/, "");
    return s;
  } catch {
    return rawUrl;
  }
}

// Tabs we should never auto-close or count (chrome:// pages, new-tab, etc.)
function isCountable(tab) {
  if (!tab.url) return false;
  return tab.url.startsWith("http://") || tab.url.startsWith("https://");
}

// --- Excluded sites (never de-duplicated) ---------------------------------
// Some sites (e.g. multi-account sites like YouTube) show the same URL for
// different logged-in accounts. Chrome can't tell those tabs apart, so the
// user can list such domains here to exempt them from duplicate detection.

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Normalize user input into a bare domain: drop scheme/path and leading "www.".
function cleanDomain(input) {
  let s = (input || "").trim().toLowerCase();
  if (!s) return "";
  try {
    if (s.includes("://")) s = new URL(s).hostname;
  } catch {
    /* keep as typed */
  }
  return s.replace(/^www\./, "").replace(/\/.*$/, "");
}

async function getExcluded() {
  const d = await chrome.storage.sync.get(EXCLUDE_KEY);
  return Array.isArray(d[EXCLUDE_KEY]) ? d[EXCLUDE_KEY] : [];
}

// A host is excluded if it equals a listed domain or is a subdomain of one.
function isExcludedHost(host, excluded) {
  return excluded.some((d) => host === d || host.endsWith("." + d));
}

// Find duplicate tabs. Returns { duplicates: [tab,...], byUrl: Map }.
// The FIRST tab seen for each URL (oldest id) is the keeper; the rest are dupes.
async function findDuplicatesWithKeepers() {
  const tabs = await chrome.tabs.query({});
  const excluded = await getExcluded();
  const countable = tabs
    .filter(isCountable)
    .sort((a, b) => a.id - b.id); // oldest first

  const keeperByKey = new Map(); // url key -> the tab we keep (oldest)
  const duplicates = [];
  for (const tab of countable) {
    // Skip excluded sites entirely — never treat their tabs as duplicates.
    if (isExcludedHost(hostnameOf(tab.url), excluded)) continue;
    const key = normalizeUrl(tab.url);
    if (keeperByKey.has(key)) duplicates.push(tab);
    else keeperByKey.set(key, tab);
  }
  return { duplicates, keeperByKey };
}

async function findDuplicates() {
  return (await findDuplicatesWithKeepers()).duplicates;
}

async function updateBadge() {
  const dupes = await findDuplicates();
  const count = dupes.length;
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  return count;
}

// Append closed tabs to a persistent log in storage.local, newest first,
// capped at LOG_MAX entries. `reason` is "manual" or "auto".
async function logClosed(tabs, reason) {
  if (!tabs.length) return;
  const now = Date.now();
  const entries = tabs.map((t) => ({
    url: t.url,
    title: t.title || t.url,
    closedAt: now,
    reason,
  }));
  for (const e of entries) {
    console.log(`[DuplicateTabKiller] closed (${reason}): ${e.url}`);
  }
  const data = await chrome.storage.local.get(LOG_KEY);
  const log = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
  const next = [...entries, ...log].slice(0, LOG_MAX);
  await chrome.storage.local.set({ [LOG_KEY]: next });
}

// Close all duplicates. Returns the number closed.
async function closeDuplicates(reason = "manual") {
  const { duplicates, keeperByKey } = await findDuplicatesWithKeepers();
  if (duplicates.length) {
    // If the tab you're looking at is itself a duplicate (you just opened/
    // navigated into one), jump to the existing copy before closing this one —
    // so you land on the original instead of losing your place.
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    let focusTarget = null;
    if (activeTab && duplicates.some((d) => d.id === activeTab.id)) {
      focusTarget = keeperByKey.get(normalizeUrl(activeTab.url));
    }

    await logClosed(duplicates, reason);
    await chrome.tabs.remove(duplicates.map((t) => t.id));

    if (focusTarget) {
      try {
        await chrome.tabs.update(focusTarget.id, { active: true });
        await chrome.windows.update(focusTarget.windowId, { focused: true });
      } catch {
        /* keeper vanished */
      }
    }
  }
  await updateBadge();
  return duplicates.length;
}

// --- Teaching sessions ----------------------------------------------------
//
// A "session" is a saved set of URLs (any group of tabs you use together —
// work, research, a class, etc.) plus an optional daily end time. Starting a
// session groups the matching open tabs into a native Chrome tab group, which
// you can then drag tabs in/out of in the tab strip. Ending it (manually or at
// the end time) closes the whole group at once.

// Loose match key: hostname + path, ignoring query/hash/trailing slash.
// So the same doc/meet link matches even if the query string changes.
function matchKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (u.hostname + u.pathname).toLowerCase().replace(/(?<=.)\/$/, "");
  } catch {
    return rawUrl || "";
  }
}

async function getSessions() {
  const data = await chrome.storage.sync.get(SESSIONS_KEY);
  return Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : [];
}
async function saveSessions(sessions) {
  await chrome.storage.sync.set({ [SESSIONS_KEY]: sessions });
}
async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] && typeof data[STATE_KEY] === "object"
    ? data[STATE_KEY]
    : {};
}
async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

// A URL belongs to at most one session. Remove the key everywhere, then add it
// to the target — so dragging a tab between sessions moves it cleanly.
function reassignKey(sessions, targetId, key) {
  for (const s of sessions) {
    s.urlKeys = (s.urlKeys || []).filter((k) => k !== key);
  }
  const t = sessions.find((x) => x.id === targetId);
  if (t) t.urlKeys = [...(t.urlKeys || []), key];
}

// Compute the next timestamp for an "HH:MM" end time. If that time already
// passed today, treat it as no auto-close (the user can still end manually).
function endTimeToTimestamp(endTime) {
  if (!endTime || !/^\d{1,2}:\d{2}$/.test(endTime)) return null;
  const [h, m] = endTime.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return target.getTime() > now.getTime() ? target.getTime() : null;
}

// Start a session: group all open tabs whose key is saved. If none are open,
// seed the group with the current active tab and remember its key.
async function startSession(id) {
  const sessions = await getSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return { ok: false, error: "not found" };

  const keys = new Set(s.urlKeys || []);
  const tabs = (await chrome.tabs.query({})).filter(isCountable);
  let tabIds = tabs.filter((t) => keys.has(matchKey(t.url))).map((t) => t.id);

  if (tabIds.length === 0) {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (active && isCountable(active)) {
      tabIds = [active.id];
      const k = matchKey(active.url);
      if (!keys.has(k)) {
        s.urlKeys = [...(s.urlKeys || []), k];
        await saveSessions(sessions);
      }
    }
  }
  if (tabIds.length === 0) {
    return { ok: false, error: "No teaching tabs open to group." };
  }

  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, { title: s.name, color: "blue" });

  const state = await getState();
  const closeAt = endTimeToTimestamp(s.endTime);
  state[id] = { groupId, closeAt };
  await setState(state);
  if (closeAt) chrome.alarms.create(`session-${id}`, { when: closeAt });

  return { ok: true, grouped: tabIds.length };
}

// Add the current tab to a session: save its key, and if the session is live,
// drop it into the group right now.
async function addCurrentTab(id) {
  const sessions = await getSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return { ok: false, error: "not found" };
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!active || !isCountable(active)) {
    return { ok: false, error: "No http(s) tab active." };
  }
  reassignKey(sessions, id, matchKey(active.url));
  await saveSessions(sessions);
  const state = await getState();
  if (state[id]?.groupId != null) {
    await chrome.tabs.group({ groupId: state[id].groupId, tabIds: [active.id] });
  }
  return { ok: true, url: active.url };
}

// Add a specific tab (by id) to a session — used by drag-and-drop in the popup.
async function addTabToSession(id, tabId) {
  const sessions = await getSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return { ok: false, error: "not found" };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "tab gone" };
  }
  if (!isCountable(tab)) return { ok: false, error: "only http(s) tabs" };
  reassignKey(sessions, id, matchKey(tab.url));
  await saveSessions(sessions);
  const state = await getState();
  if (state[id]?.groupId != null) {
    await chrome.tabs.group({ groupId: state[id].groupId, tabIds: [tabId] });
  } else {
    // Target session isn't live — pull the tab out of any other group so it
    // doesn't linger in the session it came from.
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {
      /* not grouped */
    }
  }
  return { ok: true };
}

// End a session: close every tab in its group.
async function endSession(id, reason = "session") {
  const state = await getState();
  const entry = state[id];
  if (!entry || entry.groupId == null) {
    return { ok: true, closed: 0 };
  }
  let closed = 0;
  try {
    const tabs = await chrome.tabs.query({ groupId: entry.groupId });
    if (tabs.length) {
      await logClosed(tabs, reason);
      await chrome.tabs.remove(tabs.map((t) => t.id));
      closed = tabs.length;
    }
  } catch (e) {
    console.warn("[DuplicateTabKiller] endSession:", e);
  }
  delete state[id];
  await setState(state);
  chrome.alarms.clear(`session-${id}`);
  await updateBadge();
  return { ok: true, closed };
}

// Drop any session state whose tab group no longer exists (e.g. after a
// browser restart, group ids change). Prevents a session from showing "active"
// when its group is gone.
async function pruneStaleGroups() {
  const state = await getState();
  let changed = false;
  for (const id of Object.keys(state)) {
    const gid = state[id]?.groupId;
    if (gid == null) continue;
    try {
      await chrome.tabGroups.get(gid);
    } catch {
      delete state[id];
      chrome.alarms.clear(`session-${id}`);
      changed = true;
    }
  }
  if (changed) await setState(state);
}

// When a tab navigates to a saved URL of a LIVE session, auto-join the group.
async function autoGroup(tab) {
  if (!isCountable(tab)) return;
  const key = matchKey(tab.url);
  const sessions = await getSessions();
  const state = await getState();
  for (const s of sessions) {
    const entry = state[s.id];
    if (entry?.groupId == null) continue;
    if ((s.urlKeys || []).includes(key) && tab.groupId !== entry.groupId) {
      try {
        await chrome.tabs.group({ groupId: entry.groupId, tabIds: [tab.id] });
      } catch (e) {
        console.warn("[DuplicateTabKiller] autoGroup:", e);
      }
    }
  }
}

// When a tab is dragged into a live session's group (in the tab strip), or
// grouped any other way, remember its URL so it auto-rejoins next time.
async function captureGroupedTab(tab) {
  if (!isCountable(tab) || tab.groupId == null || tab.groupId < 0) return;
  const state = await getState();
  const sessions = await getSessions();
  const owner = sessions.find((s) => state[s.id]?.groupId === tab.groupId);
  if (owner) {
    reassignKey(sessions, owner.id, matchKey(tab.url));
    await saveSessions(sessions);
  }
}

// If a group is dissolved (e.g. user closed all its tabs manually), forget it.
async function forgetGroup(groupId) {
  const state = await getState();
  let changed = false;
  for (const id of Object.keys(state)) {
    if (state[id]?.groupId === groupId) {
      delete state[id];
      changed = true;
      chrome.alarms.clear(`session-${id}`);
    }
  }
  if (changed) await setState(state);
}

// --- Ask which session for a new tab --------------------------------------

async function getAskOnNewTab() {
  const d = await chrome.storage.sync.get(ASK_KEY);
  return Boolean(d[ASK_KEY]);
}

// A tab is "assigned" if it's in a tab group, or its URL is saved to a session.
async function isAssigned(tab) {
  if (tab.groupId != null && tab.groupId >= 0) return true;
  const key = matchKey(tab.url);
  const sessions = await getSessions();
  return sessions.some((s) => (s.urlKeys || []).includes(key));
}

// Pop a small chooser window asking which session a freshly-opened tab belongs
// to. Only fires for unassigned http(s) tabs, when the feature is on and there
// is at least one session to file into.
async function maybeAskForTab(tab) {
  if (!isCountable(tab)) return;
  if (Date.now() - startedAt < 4000) return; // ignore startup tab restore
  if (!(await getAskOnNewTab())) return;
  if (await isAssigned(tab)) return;
  const sessions = await getSessions();
  if (sessions.length === 0) return;
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`chooser.html?tabId=${tab.id}`),
      type: "popup",
      width: 340,
      height: 440,
      focused: true,
    });
  } catch (e) {
    console.warn("[DuplicateTabKiller] chooser:", e);
  }
}

// --- Idle-tab reminder ----------------------------------------------------

async function getSnooze() {
  const data = await chrome.storage.local.get(IDLE_SNOOZE_KEY);
  return data[IDLE_SNOOZE_KEY] && typeof data[IDLE_SNOOZE_KEY] === "object"
    ? data[IDLE_SNOOZE_KEY]
    : {};
}
async function setSnooze(snooze) {
  await chrome.storage.local.set({ [IDLE_SNOOZE_KEY]: snooze });
}

// Notify (up to a cap) about tabs untouched for 3h+, with Keep / Close buttons.
async function runIdleCheck() {
  const now = Date.now();
  const snooze = await getSnooze();
  // Drop expired snoozes.
  let snoozeChanged = false;
  for (const k of Object.keys(snooze)) {
    if (snooze[k] <= now) {
      delete snooze[k];
      snoozeChanged = true;
    }
  }

  const tabs = await chrome.tabs.query({});
  const stale = tabs.filter(
    (t) =>
      isCountable(t) &&
      !t.active &&
      !t.pinned &&
      typeof t.lastAccessed === "number" &&
      now - t.lastAccessed > IDLE_MS &&
      !(snooze[t.id] && snooze[t.id] > now)
  );

  for (const tab of stale.slice(0, IDLE_NOTICE_CAP)) {
    const hours = Math.floor((now - tab.lastAccessed) / (60 * 60 * 1000));
    chrome.notifications.create(`idle:${tab.id}`, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: `Tab idle ${hours}h`,
      message: tab.title || tab.url,
      contextMessage: tab.url,
      requireInteraction: true,
      buttons: [{ title: "Keep" }, { title: "Close tab" }],
    });
  }

  if (snoozeChanged) await setSnooze(snooze);
}

// --- Event wiring ---------------------------------------------------------

async function getAutoClose() {
  const data = await chrome.storage.sync.get(AUTO_CLOSE_KEY);
  return Boolean(data[AUTO_CLOSE_KEY]);
}

async function onTabChanged() {
  if (await getAutoClose()) {
    await closeDuplicates("auto");
  } else {
    await updateBadge();
  }
}

chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => {
  // Only react when the URL settles, to avoid thrashing mid-navigation.
  if (changeInfo.url || changeInfo.status === "complete") {
    onTabChanged();
    autoGroup(tab);
  }
  // Fires when a tab is dragged into/out of a group in the tab strip.
  if (changeInfo.groupId !== undefined) captureGroupedTab(tab);
  // A newly-opened tab stays "pending" until it lands on a real http(s) page
  // (a fresh tab loads chrome://newtab first — we wait past that for the URL
  // the user actually navigates to), then we ask which session it belongs to.
  if (changeInfo.status === "complete" && pendingAsk.has(id) && isCountable(tab)) {
    pendingAsk.delete(id);
    maybeAskForTab(tab);
  }
});
chrome.tabs.onCreated.addListener((tab) => {
  onTabChanged();
  pendingAsk.add(tab.id); // candidate; we decide once it loads a real page
});
chrome.tabs.onRemoved.addListener((tabId) => pendingAsk.delete(tabId));
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

// Tab groups: clean up state when a group is dissolved.
chrome.tabGroups.onRemoved.addListener((group) => forgetGroup(group.id));

// Alarms: hourly idle check + per-session auto-close timers.
function ensureIdleAlarm() {
  chrome.alarms.create("idleCheck", { periodInMinutes: 60 });
}
chrome.runtime.onStartup.addListener(ensureIdleAlarm);
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  ensureIdleAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "idleCheck") {
    runIdleCheck();
  } else if (alarm.name.startsWith("session-")) {
    endSession(alarm.name.slice("session-".length), "session");
  }
});

// Idle notifications: handle the Keep / Close buttons.
chrome.notifications.onButtonClicked.addListener(async (notificationId, idx) => {
  if (!notificationId.startsWith("idle:")) return;
  const tabId = Number(notificationId.slice("idle:".length));
  chrome.notifications.clear(notificationId);
  if (idx === 1) {
    // Close tab
    try {
      const tab = await chrome.tabs.get(tabId);
      await logClosed([tab], "idle");
      await chrome.tabs.remove(tabId);
    } catch {
      /* tab already gone */
    }
  } else {
    // Keep: snooze for IDLE_HOURS so we don't nag again right away.
    const snooze = await getSnooze();
    snooze[tabId] = Date.now() + IDLE_MS;
    await setSnooze(snooze);
  }
});
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("idle:")) chrome.notifications.clear(id);
});

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "closeDuplicates") {
      const closed = await closeDuplicates("manual");
      sendResponse({ closed });
    } else if (msg.type === "getCount") {
      const dupes = await findDuplicates();
      sendResponse({ count: dupes.length });
    } else if (msg.type === "getLog") {
      const data = await chrome.storage.local.get(LOG_KEY);
      sendResponse({ log: Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [] });
    } else if (msg.type === "clearLog") {
      await chrome.storage.local.set({ [LOG_KEY]: [] });
      sendResponse({ ok: true });
    } else if (msg.type === "getExcluded") {
      sendResponse({ excluded: await getExcluded() });
    } else if (msg.type === "addExcluded") {
      const d = cleanDomain(msg.domain);
      const list = await getExcluded();
      if (d && !list.includes(d)) list.push(d);
      await chrome.storage.sync.set({ [EXCLUDE_KEY]: list });
      await updateBadge();
      sendResponse({ ok: Boolean(d), excluded: list });
    } else if (msg.type === "removeExcluded") {
      const list = (await getExcluded()).filter((x) => x !== msg.domain);
      await chrome.storage.sync.set({ [EXCLUDE_KEY]: list });
      await updateBadge();
      sendResponse({ ok: true, excluded: list });
    } else if (msg.type === "getSessions") {
      await pruneStaleGroups();
      const sessions = await getSessions();
      const state = await getState();
      // Annotate with live status + the actual tabs in each live group.
      const view = await Promise.all(
        sessions.map(async (s) => {
          const active = state[s.id]?.groupId != null;
          let tabs = [];
          if (active) {
            try {
              tabs = (
                await chrome.tabs.query({ groupId: state[s.id].groupId })
              ).map((t) => ({
                tabId: t.id,
                title: t.title || t.url,
                url: t.url,
                key: matchKey(t.url),
              }));
            } catch {
              /* group vanished */
            }
          }
          return {
            ...s,
            active,
            closeAt: state[s.id]?.closeAt ?? null,
            tabs,
          };
        })
      );
      sendResponse({ sessions: view });
    } else if (msg.type === "createSession") {
      const sessions = await getSessions();
      const id = `s${Date.now()}${Math.floor(performance.now())}`;
      sessions.push({
        id,
        name: msg.name || "Session",
        urlKeys: [],
        endTime: msg.endTime || "",
      });
      await saveSessions(sessions);
      sendResponse({ ok: true, id });
    } else if (msg.type === "updateSession") {
      const sessions = await getSessions();
      const s = sessions.find((x) => x.id === msg.id);
      if (s) {
        if (typeof msg.name === "string") s.name = msg.name;
        if (typeof msg.endTime === "string") s.endTime = msg.endTime;
        await saveSessions(sessions);
      }
      sendResponse({ ok: Boolean(s) });
    } else if (msg.type === "deleteSession") {
      await endSession(msg.id, "session");
      const sessions = (await getSessions()).filter((x) => x.id !== msg.id);
      await saveSessions(sessions);
      sendResponse({ ok: true });
    } else if (msg.type === "startSession") {
      sendResponse(await startSession(msg.id));
    } else if (msg.type === "addCurrentTab") {
      sendResponse(await addCurrentTab(msg.id));
    } else if (msg.type === "addTabToSession") {
      sendResponse(await addTabToSession(msg.id, msg.tabId));
    } else if (msg.type === "moveKeyToSession") {
      // Move a saved URL (not currently open) from one session to another.
      const sessions = await getSessions();
      reassignKey(sessions, msg.id, msg.key);
      await saveSessions(sessions);
      sendResponse({ ok: true });
    } else if (msg.type === "endSession") {
      sendResponse(await endSession(msg.id, "manual"));
    } else if (msg.type === "removeSessionItem") {
      // Close the tab if it's open, and forget its saved URL so it won't
      // auto-rejoin the session next time.
      if (typeof msg.tabId === "number") {
        try {
          const tab = await chrome.tabs.get(msg.tabId);
          await logClosed([tab], "manual");
          await chrome.tabs.remove(msg.tabId);
        } catch {
          /* tab already gone */
        }
      }
      if (msg.key) {
        const sessions = await getSessions();
        const s = sessions.find((x) => x.id === msg.id);
        if (s) {
          s.urlKeys = (s.urlKeys || []).filter((k) => k !== msg.key);
          await saveSessions(sessions);
        }
      }
      await updateBadge();
      sendResponse({ ok: true });
    }
  })();
  return true; // keep the message channel open for the async response
});
