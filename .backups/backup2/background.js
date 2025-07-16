let tabHistories = new Map(); // Store history per window

console.log('Background script initialized at', new Date().toISOString());

// Initialize context menu for accessing popup
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'openHistoryPopup',
    title: 'Show Tab History',
    contexts: ['action']
  });
  console.log('Context menu created for history popup');
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openHistoryPopup') {
    console.log('Opening history popup');
    chrome.windows.create({
      url: 'popup.html',
      type: 'popup',
      width: 320,
      height: 400
    });
  }
});

// Track tab activations
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab.windowId) {
      console.error('Error getting tab:', chrome.runtime.lastError?.message);
      return;
    }
    console.log(`Tab ${activeInfo.tabId} activated in window ${tab.windowId}`);
    let history = tabHistories.get(tab.windowId) || [];
    history.push(activeInfo.tabId);
    if (history.length > 50) {
      history.shift(); // Keep history manageable
    }
    tabHistories.set(tab.windowId, history);
    console.log(`Updated history for window ${tab.windowId}:`, history);
  });
});

// Handle tab closure
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log(`Tab ${tabId} closed in window ${removeInfo.windowId} at`, new Date().toISOString());
  const windowId = removeInfo.windowId;

  let history = tabHistories.get(windowId) || [];
  console.log(`History for window ${windowId} before filtering:`, history);
  history = history.filter(id => id !== tabId); // Remove closed tab
  console.log(`History for window ${windowId} after filtering:`, history);

  // Save the updated history
  tabHistories.set(windowId, history);

  tryActivateNextTab(windowId, history)
});

function lastTab(windowId, callback) { 
  let history = tabHistories.get(windowId) || [];
  console.log(`History for window ${windowId}:`, history);
  if (history.length > 0) {
    let t1 = history.pop();
    let t2 = history.pop();
    if (t2) { history.push(t1); history.push(t2); }
    console.log(`History after popping current tab:`, history);
    tabHistories.set(windowId, history);
  }
  tryActivateNextTab(windowId, history, () => {
   if (callback) callback();
   console.log(`History after switching:`, history);
  });
  return true; // Keep message channel open for async response
}


// Handle toolbar button click
chrome.action.onClicked.addListener((tab) => {
  console.log('Toolbar button clicked to switch to previous tab at', new Date().toISOString());
  lastTab(tab.windowId);
});


// Clean up history when a window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  console.log(`Window ${windowId} closed, removing its history at`, new Date().toISOString());
  tabHistories.delete(windowId);
});

// Recursive function to try activating the next valid tab
function tryActivateNextTab(windowId, history, callback) {
  let lastTabId = history.length > 0 ? history.pop() : null;
  console.log(`Popped lastTabId: ${lastTabId} for window ${windowId}`);
  tabHistories.set(windowId, history); // Update history after pop

  if (!lastTabId) {
    console.log(`No valid tab to activate in window ${windowId}`);
    if (callback) callback();
    return;
  }

  console.log(`Attempting to activate tab ${lastTabId} in window ${windowId}`);
  chrome.tabs.get(lastTabId, (tab) => {
    if (!chrome.runtime.lastError && tab && tab.windowId === windowId) {
      console.log(`Activating tab ${lastTabId} in window ${windowId}`);
      chrome.tabs.update(lastTabId, { active: true }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error activating tab:', chrome.runtime.lastError.message);
          tryActivateNextTab(windowId, history, callback); // Try next tab
        } else {
          console.log(`Successfully activated tab ${lastTabId} at`, new Date().toISOString());
          if (callback) callback();
        }
      });
    } else {
      console.error(`Tab ${lastTabId} is invalid or in wrong window:`, chrome.runtime.lastError?.message);
      tryActivateNextTab(windowId, history, callback); // Try next tab
    }
  });
}

// Handle popup messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getHistory') {
    console.log('Popup requested history at', new Date().toISOString());
    let historyObject = {};
    tabHistories.forEach((history, windowId) => {
      historyObject[windowId] = history;
    });
    console.log('Sending history to popup:', historyObject);
    sendResponse({ history: historyObject });
  } else if (request.action === 'goToPreviousTab') {
    console.log('Popup requested to go to previous tab at', new Date().toISOString());
    lastTab(request.windowId, () => sendResponse({ success: true }));
    return true; // Keep message channel open for async response
  }
});
