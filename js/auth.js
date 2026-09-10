function login() {
  var email = document.getElementById("loginEmail").value;

  if (email.indexOf("@") === -1) {
    say("Please enter a valid email.");
    return;
  }

  var namePart = email.split("@")[0];
  var niceName = namePart.replace(".", " ");
  niceName = niceName.charAt(0).toUpperCase() + niceName.slice(1);

  user = { type: "student", id: email, name: niceName };

  document.getElementById("welcomeText").textContent = "Welcome, " + niceName;
  updateDashboard();
  goTo("pageDashboard");
}

function guestLogin() {
  var name = document.getElementById("guestName").value;
  var mobile = document.getElementById("guestMobile").value;
  var purpose = document.getElementById("guestPurpose").value;

  if (!name || !mobile || !purpose) {
    say("Please fill in all fields.");
    return;
  }

  user = { type: "guest", id: "guest-" + Date.now(), name: name };

  document.getElementById("welcomeText").textContent = "Welcome, " + name;
  joinQueue("admission");
  updateDashboard();
  goTo("pageDashboard");
}
