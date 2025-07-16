let tabHistories = new Map(); // Store history per window

console.log('Background script initialized at', new Date().toISOString());

function onError(msg) { 
  if (chrome.runtime.lastError) {
    console.error("Error " + msg + ":", chrome.runtime.lastError.message);
  }
}

function setupMenus() {
  chrome.contextMenus.create({
    id: 'openHistoryPopup',
    title: 'Show Tab History',
    contexts: ['action']
  }, () => onError("creating popup menu"));

  chrome.contextMenus.create({
    id: 'showTabHistory',
    title: 'Tab History >',
    contexts: ['action']
  }, () => onError("creating history menu")); 
}

function openPopup() {
  console.log('Opening history popup');
  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 320,
    height: 400
  });
}

function popHistory(windowId, rmTab) {
  let history = tabHistories.get(windowId) || [];
  let tab = rmTab ? rmTab : history.pop();
  if (rmTab) history = history.filter(id => id !== rmTab); 
  console.log(`New history for window ${windowId}: ${history}`);
  tabHistories.set(windowId, history)
  return tab
}

function pushHistory(windowId, tabId) {
  let history = tabHistories.get(windowId) || [];
  let tab = history.push(tabId);
  if (history.length > 50) history.shift(); 
  console.log(`New history for window ${windowId}: ${history}`);
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
  nextTab(windowId, () => {
     console.log(`History after switching:`, tabHistories.get(windowId) || []); 
     if (callback) callback();
  })
  return true; 
}

function nextTab(windowId, callback) {
  let tabId = popHistory(windowId)
  if (!tabId) {
    console.log(`No valid tab to activate in window ${windowId}`);
    if (callback) callback();
    return;
  }

  console.log(`Attempting to activate tab ${tabId} in window ${windowId}`);
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab && tab.windowId === windowId) {
      chrome.tabs.update(tabId, { active: true }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error activating tab:', chrome.runtime.lastError.message);
          nextTab(windowId, callback); 
        } else {
          console.log(`Successfully activated tab ${tabId}`);
          if (callback) callback();
        }
      });
    } else {
      console.error(`Tab ${tabId} is invalid or in wrong window:`, chrome.runtime.lastError?.message);
      nextTab(windowId, callback); 
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  console.log("Context menus installed")
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log(`Tab ${tabId} closed in window ${removeInfo.windowId} at`, new Date().toISOString());
  popHistory(removeInfo.windowId, tabId)
  nextTab(removeInfo.windowId)
});


chrome.tabs.onActivated.addListener((activeInfo) => {
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
        console.log(`Tab ${activeInfo.tabId} activated in window ${tab.windowId}: ${window}`);
        pushHistory(tab.windowId, activeInfo.tabId)
      } else {
        console.log(`Skipping history update for tab ${activeInfo.tabId} in ${window.type} window ${tab.windowId}`);
      }
    });
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getHistory') {
    console.log('Popup requested history at', new Date().toISOString());
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
  } else if (info.menuItemId === 'showTabHistory') {
    console.log('Show Tab History clicked at', new Date().toISOString());

    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {
        console.error('Error removing context menus:', chrome.runtime.lastError.message);
      }
      setupMenus();

      const windowPromises = Array.from(tabHistories.keys).map((windowId, index) => new Promise((resolve) => {
        chrome.windows.get(windowId, (window) => {
          if (chrome.runtime.lastError || !window) {
            console.warn(`Window ${windowId} not found:`, chrome.runtime.lastError?.message);
            resolve(null);
          } else if (window.type === 'normal') {
            resolve({ windowIndex: index + 1, windowId, history: tabHistories.get(windowId) || [] });
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
            }, () => {
              if (chrome.runtime.lastError) {
                console.error(`Error creating window menu ${windowMenuId}:`, chrome.runtime.lastError.message);
              }
            });

            // Fetch tab details and create menu items with unique IDs
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
                }, () => {
                  if (chrome.runtime.lastError) {
                    console.error(`Error creating tab menu ${tabMenuId}:`, chrome.runtime.lastError.message);
                  }
                });
              });
            });
          }
        });
      });
    });
  } else if (info.menuItemId.startsWith('tab_')) {
    // Handle tab menu item click
    const [, windowId, tabId] = info.menuItemId.split('_');
    console.log(`Clicked tab ${tabId} in window ${windowId} at`, new Date().toISOString());
    lastTab(parseInt(windowId), parseInt(tabId));
  }
});
