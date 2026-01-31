const tabList = document.getElementById("tab-list");
const params = new URLSearchParams(window.location.search);
const targetWindowId = Number(params.get("windowId"));

function renderTabs(tabs) {
  tabList.innerHTML = "";

  if (!tabs.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No tabs available.";
    tabList.appendChild(empty);
    return;
  }

  for (const tab of tabs) {
    const row = document.createElement("li");
    row.className = "tab-row";

    const icon = document.createElement("img");
    icon.className = "favicon";
    icon.alt = "";
    icon.src = tab.favIconUrl || "";
    row.appendChild(icon);

    const titleButton = document.createElement("button");
    titleButton.className = "tab-title";
    titleButton.textContent = tab.active ? `> ${tab.title}` : tab.title;
    if (tab.url) {
      titleButton.title = tab.url;
    }
    titleButton.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "activate-tab",
        tabId: tab.id,
        preserveHistory: true
      });
    });
    row.appendChild(titleButton);

    const closeButton = document.createElement("button");
    closeButton.className = "tab-close";
    closeButton.setAttribute("aria-label", `Close ${tab.title}`);
    closeButton.textContent = "X";
    closeButton.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "close-tab", tabId: tab.id });
      row.remove();
    });
    row.appendChild(closeButton);

    if (tab.active) {
      row.classList.add("is-current");
    }

    tabList.appendChild(row);
  }
}

function refreshTabs() {
  const payload = { type: "get-history" };
  if (Number.isInteger(targetWindowId)) {
    payload.windowId = targetWindowId;
  }
  chrome.runtime.sendMessage(payload, (response) => {
    if (!response || !Array.isArray(response.tabs)) {
      renderTabs([]);
      return;
    }
    renderTabs(response.tabs);
  });
}

if (Number.isInteger(targetWindowId)) {
  chrome.runtime.sendMessage({ type: "register-manager", windowId: targetWindowId });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "history-updated") {
    return;
  }
  if (!Number.isInteger(targetWindowId) || message.windowId !== targetWindowId) {
    return;
  }
  refreshTabs();
});

window.addEventListener("focus", refreshTabs);
window.addEventListener("beforeunload", () => {
  chrome.runtime.sendMessage({ type: "unregister-manager" });
});
refreshTabs();
