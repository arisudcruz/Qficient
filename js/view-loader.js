var viewFiles = [
  "views/home.html",
  "views/login.html",
  "views/guest.html",
  "views/dashboard.html",
  "views/admin.html"
];

var appScripts = [
  "js/ui.js",
  "js/navigation.js",
  "js/auth.js",
  "js/queue.js",
  "js/student-dashboard.js",
  "js/admin-console.js",
  "js/contact.js",
  "js/firebase.js"
];

function loadTextFile(path) {
  return fetch(path).then(function (response) {
    if (!response.ok) {
      throw new Error("Could not load " + path);
    }
    return response.text();
  });
}

function loadScript(path) {
  return new Promise(function (resolve, reject) {
    var script = document.createElement("script");
    script.src = path;
    script.onload = resolve;
    script.onerror = function () {
      reject(new Error("Could not load " + path));
    };
    document.body.appendChild(script);
  });
}

Promise.all(viewFiles.map(loadTextFile)).then(function (views) {
  document.getElementById("appViews").innerHTML = views.join("\n");
  return appScripts.reduce(function (chain, scriptPath) {
    return chain.then(function () {
      return loadScript(scriptPath);
    });
  }, Promise.resolve());
}).catch(function (error) {
  var message = document.getElementById("message");
  message.textContent = error.message + ". Start the app through a local web server.";
  message.style.display = "block";
  console.error(error);
});
