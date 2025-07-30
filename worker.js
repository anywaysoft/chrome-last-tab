let tabHistories = new Map(); // Store history per window

console.log('Background script initialized at', new Date().toISOString());

function onError(msg, orElse) { 
  if (chrome.runtime.lastError) {
    console.error("Error " + msg + ": ", chrome.runtime.lastError.message);
  } else if(orElse) orElse();
}

function logHistory(windowId, msg) {
  console.log(`${msg}. History: ${tabHistories.get(windowId) || []}`);
}

function setupMenus(callback) {
  let promises = [
    chrome.contextMenus.create({
      id: 'openHistoryPopup',
      title: 'Show Tab History',
      contexts: ['action']
    }, () => onError("creating popup menu")),

    chrome.contextMenus.create({
      id: 'showTabHistory',
      title: 'Tab History',
      contexts: ['action']
    }, () => onError("creating history menu"))
  ]

  if (callback) Promise.all(promises).then(callback)
}

function openPopup() {
  console.log('Opening history popup');
  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 750,
    height: 600
  });
}

function compress(history) {
  let h = []
  history.forEach((x) => { if (!h || h[0] != x) h.unshift(x) })
  return h.reverse()
}

function popHistory(windowId, rmTab) {
  let history = tabHistories.get(windowId) || [];
  let tab = rmTab ? rmTab : history.pop();
  if (rmTab) history = history.filter(id => id !== rmTab); 
  tabHistories.set(windowId, compress(history))
  return tab
}

function pushHistory(windowId, tabId) {
  let history = tabHistories.get(windowId) || [];
  let tab = history.push(tabId);
  if (history.length > 50) history.shift(); 
  tabHistories.set(windowId, history);
  return tab 
}

function lastTab(windowId, tabId, callback) { 
  if (tabId) pushHistory(windowId, tabId); else {
    let t1 = popHistory(windowId)
    let t2 = popHistory(windowId)
    pushHistory(windowId, t1)
    if (t2) pushHistory(windowId, t2)
  }
  nextTab(windowId, callback);
  return true; 
}

function nextTab(windowId, callback) {
  let tabId = popHistory(windowId)
  if (!tabId) {
    console.log(`No valid tab to activate in window ${windowId}`);
    if (callback) callback();
    return;
  }

  logHistory(windowId, `Attempting to activate tab ${tabId}`)
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab && tab.windowId === windowId) {
      chrome.tabs.update(tabId, { active: true }, () => {
        onError("activating tab", () => {
          logHistory(windowId, `Successfully activated tab ${tabId}`)
          if (callback) callback(tabId);
        })
      });
    } else {
      console.error(`Tab ${tabId} is invalid or in wrong window:`, chrome.runtime.lastError?.message);
      nextTab(windowId, callback); 
    }
  });
}


function mkHistoryMenu() {
  const windowPromises = Array.from(tabHistories.keys()).map((windowId, index) => new Promise((resolve) => {
    chrome.windows.get(windowId, (window) => {
      if (chrome.runtime.lastError || !window) {
        console.warn(`Window ${windowId} not found:`, chrome.runtime.lastError?.message);
        resolve(null);
      } else if (window.type === 'normal') {
        let obj = { windowIndex: index + 1, windowId, history: (tabHistories.get(windowId) || []).toReversed() };
        resolve(obj);
      } else {
        console.log(`Excluding history for ${window.type} window ${windowId}`);
        resolve(null);
      }
    });
  }));

  Promise.all(windowPromises).then(results => {
    results.forEach(result => {
      if (result) {
        const { windowIndex, windowId, history } = result;
        // Create submenu for the window
        const windowMenuId = `window_${windowIndex}`;
        chrome.contextMenus.create({
          id: windowMenuId,
          parentId: 'showTabHistory',
          title: `Window ${windowIndex}`,
          contexts: ['action']
        }, () => onError(`creating window menu ${windowMenuId}`));

        const tabPromises = history.map((tabId, tabIndex) => new Promise((resolve) => {
          chrome.tabs.get(parseInt(tabId), (tab) => {
            if (chrome.runtime.lastError || !tab) {
              console.warn(`Tab ${tabId} not found:`, chrome.runtime.lastError?.message);
              resolve({ tabId, title: `Tab ${tabId} (Closed)`, windowId, tabIndex });
            } else {
              resolve({ tabId, title: tab.title || `Tab ${tabId}`, windowId, tabIndex });
            }
          });
        }));

        Promise.all(tabPromises).then(tabDetails => {
          tabDetails.forEach(({ tabId, title, windowId, tabIndex }) => {
            const tabMenuId = `tab_${windowId}_${tabId}_${tabIndex}`;
            chrome.contextMenus.create({
              id: tabMenuId,
              parentId: windowMenuId,
              title: title.length > 50 ? title.substring(0, 47) + '...' : title,
              contexts: ['action']
            }, () => onError(`creating tab menu ${tabMenuId}`))
          });
        });
      }
    });
  });
}

function updateMenus() { 
  chrome.contextMenus.removeAll(
      () => onError("removing context menus", () => setupMenus(() => mkHistoryMenu()))
  )
}

function activated(windowId, tabId) { 
  pushHistory(windowId, tabId);
  logHistory(windowId, `Tab ${tabId} activated`);
  updateMenus(); 
}

function initHistory() {
  chrome.tabs.query({}, function(tabs) {
   if (chrome.runtime.lastError) 
     console.warn(`Failed to get active tab:`, chrome.runtime.lastError?.message); 
   else if (tabs.length == 0)
      console.warn(`No active tab???`)
    else {
      tabs.sort((a, b) => a.lastAccessed - b.lastAccessed)
        .forEach(t => pushHistory(t.windowId, t.id));
      updateMenus();  
    }
  })
}

chrome.runtime.onInstalled.addListener(() => {
  initHistory();
});

// Flag is needed because when a tab is closed, there are two activation events:
// First the next default tab is activated, and then my listener activates the correct tab. 
// So, this `isClosing` is set to true to make activation listener skip those events to avoid
// polluting the history, and instead, the history is updated here explicitly, and then 
// flag is cleared after a delay to make sure the extra event is gone. 
// WHY NOT just set the flag here, and then clear it in activation listener after the first hit 
// (so that it would process the other event)? Well, because sometimes the default tab happens to 
// be the one we need, and then there is only one event, so we need to process it explicitly in that 
// case. This way, we avoid special cases: always skip activation events during closing, and always 
// update history explicitly in that case. 
let isClosing = false;
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  isClosing = true
  console.log(`Tab ${tabId} closed`);
  popHistory(removeInfo.windowId, tabId)
  nextTab(removeInfo.windowId, (newTabId) => {
    // if the last tab got closed, we have nothing to activate, so just turn 
    // the activation handler back on for the default event
    if (newTabId) activated(removeInfo.windowId, newTabId); else isClosing = false;
    setTimeout(() => isClosing = false, 50)
  })
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isClosing) { 
    console.log(`Skip activation event for tabId ${activeInfo.tabId}`)
    return;
  }

  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab.windowId) {
      console.error('Error getting tab:', chrome.runtime.lastError?.message);
      return;
    }
    chrome.windows.get(tab.windowId, (window) => {
      if (chrome.runtime.lastError || !window) {
        console.error('Error getting window:', chrome.runtime.lastError?.message);
        return;
      }
      if (window.type === 'normal') {
        activated(tab.windowId, activeInfo.tabId);
      } else {
        console.log(`Skipping history update for tab ${activeInfo.tabId} in ${window.type} window ${tab.windowId}`);
      }
    });
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getHistory') {
    console.log('Popup requested history');
    let historyObject = {};
    tabHistories.forEach((history, windowId) => {
      historyObject[windowId] = history;
    });
    console.log('Sending history to popup:', historyObject);
    sendResponse({ history: historyObject });
  } else if (request.action === 'switchToTab') {
    console.log(`Popup requested to switch to tab ${request.tabId} in window ${request.windowId}`);
    lastTab(request.windowId, request.tabId, () => sendResponse({ success: true }));
  }
});

chrome.action.onClicked.addListener((tab) => {
  console.log('Toolbar button clicked to switch to previous tab');
  lastTab(tab.windowId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openHistoryPopup') {
    openPopup()
  } else if (info.menuItemId.startsWith('tab_')) {
    // Handle tab menu item click
    const [, windowId, tabId] = info.menuItemId.split('_');
    console.log(`Clicked tab ${tabId} in window ${windowId} at`, new Date().toISOString());
    lastTab(parseInt(windowId), parseInt(tabId));
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  console.log(`Window ${windowId} closed, removing its history at`, new Date().toISOString());
  tabHistories.delete(windowId);
  updateMenus();
});
