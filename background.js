// Open the side panel from the toolbar icon
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true
  });
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Open the quiz popup; pass the origin tabId so the popup knows which page to read
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "OPEN_QUIZ_POPUP") {
    const url = chrome.runtime.getURL("quiz.html") + (msg.tabId ? `?tabId=${msg.tabId}` : "");
    chrome.windows.create(
      {
        url,
        type: "popup",
        width: 520,
        height: 680,
        focused: true
      },
      () => sendResponse({ ok: true })
    );
    return true; // keep channel open for async sendResponse
  }
});
