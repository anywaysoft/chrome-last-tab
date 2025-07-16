let tabHistories = new Map(); // Store history per window
let isSwitching = false; // Flag for closing or manual switching

console.log('Background script initialized at', new Date().toISOString());

// Track tab activations
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isSwitching) {
    console.log('Skipping history update during tab switch');
    return;
  }
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
  isSwitching = true;
  const windowId = removeInfo.windowId;

  let history = tabHistories.get(windowId) || [];
  console.log(`History for window ${windowId} before filtering:`, history);
  history = history.filter(id => id !== tabId); // Remove closed tab
  console.log(`History for window ${windowId} after filtering:`, history);

  // Save the updated history
  tabHistories.set(windowId, history);

  tryActivateNextTab(windowId, history, () => {
    isSwitching = false;
  });
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
    callback();
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
          // Re-add the activated tab to history
          history = tabHistories.get(windowId) || [];
          history.push(lastTabId);
          tabHistories.set(windowId, history);
          console.log(`Re-added tab ${lastTabId} to history:`, history);
          callback();
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
    const windowId = request.windowId;
    let history = tabHistories.get(windowId) || [];
    console.log(`History for window ${windowId}:`, history);
    isSwitching = true;
    history.pop()
    tryActivateNextTab(windowId, history, () => {
      isSwitching = false;
      sendResponse({ success: true });
    });
    return true; // Keep message channel open for async response
  }
});
