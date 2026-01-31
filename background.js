const HISTORY_LIMIT = 50;
const MENU_LIMIT = 20;
const CAN_USE_CONTEXT_MENUS = !!(chrome.contextMenus && chrome.contextMenus.create);
let rebuildInFlight = Promise.resolve();
const pointerByWindow = new Map();
const suppressActivationByWindow = new Map();
const managerTabs = new Map(); // tabId -> targetWindowId
const managerWindowByTarget = new Map(); // targetWindowId -> managerWindowId
const managerTargetByWindow = new Map(); // managerWindowId -> targetWindowId

// windowId -> [tabId, ...] (most recent first)
const historyByWindow = new Map();
// windowId -> active tabId
const activeByWindow = new Map();

function getHistory(windowId) {
  if (!historyByWindow.has(windowId)) {
    historyByWindow.set(windowId, []);
  }
  return historyByWindow.get(windowId);
}

async function persistHistory(windowId) {
  const history = getHistory(windowId);
  await chrome.storage.session.set({ [`history_${windowId}`]: history });
}

async function loadHistory(windowId) {
  const key = `history_${windowId}`;
  const result = await chrome.storage.session.get(key);
  if (Array.isArray(result[key])) {
    historyByWindow.set(windowId, result[key]);
  }
}

function rememberTab(windowId, tabId) {
  const history = getHistory(windowId);
  const existingIndex = history.indexOf(tabId);
  if (existingIndex !== -1) {
    history.splice(existingIndex, 1);
  }
  history.unshift(tabId);
  if (history.length > HISTORY_LIMIT) {
    history.length = HISTORY_LIMIT;
  }
}

function forgetTab(windowId, tabId) {
  const history = getHistory(windowId);
  const existingIndex = history.indexOf(tabId);
  if (existingIndex !== -1) {
    history.splice(existingIndex, 1);
  }
}

function adjustPointerOnRemoval(windowId, removedIndex) {
  if (removedIndex === -1) {
    return;
  }
  const pointer = pointerByWindow.get(windowId);
  if (!Number.isInteger(pointer)) {
    return;
  }
  const history = getHistory(windowId);
  let nextPointer = pointer;
  if (removedIndex < pointer) {
    nextPointer -= 1;
  } else if (removedIndex === pointer) {
    nextPointer = Math.min(pointer, history.length - 1);
  }
  if (nextPointer < 0 || history.length === 0) {
    pointerByWindow.delete(windowId);
  } else {
    pointerByWindow.set(windowId, nextPointer);
  }
}

async function getOrderedTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const history = getHistory(windowId);
  const tabMap = new Map(tabs.map((tab) => [tab.id, tab]));

  const ordered = [];
  for (const tabId of history) {
    const tab = tabMap.get(tabId);
    if (tab) {
      ordered.push(tab);
      tabMap.delete(tabId);
    }
  }

  const remaining = Array.from(tabMap.values()).sort((a, b) => a.index - b.index);
  return ordered.concat(remaining);
}

async function switchToPreviousTab(windowId) {
  const history = getHistory(windowId);
  if (history.length < 2) {
    return;
  }
  const previousTabId = history[1];
  try {
    await chrome.tabs.update(previousTabId, { active: true });
  } catch (error) {
    // Tab may be gone; fall back to the next available tab in history.
    for (let i = 2; i < history.length; i += 1) {
      try {
        await chrome.tabs.update(history[i], { active: true });
        break;
      } catch (ignored) {
        // Continue trying.
      }
    }
  }
}

async function switchToMostRecentAvailable(windowId) {
  const history = getHistory(windowId);
  for (const tabId of history) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      break;
    } catch (error) {
      // Keep trying others.
    }
  }
}

async function ensureHistoryLoaded(windowId) {
  if (!historyByWindow.has(windowId)) {
    await loadHistory(windowId);
  }
}

async function getActiveTabForWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId, active: true });
  return tabs[0];
}

async function isManagerWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.some((tab) => typeof tab.url === "string" && tab.url.includes("tab_manager.html"));
}

async function navigateHistory(windowId, delta) {
  await ensureHistoryLoaded(windowId);
  const history = getHistory(windowId);
  if (!history.length) {
    return;
  }
  const activeTab = await getActiveTabForWindow(windowId);
  const activeId = activeTab?.id;
  let pointer = pointerByWindow.get(windowId);
  if (!Number.isInteger(pointer) || history[pointer] !== activeId) {
    const idx = history.indexOf(activeId);
    pointer = idx === -1 ? 0 : idx;
  }
  const nextIndex = pointer + delta;
  if (nextIndex < 0 || nextIndex >= history.length) {
    return;
  }
  const nextTabId = history[nextIndex];
  suppressActivationByWindow.set(windowId, nextTabId);
  pointerByWindow.set(windowId, nextIndex);
  try {
    await chrome.tabs.update(nextTabId, { active: true });
  } catch (error) {
    // Ignore if tab is gone.
  }
}

async function activateTabPreservingHistory(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId == null) {
      return;
    }
    await ensureHistoryLoaded(tab.windowId);
    const history = getHistory(tab.windowId);
    const idx = history.indexOf(tabId);
    pointerByWindow.set(tab.windowId, idx === -1 ? 0 : idx);
    suppressActivationByWindow.set(tab.windowId, tabId);
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    // Ignore if tab is gone.
  }
}

async function notifyManagers(windowId) {
  const targets = [];
  for (const [tabId, targetWindowId] of managerTabs.entries()) {
    if (targetWindowId === windowId) {
      targets.push(tabId);
    }
  }
  await Promise.all(
    targets.map(async (tabId) => {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "history-updated", windowId });
      } catch (error) {
        // Ignore tabs that are not ready or were closed.
      }
    })
  );
}

async function rebuildContextMenu(windowId) {
  if (!CAN_USE_CONTEXT_MENUS) {
    return;
  }
  const previous = rebuildInFlight;
  let release;
  rebuildInFlight = new Promise((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    await chrome.contextMenus.removeAll();

    const parentId = chrome.contextMenus.create({
      id: "tab-history-root",
      title: "Tab History",
      contexts: ["action"]
    });

    const orderedTabs = await getOrderedTabs(windowId);
    const menuTabs = orderedTabs.slice(0, MENU_LIMIT);

    for (const tab of menuTabs) {
      const title = tab.title || tab.pendingUrl || tab.url || "(Untitled)";
      const prefix = tab.active ? "> " : "";
      chrome.contextMenus.create({
        id: `tab-${tab.id}`,
        parentId,
        title: `${prefix}${title}`,
        contexts: ["action"]
      });
    }

    chrome.contextMenus.create({
      id: "open-tab-manager",
      title: "Open Tab Manager",
      contexts: ["action"]
    });
  } finally {
    if (release) {
      release();
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (win.id == null) {
      continue;
    }
    const history = getHistory(win.id);
    const tabs = win.tabs || [];
    const hasAccessed = tabs.some((tab) => typeof tab.lastAccessed === "number" && tab.lastAccessed > 0);
    let orderedTabs = tabs.slice();
    if (hasAccessed) {
      orderedTabs.sort((a, b) => {
        const aAccessed = typeof a.lastAccessed === "number" ? a.lastAccessed : 0;
        const bAccessed = typeof b.lastAccessed === "number" ? b.lastAccessed : 0;
        if (aAccessed !== bAccessed) {
          return bAccessed - aAccessed;
        }
        return (a.index ?? 0) - (b.index ?? 0);
      });
    } else {
      orderedTabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const activeIndex = orderedTabs.findIndex((tab) => tab.active);
      if (activeIndex > 0) {
        const [activeTab] = orderedTabs.splice(activeIndex, 1);
        orderedTabs.unshift(activeTab);
      }
    }

    for (const tab of orderedTabs) {
      history.push(tab.id);
      if (tab.active) {
        activeByWindow.set(win.id, tab.id);
      }
    }
    await persistHistory(win.id);
  }
  if (CAN_USE_CONTEXT_MENUS) {
    const current = windows.find((win) => win.focused) || windows[0];
    if (current && current.id != null) {
      await rebuildContextMenu(current.id);
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ensureHistoryLoaded(windowId);
  const suppressed = suppressActivationByWindow.get(windowId);
  if (suppressed === tabId) {
    suppressActivationByWindow.delete(windowId);
    activeByWindow.set(windowId, tabId);
    const history = getHistory(windowId);
    const idx = history.indexOf(tabId);
    pointerByWindow.set(windowId, idx === -1 ? 0 : idx);
  } else {
    rememberTab(windowId, tabId);
    activeByWindow.set(windowId, tabId);
    pointerByWindow.set(windowId, 0);
    await persistHistory(windowId);
  }
  await notifyManagers(windowId);
  if (CAN_USE_CONTEXT_MENUS && !chrome.contextMenus.onShown) {
    await rebuildContextMenu(windowId);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  await ensureHistoryLoaded(windowId);
  if (CAN_USE_CONTEXT_MENUS) {
    await rebuildContextMenu(windowId);
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab || tab.windowId == null) {
    return;
  }
  await ensureHistoryLoaded(tab.windowId);
  await notifyManagers(tab.windowId);
  if (CAN_USE_CONTEXT_MENUS && !chrome.contextMenus.onShown) {
    await rebuildContextMenu(tab.windowId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || tab.windowId == null) {
    return;
  }
  if (!changeInfo.title && !changeInfo.favIconUrl && !changeInfo.url) {
    return;
  }
  await ensureHistoryLoaded(tab.windowId);
  await notifyManagers(tab.windowId);
  if (CAN_USE_CONTEXT_MENUS && !chrome.contextMenus.onShown) {
    await rebuildContextMenu(tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const { windowId, isWindowClosing } = removeInfo;
  if (isWindowClosing) {
    historyByWindow.delete(windowId);
    activeByWindow.delete(windowId);
    pointerByWindow.delete(windowId);
    suppressActivationByWindow.delete(windowId);
    return;
  }

  if (managerTabs.has(tabId)) {
    const targetWindowId = managerTabs.get(tabId);
    managerTabs.delete(tabId);
    if (Number.isInteger(targetWindowId)) {
      const managerWindowId = managerWindowByTarget.get(targetWindowId);
      if (managerWindowId === removeInfo.windowId) {
        managerWindowByTarget.delete(targetWindowId);
        managerTargetByWindow.delete(managerWindowId);
      }
    }
  }

  await ensureHistoryLoaded(windowId);
  const wasActive = activeByWindow.get(windowId) === tabId;
  const history = getHistory(windowId);
  const removedIndex = history.indexOf(tabId);
  forgetTab(windowId, tabId);
  adjustPointerOnRemoval(windowId, removedIndex);

  if (wasActive) {
    await switchToMostRecentAvailable(windowId);
  }

  await persistHistory(windowId);
  await notifyManagers(windowId);
  if (CAN_USE_CONTEXT_MENUS && !chrome.contextMenus.onShown) {
    await rebuildContextMenu(windowId);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [targetWindowId, managerWindowId] of managerWindowByTarget.entries()) {
    if (managerWindowId === windowId) {
      managerWindowByTarget.delete(targetWindowId);
      managerTargetByWindow.delete(managerWindowId);
    }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.windowId == null) {
    return;
  }
  await ensureHistoryLoaded(tab.windowId);
  const history = getHistory(tab.windowId);
  if (!history.length) {
    return;
  }
  if (history[0] === tab.id) {
    await switchToPreviousTab(tab.windowId);
  } else {
    try {
      await chrome.tabs.update(history[0], { active: true });
    } catch (error) {
      // Ignore if tab is gone.
    }
    pointerByWindow.set(tab.windowId, 0);
  }
});

if (CAN_USE_CONTEXT_MENUS && chrome.contextMenus.onShown) {
  chrome.contextMenus.onShown.addListener(async (info, tab) => {
    if (!tab || tab.windowId == null) {
      return;
    }
    await ensureHistoryLoaded(tab.windowId);
    await rebuildContextMenu(tab.windowId);
  });
}

if (CAN_USE_CONTEXT_MENUS) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.windowId == null) {
      return;
    }

    if (info.menuItemId === "open-tab-manager") {
      if (await isManagerWindow(tab.windowId)) {
        return;
      }
      const existingWindowId = managerWindowByTarget.get(tab.windowId);
      if (Number.isInteger(existingWindowId)) {
        try {
          await chrome.windows.update(existingWindowId, { focused: true });
          const tabs = await chrome.tabs.query({ windowId: existingWindowId });
          if (tabs[0]?.id != null) {
            await chrome.tabs.update(tabs[0].id, { active: true });
          }
          return;
        } catch (error) {
          managerWindowByTarget.delete(tab.windowId);
        }
      }
      const url = chrome.runtime.getURL(`tab_manager.html?windowId=${tab.windowId}`);
      await chrome.windows.create({
        url,
        type: "popup",
        width: 420,
        height: 600
      });
      return;
    }

    if (typeof info.menuItemId === "string" && info.menuItemId.startsWith("tab-")) {
      const tabId = Number(info.menuItemId.slice(4));
      if (Number.isInteger(tabId)) {
        await chrome.tabs.update(tabId, { active: true });
      }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "register-manager") {
    if (sender.tab && sender.tab.id != null && Number.isInteger(message.windowId)) {
      managerTabs.set(sender.tab.id, message.windowId);
      if (sender.tab.windowId != null) {
        managerWindowByTarget.set(message.windowId, sender.tab.windowId);
        managerTargetByWindow.set(sender.tab.windowId, message.windowId);
      }
    }
    return;
  }

  if (message.type === "unregister-manager") {
    if (sender.tab && sender.tab.id != null) {
      const targetWindowId = managerTabs.get(sender.tab.id);
      managerTabs.delete(sender.tab.id);
      if (Number.isInteger(targetWindowId)) {
        const managerWindowId = managerWindowByTarget.get(targetWindowId);
        if (managerWindowId === sender.tab.windowId) {
          managerWindowByTarget.delete(targetWindowId);
          managerTargetByWindow.delete(managerWindowId);
        }
      }
    }
    return;
  }

  if (message.type === "get-history") {
    const windowId = message.windowId ?? sender.tab?.windowId;
    if (windowId == null) {
      sendResponse({ tabs: [] });
      return;
    }

    ensureHistoryLoaded(windowId)
      .then(() => getOrderedTabs(windowId))
      .then((tabs) => {
        sendResponse({
          tabs: tabs.map((tab) => ({
            id: tab.id,
            title: tab.title || tab.pendingUrl || tab.url || "(Untitled)",
            favIconUrl: tab.favIconUrl || "",
            url: tab.url || tab.pendingUrl || "",
            active: !!tab.active
          }))
        });
      })
      .catch(() => sendResponse({ tabs: [] }));

    return true;
  }

  if (message.type === "activate-tab") {
    const tabId = message.tabId;
    if (Number.isInteger(tabId)) {
      if (message.preserveHistory) {
        activateTabPreservingHistory(tabId);
      } else {
        chrome.tabs.update(tabId, { active: true });
      }
    }
  }

  if (message.type === "close-tab") {
    const tabId = message.tabId;
    if (Number.isInteger(tabId)) {
      chrome.tabs.remove(tabId);
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const window = await chrome.windows.getLastFocused();
  if (!window || window.id == null) {
    return;
  }
  const isManager = await isManagerWindow(window.id);
  const targetWindowId = isManager ? managerTargetByWindow.get(window.id) : window.id;
  if (!Number.isInteger(targetWindowId)) {
    return;
  }
  if (command === "tab-history-back") {
    await navigateHistory(targetWindowId, 1);
  } else if (command === "tab-history-forward") {
    await navigateHistory(targetWindowId, -1);
  } else if (command === "open-tab-manager") {
    if (isManager) {
      return;
    }
    const existingWindowId = managerWindowByTarget.get(targetWindowId);
    if (Number.isInteger(existingWindowId)) {
      try {
        await chrome.windows.update(existingWindowId, { focused: true });
        const tabs = await chrome.tabs.query({ windowId: existingWindowId });
        if (tabs[0]?.id != null) {
          await chrome.tabs.update(tabs[0].id, { active: true });
        }
        return;
      } catch (error) {
        managerWindowByTarget.delete(targetWindowId);
        managerTargetByWindow.delete(existingWindowId);
      }
    }
    const url = chrome.runtime.getURL(`tab_manager.html?windowId=${targetWindowId}`);
    await chrome.windows.create({
      url,
      type: "popup",
      width: 420,
      height: 600
    });
  }
});
