// Setup context menu on installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-to-rash',
    title: '💾 Save selection to RaSh',
    contexts: ['selection']
  });
});

// Helper function to send memory payload to RaSh server
async function sendToRaSh(tabTitle, text) {
  try {
    const res = await fetch('http://localhost:3000/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        form_name: `Web: ${tabTitle}`,
        content: text.trim(),
        is_sensitive: false
      })
    });
    return res.ok;
  } catch (err) {
    console.error('RaSh capture error:', err);
    return false;
  }
}

// Right-click context menu handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-to-rash' && info.selectionText) {
    sendToRaSh(tab.title || 'Untitled Web Note', info.selectionText);
  }
});

// Hotkey handler (Alt+Shift+M / Option+Shift+M)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick-capture') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection().toString()
      });

      const selectedText = results?.[0]?.result;
      if (selectedText && selectedText.trim()) {
        await sendToRaSh(tab.title || 'Untitled Web Note', selectedText);
      }
    } catch (e) {
      console.warn('Cannot inject into this page:', e);
    }
  }
});