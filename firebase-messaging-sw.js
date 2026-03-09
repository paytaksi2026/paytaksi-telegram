
// Firebase Messaging Service Worker (PayTaksi)
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBjueII42zC-Cs-SJ5eIhPlScj7i2lA6co",
  authDomain: "paytaksi-cd826.firebaseapp.com",
  projectId: "paytaksi-cd826",
  messagingSenderId: "76622339047",
  appId: "1:76622339047:web:f93ba8d00f3cb8fc21fb42"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification?.title || "PayTaksi";
  const options = {
    body: payload.notification?.body || "Yeni sifariş",
    icon: "/assets/taxi_marker.png",
    vibrate: [200,120,200,120,200],
    data: { url: "/app/driver.html" }
  };

  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", function(event){
  event.notification.close();
  event.waitUntil(
    clients.openWindow("/app/driver.html")
  );
});
