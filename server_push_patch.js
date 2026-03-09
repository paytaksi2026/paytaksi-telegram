
// PayTaksi Firebase Push Patch (Node.js)

const fetch = require("node-fetch");

const FIREBASE_SERVER_KEY = "YOUR_FIREBASE_SERVER_KEY";

async function sendDriverPush(token, title, body){
  try{
    await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "key=" + FIREBASE_SERVER_KEY
      },
      body: JSON.stringify({
        to: token,
        notification: {
          title: title,
          body: body,
          sound: "default"
        },
        data: {
          click_action: "OPEN_DRIVER"
        },
        priority: "high"
      })
    });
  }catch(e){
    console.log("Push error", e);
  }
}

module.exports = { sendDriverPush };
