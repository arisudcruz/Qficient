function login() {
  var provider = new firebase.auth.OAuthProvider("microsoft.com");
  provider.setCustomParameters({
    prompt: "select_account",
    tenant: "3663e35d-c7bc-4b90-90e0-a67a1d53bb77"
  });

  firebase.auth().signInWithPopup(provider)
    .then(function (result) {
      var signedInUser = result.user;
      var name = signedInUser.displayName || signedInUser.email;

      user = {
        type: "student",
        id: signedInUser.uid,
        name: name,
        email: signedInUser.email
      };

      document.getElementById("welcomeText").textContent = "Welcome, " + name;
      updateDashboard();
      goTo("pageDashboard");
    })
    .catch(function (error) {
      say("Microsoft sign-in failed: " + error.message);
    });
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
