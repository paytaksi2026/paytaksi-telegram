
// PayTaksi Driver Firebase Push Init
// Add this script to driver.html with:
// <script src="/driver_push.js"></script>

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyBjueII42zC-Cs-SJ5eIhPlScj7i2lA6co",
  authDomain: "paytaksi-cd826.firebaseapp.com",
  projectId: "paytaksi-cd826",
  messagingSenderId: "76622339047",
  appId: "1:76622339047:web:f93ba8d00f3cb8fc21fb42"
};

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

async function initPush() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.log("Notification icazəsi verilmədi");
      return;
    }

    const token = await getToken(messaging, {
      vapidKey: "BNt_j4qLDxp8ZhVghyBc4cW8Xt6ojpkCTSFbtiRmhTMOf4xDW8YCB4xH9GwZY4jJCuI7AA9epI1capmX6_cgj8o"
    });

    console.log("Driver push token:", token);

    // send token to server
    fetch("/api/driver/push-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });

  } catch (e) {
    console.log("Push init error", e);
  }
}

initPush();

onMessage(messaging, (payload) => {
  console.log("Foreground push:", payload);

  if (payload.notification) {
    const audio = new Audio("/assets/uber_ding.mp3");
    audio.play().catch(()=>{});

    alert(payload.notification.title + "\n" + payload.notification.body);
  }
});
