const statusTextEl = document.getElementById("status-text");
const statusContainer = document.getElementById("status-container");
const progressBar = document.getElementById("progress-bar");
const progressWrapper = document.getElementById("progress-wrapper");
const progressPercent = document.getElementById("progress-percent");

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

const DELETE_BATCH_SIZE = 10;

function setStatus(message) {
  statusTextEl.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

async function getActiveChatGPTTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab?.url) throw new Error("No active tab found.");
  if (!/^https:\/\/chatgpt\.com\//.test(tab.url))
    throw new Error("Open chatgpt.com first.");
  return tab;
}

async function runInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
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
  visibleSelectAll.checked =
    chats.length > 0 && chats.every((chat) => chat.checked);
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
      `,
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
      checked: false,
    });
  }
}

async function loadChatsPage(tabId, offset, limit) {
  return runInPage(
    tabId,
    async (pageOffset, pageLimit) => {
      async function getAccessToken() {
        const sessionResponse = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "include",
        });
        const session = await sessionResponse.json();
        return session?.accessToken;
      }
      const token = await getAccessToken();
      const response = await fetch(
        `/backend-api/conversations?offset=${pageOffset}&limit=${pageLimit}&order=updated`,
        {
          method: "GET",
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const data = await response.json();
      return (data?.items || []).map((item) => ({
        id: item.id,
        title: item.title,
      }));
    },
    [offset, limit],
  );
}

async function refreshChats() {
  try {
    setStatus("Loading chats...");
    statusContainer.className = "status status-idle";
    progressWrapper.hidden = true;
    progressPercent.hidden = true;
    deleteBtn.disabled = true;

    chats = [];
    nextOffset = 0;
    hasMore = true;
    renderChats();

    const tab = await getActiveChatGPTTab();
    activeTabId = tab.id;

    const firstPage = await loadChatsPage(activeTabId, 0, PAGE_SIZE);
    if (firstPage && firstPage.length) {
      appendChats(firstPage);
      loadedFromBackend = true;
      nextOffset = PAGE_SIZE;
      hasMore = firstPage.length === PAGE_SIZE;
    }

    renderChats();
    setStatus(
      chats.length ? `Loaded ${chats.length} chats.` : "No chats found.",
    );
  } catch (error) {
    setStatus(error.message);
  }
}

async function deleteSelectedChats() {
  const selected = chats.filter((chat) => chat.checked);
  if (!selected.length) return;

  if (!confirm(`Delete ${selected.length} selected chat(s)?`)) return;

  try {
    const tab = await getActiveChatGPTTab();
    deleteBtn.disabled = true;

    statusContainer.className = "status status-working";
    progressWrapper.hidden = false;
    progressPercent.hidden = false;
    progressBar.style.width = "0%";
    setStatus("Deleting chats...");

    const token = await runInPage(tab.id, async () => {
      const resp = await fetch("/api/auth/session");
      const session = await resp.json();
      return session?.accessToken;
    });

    let successCount = 0;
    let deletedIds = [];

    for (let i = 0; i < selected.length; i += DELETE_BATCH_SIZE) {
      const batch = selected.slice(i, i + DELETE_BATCH_SIZE);

      // Update Progress
      const percent = Math.round((i / selected.length) * 100);
      progressBar.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;

      const results = await Promise.allSettled(
        batch.map((chat) =>
          runInPage(
            tab.id,
            async (id, authToken) => {
              const res = await fetch(`/backend-api/conversation/${id}`, {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${authToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ is_visible: false }),
              });
              return res.ok;
            },
            [chat.id, token],
          ),
        ),
      );

      results.forEach((res, idx) => {
        if (res.status === "fulfilled" && res.value) {
          successCount++;
          deletedIds.push(batch[idx].id);
        }
      });

      if (i + DELETE_BATCH_SIZE < selected.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    progressBar.style.width = "100%";
    progressPercent.textContent = "100%";
    statusContainer.className = "status status-success";
    setStatus(`Swept ${successCount} chats away!`);

    chats = chats.filter((c) => !deletedIds.includes(c.id));
    renderChats();

    setTimeout(() => {
      progressWrapper.hidden = true;
      progressPercent.hidden = true;
    }, 3000);
  } catch (error) {
    setStatus("Error: " + error.message);
    statusContainer.className = "status status-idle";
  } finally {
    updateSelectedCount();
  }
}

// Event Listeners
chatListEl.addEventListener("change", (e) => {
  const box = e.target.closest(".chat-checkbox");
  if (!box) return;
  chats[box.dataset.index].checked = box.checked;
  updateSelectedCount();
  syncVisibleSelectAll();
});

refreshBtn.addEventListener("click", refreshChats);
deleteBtn.addEventListener("click", deleteSelectedChats);
visibleSelectAll.addEventListener("change", () => {
  const checked = visibleSelectAll.checked;
  chats.forEach((c) => (c.checked = checked));
  renderChats();
});

refreshChats();
