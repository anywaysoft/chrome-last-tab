document.addEventListener('DOMContentLoaded', () => {
  console.log('Popup loaded at', new Date().toISOString());
  const outputDiv = document.getElementById('historyOutput');
  outputDiv.textContent = 'Loading history...';

  chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting history:', chrome.runtime.lastError.message);
      outputDiv.textContent = 'Error: Check popup console for details';
      return;
    }
    console.log('Received history:', response.history);

    // Clear output
    outputDiv.innerHTML = '';

    // Process each window's history
    let idx = 1;
    const windowPromises = Object.entries(response.history).map(([windowId, tabIds]) => {
      const windowDiv = document.createElement('div');
      windowDiv.className = 'mb-2';
      windowDiv.innerHTML = `<strong>Window ${idx}:</strong>`;
      idx++;

      // Create table for tabs
      const table = document.createElement('table');
      table.className = 'history-table';

      // Add header row
      const headerRow = document.createElement('tr');
      headerRow.innerHTML = `
        <th style="width: 24px;"></th>
        <th>Title</th>
      `;
      table.appendChild(headerRow);

      // Fetch tab details for each tab ID
      const tabPromises = tabIds.reverse().map(tabId => new Promise((resolve) => {
        chrome.tabs.get(parseInt(tabId), (tab) => {
          if (chrome.runtime.lastError || !tab) {
            console.warn(`Tab ${tabId} not found:`, chrome.runtime.lastError?.message);
            resolve({ tabId, title: `Tab ${tabId} (Closed)`, favIconUrl: '' });
          } else {
            resolve({ tabId, title: tab.title || `Tab ${tabId}`, favIconUrl: tab.favIconUrl || '' });
          }
        });
      }));

      return Promise.all(tabPromises).then(tabs => {
        tabs.forEach(({ tabId, title, favIconUrl }) => {
          const row = document.createElement('tr');
          const iconCell = document.createElement('td');
          const titleCell = document.createElement('td');
          const tabLink = document.createElement('a');
          tabLink.href = '#';
          tabLink.className = 'tab-link';
          tabLink.innerHTML = `
            ${favIconUrl ? `<img src="${favIconUrl}" alt="favicon">` : '<span class="placeholder"></span>'}
            <span class="tab-title">${title}</span>
          `;
          tabLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log(`Clicked link for tab ${tabId} in window ${windowId}`);
            chrome.runtime.sendMessage({ action: 'switchToTab', tabId: parseInt(tabId), windowId: parseInt(windowId) }, (response) => {
              if (chrome.runtime.lastError) {
                console.error('Error switching to tab:', chrome.runtime.lastError.message);
              } else {
                console.log('Switch response:', response);
              }
            });
          });
          titleCell.appendChild(tabLink);
          row.appendChild(iconCell);
          row.appendChild(titleCell);
          table.appendChild(row);
        });
        windowDiv.appendChild(table);
        return windowDiv;
      });
    });

    Promise.all(windowPromises).then((windowDivs) => {
      if (windowDivs.length === 0) {
        outputDiv.textContent = 'No history available';
      } else {
        windowDivs.forEach(div => outputDiv.appendChild(div));
      }
      console.log('Displayed history in popup');
    });
  });
});
