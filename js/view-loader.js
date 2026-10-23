var viewFiles = [
  "views/home.html",
  "views/dashboard.html",
  "views/admin-login.html",
  "views/admin.html",
  "views/tv-board.html"
];

var appScripts = [
  "js/ui.js",
  "js/notif-dropdown.js",
  "js/navigation.js",
  "js/auth.js",
  "js/walkin.js",
  "js/queue.js",
  "js/student-dashboard.js",
  "js/alerts.js",
  "js/user-notifications.js",
  "js/admin-console.js",
  "js/admin-dashboard.js",
  "js/admin-queue.js",
  "js/admin-enrollment.js",
  "js/admin-enrollment-settings.js",
  "js/admin-settings.js",
  "js/admin-enforcer.js",
  "js/admin-notifications.js",
  "js/admin-rules.js",
  "js/admin-reports.js",
  "js/admin-status.js",
  "js/staff-alerts.js",
  "js/firebase.js",
  "js/admin-auth.js",
  "js/notifications.js",
  "js/landing.js",
  "js/tv-announcer.js",
  "js/tv-board.js",
  "js/router.js"
];

function loadTextFile(path) {
  return fetch(path).then(function (response) {
    if (!response.ok) {
      throw new Error("Could not load " + path);
    }
    return response.text();
  });
}

// The scripts start downloading right away, alongside the views, instead of one after another.
appScripts.forEach(function (path) {
  var hint = document.createElement("link");
  hint.rel = "preload";
  hint.as = "script";
  hint.href = path;
  document.head.appendChild(hint);
});

// All script tags go in at once. async = false makes the browser run them in list order (each file relies on the
// ones before it) while downloading them in parallel. Resolves when the last one has run.
function loadScriptsInOrder(paths) {
  return new Promise(function (resolve, reject) {
    paths.forEach(function (path, index) {
      var script = document.createElement("script");
      script.src = path;
      script.async = false;
      script.onerror = function () {
        reject(new Error("Could not load " + path));
      };
      if (index === paths.length - 1) script.onload = resolve;
      document.body.appendChild(script);
    });
  });
}

Promise.all(viewFiles.map(loadTextFile)).then(function (views) {
  document.getElementById("appViews").innerHTML = views.join("\n");
  return loadScriptsInOrder(appScripts);
}).catch(function (error) {
  var message = document.getElementById("message");
  message.textContent = error.message + ". Start the app through a local web server.";
  message.style.display = "block";
  console.error(error);
});
