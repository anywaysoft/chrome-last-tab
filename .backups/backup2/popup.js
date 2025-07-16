document.getElementById('logHistory').addEventListener('click', () => {
  console.log('Popup button "Show Tab History" clicked at', new Date().toISOString());
  const outputDiv = document.getElementById('historyOutput');
  outputDiv.textContent = 'Loading history...';

  chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting history:', chrome.runtime.lastError.message);
      outputDiv.textContent = 'Error: Check popup console for details';
      return;
    }
    console.log('Received history:', response.history);
    const historyText = Object.entries(response.history)
      .map(([windowId, tabIds]) => `Window ${windowId}: [${tabIds.join(', ')}]`)
      .join('\n') || 'No history available';
    outputDiv.textContent = historyText;
    console.log('Displayed history in popup:', historyText);
  });
});

document.getElementById('goPrevious').addEventListener('click', () => {
  console.log('Popup button "Go to Previous Tab" clicked at', new Date().toISOString());
  const outputDiv = document.getElementById('historyOutput');
  outputDiv.textContent = 'Switching to previous tab...';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs[0]) {
      console.error('Error getting active tab:', chrome.runtime.lastError?.message);
      outputDiv.textContent = 'Error: Could not get active tab';
      return;
    }
    const windowId = tabs[0].windowId;
    chrome.runtime.sendMessage({ action: 'goToPreviousTab', windowId }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error switching to previous tab:', chrome.runtime.lastError.message);
        outputDiv.textContent = 'Error: Check popup console for details';
        return;
      }
      outputDiv.textContent = response.success ? 'Switched to previous tab' : 'No previous tab available';
      console.log('Switch response:', response);
    });
  });
});
