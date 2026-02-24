
let unread = 0;
let currentOrderId = null;

function initChat(orderId) {
  currentOrderId = orderId;
  setInterval(fetchMessages, 2000);
}

function fetchMessages() {
  if (!currentOrderId) return;

  fetch(`/api/chat/${currentOrderId}`)
    .then(res => res.json())
    .then(messages => {
      if (!window.lastMessageCount) window.lastMessageCount = 0;

      if (messages.length > window.lastMessageCount) {
        const newMsg = messages[messages.length - 1];
        newMessageNotify(newMsg.sender, newMsg.text);
      }

      window.lastMessageCount = messages.length;
    });
}

function sendMessage(sender, text) {
  fetch("/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: currentOrderId,
      sender,
      text
    })
  });
}

function newMessageNotify(sender, text) {
  document.getElementById("msgSound").play().catch(()=>{});

  const toast = document.getElementById("chatToast");
  toast.innerText = sender + ": " + text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 4000);

  const overlay = document.getElementById("chatOverlay");
  overlay.innerText = text;
  overlay.classList.add("show");
  setTimeout(() => overlay.classList.remove("show"), 3500);

  unread++;
  const badge = document.getElementById("chatBadge");
  badge.style.display = "block";
  badge.innerText = unread;
}

function openChat() {
  unread = 0;
  document.getElementById("chatBadge").style.display = "none";
}
