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
    badge: "/assets/taxi_marker.png",

    vibrate: [300,200,300,200,300],

    requireInteraction: true,

    actions: [
      {
        action: "open",
        title: "Sifarişi aç"
      }
    ],

    data: {
      url: "/app/driver.html"
    }
  };

  self.registration.showNotification(title, options);

});

self.addEventListener("notificationclick", function(event){

  event.notification.close();

  event.waitUntil(

    clients.matchAll({type:"window", includeUncontrolled:true}).then(function(clientList){

      for (let client of clientList) {

        if (client.url.includes("driver.html") && "focus" in client) {
          return client.focus();
        }

      }

      return clients.openWindow("/app/driver.html");

    })

  );

});
