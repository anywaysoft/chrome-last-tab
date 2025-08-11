let tabHistories = new Map(); // Store history per window

console.log('Background script initialized');

function onError(msg, orElse) { 
  if (chrome.runtime.lastError) {
    console.error("Error " + msg + ": ", chrome.runtime.lastError.message);
  } else if(orElse) orElse();
}

function logHistory(msg) {
  console.log(`${msg}. History:`, tabHistories);
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

function popHistory(windowId, rmTab) {
  let history = tabHistories.get(windowId) || [];
  let tab = rmTab ? rmTab : history.pop();
  if (rmTab) history = history.filter(id => id !== rmTab); 
  if (history.length) tabHistories.set(windowId, history);
  return tab
}

function pushHistory(windowId, tabId) {
  let history = (tabHistories.get(windowId) || []).filter(t => t != tabId);
  let tab = history.push(tabId);
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

function nextTab(windowId, callback, nofix) {
  let tabId = popHistory(windowId)
  logHistory(`Attempting to activate tab ${tabId} in window ${windowId}.`)
  if (!tabId) {
    console.log(`No valid tab to activate in window ${windowId}`);
    // History seems to just disappear sometime. If it happens, try to "repair" it 
    // by getting a fresh list of tabs from chrome. 
    if (!nofix) initHistory(() => nextTab(windowId, callback, true)); else if (callback) callback();
    return;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab && tab.windowId === windowId) {
      chrome.tabs.update(tabId, { active: true }, () => {
        onError("activating tab", () => {
          logHistory(`Successfully activated tab ${tabId} in ${windowId}.`)
          if (callback) callback(tabId);
        })
      });
    } else {
      console.error(`Tab ${tabId} is invalid or in wrong window:`, chrome.runtime.lastError?.message);
      nextTab(windowId, callback); 
    }
  });
}

// NOTE: If you activate window #1, and then hover over the button in window #2, and open the menu without clicking on it
// you'll see the menu for the wrong window (#1, not #2). This is because chrome doesn't send us any event until you actually
// activate the window by clicking on it, so I don't know when to refresh the menu.
// Still think this quirk is better than the alternative (showing all windows as submenus), which I think is just stupid.
function mkHistoryMenu() {
  chrome.windows.getCurrent({populate:true}, w => { 
    if (chrome.runtime.lastError) console.warn(`Failed to query active window: `, chrome.runtime.lastError?.message); else {
      let byId = new Map() 
      w.tabs.forEach(t => byId.set(t.id, t))

      history = tabHistories.get(w.id)
      let sortedTabs = []; 
      history.forEach(t => {
        let tab = byId.get(t)
        if (!tab) console.warn(`Invalid tab id ${t} in history: not found in window!`); else sortedTabs.push(tab)
        byId.delete(t)
      })

      if (byId.size) {
        let missingTabs = [...byId.values()].sort((a,b) => a.lastAccessed - b.lastAccessed);
        console.warn(`Tabs in window but not in history!`, missingTabs)
        history.push(...missingTabs.map(t => t.id))
        sortedTabs.push(...missingTabs)
      }


      sortedTabs.reverse().forEach(tab => {
         chrome.contextMenus.create({
          id: `tab_${tab.windowId}_${tab.id}`,
          parentId: 'showTabHistory',
          title: (tab.title.length > 50 ? tab.title.substring(0, 47) + '...' : tab.title) || "<Untitled Tab>",
          contexts: ['action']
         }, () => onError(`creating tab menu for ${tab.id}: ${tab.title}`, () => console.log(`Set up menu for window ${w.id}`)))
      })
    } 
  })
}   

let updateLock = false
function updateMenus() { 
  if (updateLock) console.log("Skip menu update: already in progress"); else {
    updateLock = true;
    chrome.contextMenus.removeAll(
      () => onError("removing context menus", () => setupMenus(() => mkHistoryMenu()))
    )
    setTimeout(() => updateLock = false, 50)
  }
}

function activated(windowId, tabId) { 
  pushHistory(windowId, tabId);
  logHistory(`Tab ${tabId} activated in ${windowId}.`);
  updateMenus(); 
}

function initHistory(callback) {
  chrome.tabs.query({}, (tabs) => {
   if (chrome.runtime.lastError) 
     console.warn(`Failed to fetch tabs:`, chrome.runtime.lastError?.message); 
   else if (tabs.length == 0)
      console.warn(`No tabs???`)
    else {
      tabs.sort((a, b) => a.lastAccessed - b.lastAccessed)
        .forEach(t => pushHistory(t.windowId, t.id));
    }
    if(callback) callback();
  })
}

chrome.runtime.onInstalled.addListener(() => initHistory(() => updateMenus()));

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && changeInfo.title) {
    console.log("Updating menus!")
    updateMenus()
  }
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

chrome.windows.onFocusChanged.addListener((id) => { 
  if (id != -1) {
    console.log("Window activated: ", id);
    updateMenus();
  }
})

chrome.windows.onRemoved.addListener((windowId) => {
  tabHistories.delete(windowId);
  logHistory(`Window ${windowId} closed`)
  updateMenus();
});