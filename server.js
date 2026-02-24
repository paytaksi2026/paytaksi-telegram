
// ===== CHAT SYSTEM (ADDITIVE PATCH) =====
if (!global.orderChats) {
  global.orderChats = {};
}

// Send message
app.post("/api/chat/send", (req, res) => {
  const { orderId, sender, text } = req.body;
  if (!orderId || !text) return res.status(400).json({ error: "Missing data" });

  if (!global.orderChats[orderId]) {
    global.orderChats[orderId] = [];
  }

  const message = {
    id: Date.now(),
    sender,
    text,
    time: new Date()
  };

  global.orderChats[orderId].push(message);
  res.json({ success: true });
});

// Get messages
app.get("/api/chat/:orderId", (req, res) => {
  const { orderId } = req.params;
  const messages = global.orderChats[orderId] || [];
  res.json(messages);
});
