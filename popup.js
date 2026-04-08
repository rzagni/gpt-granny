const statusEl = document.getElementById("status");
const chatListEl = document.getElementById("chatList");
const selectedCountEl = document.getElementById("selectedCount");
const refreshBtn = document.getElementById("refreshBtn");
const selectAllBtn = document.getElementById("selectAllBtn");
const clearBtn = document.getElementById("clearBtn");
const deleteBtn = document.getElementById("deleteBtn");
const visibleSelectAll = document.getElementById("selectAllVisible");
const loadMoreToastEl = document.getElementById("loadMoreToast");

let chats = [];
let activeTabId = null;

const PAGE_SIZE = 25;
let nextOffset = 0;
let hasMore = true;
let isLoadingMore = false;
let loadedFromBackend = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message) {
  statusEl.textContent = message;
}

function showLoadMoreToast(message = "Loading more chats...") {
  if (!loadMoreToastEl) return;
  loadMoreToastEl.textContent = message;
  loadMoreToastEl.hidden = false;
}

function hideLoadMoreToast() {
  if (!loadMoreToastEl) return;
  loadMoreToastEl.hidden = true;
}

function setLoadMoreHint(message = "") {
  if (!loadMoreHintEl) return;
  loadMoreHintEl.textContent = message;
}

async function getActiveChatGPTTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab?.url) {
    throw new Error("No active tab found.");
  }

  if (!/^https:\/\/chatgpt\.com\//.test(tab.url)) {
    throw new Error("Open chatgpt.com in the active tab first.");
  }

  return tab;
}

async function runInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  });

  return results?.[0]?.result;
}

function updateSelectedCount() {
  const count = chats.filter((chat) => chat.checked).length;
  selectedCountEl.textContent = `${count} selected`;
  deleteBtn.disabled = count === 0;
}

function syncVisibleSelectAll() {
  if (!visibleSelectAll) return;
  visibleSelectAll.checked = chats.length > 0 && chats.every((chat) => chat.checked);
}

function renderChats() {
  if (!chats.length) {
    chatListEl.innerHTML = "";
    updateSelectedCount();
    syncVisibleSelectAll();
    return;
  }

  chatListEl.innerHTML = chats
    .map(
      (chat, index) => `
        <label class="chat-item">
          <input
            type="checkbox"
            class="chat-checkbox"
            data-index="${index}"
            ${chat.checked ? "checked" : ""}
          />
          <span class="chat-name">${escapeHtml(chat.title || "Untitled chat")}</span>
        </label>
      `
    )
    .join("");

  updateSelectedCount();
  syncVisibleSelectAll();
}

function appendChats(rawChats) {
  const seen = new Set(chats.map((chat) => chat.id));

  for (const item of rawChats || []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);

    chats.push({
      id: String(item.id),
      title: String(item.title || "Untitled chat"),
      checked: false
    });
  }
}

async function loadChatsPage(tabId, offset, limit) {
  return runInPage(
    tabId,
    async (pageOffset, pageLimit) => {
      function cleanTitle(text) {
        return (text || "").replace(/\s+/g, " ").trim();
      }

      function makeChat(id, title) {
        return {
          id,
          title: cleanTitle(title) || "Untitled chat"
        };
      }

      async function getAccessToken() {
        const sessionResponse = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "include"
        });

        if (!sessionResponse.ok) {
          throw new Error(`Auth session failed: HTTP ${sessionResponse.status}`);
        }

        const session = await sessionResponse.json();
        const token = session?.accessToken;

        if (!token) {
          throw new Error("No access token found.");
        }

        return token;
      }

      const token = await getAccessToken();

      const response = await fetch(
        `/backend-api/conversations?offset=${pageOffset}&limit=${pageLimit}&order=updated`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const items = Array.isArray(data?.items) ? data.items : [];

      return items
        .filter((item) => item?.id)
        .map((item) => makeChat(item.id, item.title));
    },
    [offset, limit]
  );
}

async function loadChatsFromDom(tabId) {
  return runInPage(
    tabId,
    () => {
      function cleanTitle(text) {
        return (text || "").replace(/\s+/g, " ").trim();
      }

      const found = new Map();
      const anchors = Array.from(
        document.querySelectorAll('a[href^="/c/"], a[href*="/c/"]')
      );

      for (const anchor of anchors) {
        const href = anchor.getAttribute("href") || "";
        const match = href.match(/\/c\/([a-zA-Z0-9-]+)/);
        if (!match) continue;

        const id = match[1];
        const title =
          cleanTitle(anchor.textContent) ||
          cleanTitle(anchor.getAttribute("aria-label")) ||
          cleanTitle(anchor.title) ||
          "Untitled chat";

        if (!found.has(id)) {
          found.set(id, { id, title });
        }
      }

      return Array.from(found.values());
    }
  );
}

async function loadMoreChats() {
  if (isLoadingMore || !hasMore || !loadedFromBackend || activeTabId == null) return;

  isLoadingMore = true;
  showLoadMoreToast("Loading more chats...");

  try {
    const page = await loadChatsPage(activeTabId, nextOffset, PAGE_SIZE);
    appendChats(page);
    renderChats();

    if (page.length < PAGE_SIZE) {
      hasMore = false;
      setStatus(`Loaded ${chats.length} chat(s).`);
    } else {
      nextOffset += PAGE_SIZE;
      setStatus(`Loaded ${chats.length} chat(s). Scroll to the bottom to load more.`);
    }
  } catch (error) {
    hasMore = false;
    setStatus(error.message || "Failed to load more chats.");
  } finally {
    hideLoadMoreToast();
    isLoadingMore = false;
  }
}

async function refreshChats() {
  try {
    setStatus("Loading chats...");
    deleteBtn.disabled = true;

    chats = [];
    nextOffset = 0;
    hasMore = true;
    isLoadingMore = false;
    loadedFromBackend = false;
    renderChats();

    const tab = await getActiveChatGPTTab();
    activeTabId = tab.id;

    try {
      const firstPage = await loadChatsPage(activeTabId, 0, PAGE_SIZE);

      if (firstPage.length) {
        appendChats(firstPage);
        loadedFromBackend = true;
        nextOffset = PAGE_SIZE;
        hasMore = firstPage.length === PAGE_SIZE;
        renderChats();
        setStatus(
          hasMore
            ? `Loaded ${chats.length} chat(s). Scroll to the bottom to load more.`
            : `Loaded ${chats.length} chat(s).`
        );
        return;
      }
    } catch (backendError) {
      //console.warn("Backend load failed, trying DOM fallback:", backendError);
    }

    const domChats = await loadChatsFromDom(activeTabId);
    appendChats(domChats);
    loadedFromBackend = false;
    hasMore = false;
    renderChats();

    if (!chats.length) {
      setStatus("No chats found.");
      return;
    }

    setStatus(`Loaded ${chats.length} chat(s) via page scan.`);
  } catch (error) {
    chats = [];
    renderChats();
    setStatus(error.message || "Failed to refresh chats.");
  }
}

async function deleteSelectedChats() {
  const selected = chats.filter((chat) => chat.checked);
  if (!selected.length) return;

  const confirmed = confirm(
    `Delete ${selected.length} selected chat(s)? This removes them from ChatGPT. This action cannot be reversed !`
  );

  if (!confirmed) return;

  try {
    const tab = await getActiveChatGPTTab();
    deleteBtn.disabled = true;

    let successCount = 0;
    let failCount = 0;
    const deletedIds = [];

    for (let i = 0; i < selected.length; i += 1) {
      const chat = selected[i];
      setStatus(`Deleting ${i + 1} of ${selected.length}: ${chat.title}`);

      const result = await runInPage(
        tab.id,
        async (conversationId) => {
          try {
            const sessionResponse = await fetch("/api/auth/session", {
              method: "GET",
              credentials: "include"
            });

            if (!sessionResponse.ok) {
              return {
                ok: false,
                error: `Failed to get auth session: HTTP ${sessionResponse.status}`
              };
            }

            const session = await sessionResponse.json();
            const token = session?.accessToken;

            if (!token) {
              return {
                ok: false,
                error: "No access token found in session."
              };
            }

            const response = await fetch(
              `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
              {
                method: "PATCH",
                credentials: "include",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ is_visible: false })
              }
            );

            if (!response.ok) {
              const text = await response.text();
              return {
                ok: false,
                status: response.status,
                error: text || `HTTP ${response.status}`
              };
            }

            const selectors = [
              `a[href="/c/${conversationId}"]`,
              `a[href^="/c/${conversationId}"]`,
              `a[href*="/c/${conversationId}"]`
            ];

            const removedNodes = [];
            for (const selector of selectors) {
              const nodes = document.querySelectorAll(selector);
              for (const node of nodes) {
                if (!removedNodes.includes(node)) {
                  removedNodes.push(node);
                }
              }
            }

            for (const node of removedNodes) {
              const row =
                node.closest("li") ||
                node.closest('[role="listitem"]') ||
                node.closest("div");
              if (row) {
                row.remove();
              } else {
                node.remove();
              }
            }

            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: error.message || "Delete request failed"
            };
          }
        },
        [chat.id]
      );

      if (result?.ok) {
        successCount += 1;
        deletedIds.push(chat.id);
      } else {
        failCount += 1;
        //console.error("Delete failed for chat", chat.id, result);
      }
    }

    if (deletedIds.length) {
      chats = chats.filter((chat) => !deletedIds.includes(chat.id));
      renderChats();
    }

    setStatus(`Deleted ${successCount}. Failed ${failCount}.`);

    if (failCount === 0 && chats.length === 0) {
      setStatus("All selected chats deleted.");
    }
  } catch (error) {
    setStatus(error.message || "Delete failed.");
  }
}

chatListEl.addEventListener("scroll", () => {
  if (!hasMore || isLoadingMore) return;

  const loadThreshold = 80;
  const distanceFromBottom =
    chatListEl.scrollHeight - (chatListEl.scrollTop + chatListEl.clientHeight);

  if (distanceFromBottom <= loadThreshold) {
    loadMoreChats();
  }
});

chatListEl.addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;

  const index = Number(checkbox.dataset.index);
  if (!Number.isNaN(index) && chats[index]) {
    chats[index].checked = checkbox.checked;
    updateSelectedCount();
    syncVisibleSelectAll();
  }
});

refreshBtn.addEventListener("click", refreshChats);

selectAllBtn.addEventListener("click", () => {
  chats = chats.map((chat) => ({ ...chat, checked: true }));
  renderChats();
});

clearBtn.addEventListener("click", () => {
  chats = chats.map((chat) => ({ ...chat, checked: false }));
  renderChats();
});

if (visibleSelectAll) {
  visibleSelectAll.addEventListener("change", () => {
    const checked = visibleSelectAll.checked;
    chats = chats.map((chat) => ({ ...chat, checked }));
    renderChats();
  });
}

deleteBtn.addEventListener("click", deleteSelectedChats);

function maybeShowLoadMoreHint() {
  if (!hasMore || isLoadingMore) return;

  const threshold = 80;
  const nearBottom =
    chatListEl.scrollTop + chatListEl.clientHeight >= chatListEl.scrollHeight - threshold;

  if (nearBottom) {
    setStatus("Reached the bottom. Scroll again to load more chats.");
  }
}

refreshChats();