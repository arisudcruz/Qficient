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

var guestPhoneConfirmation = null;

function normalizeGuestPhone(rawPhone) {
  var digits = (rawPhone || "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("0")) {
    digits = "63" + digits.substring(1);
  }

  return "+" + digits;
}

function requestGuestOtp() {
  var name = document.getElementById("guestName").value.trim();
  var mobile = document.getElementById("guestMobile").value.trim();
  var purpose = document.getElementById("guestPurpose").value.trim();

  if (!name || !mobile || !purpose) {
    say("Please fill in all fields.");
    return;
  }

  var phone = normalizeGuestPhone(mobile);

  if (!/^\+\d{10,15}$/.test(phone)) {
    say("Please enter a valid mobile number.");
    return;
  }

  if (!window.guestRecaptchaVerifier) {
    window.guestRecaptchaVerifier = new firebase.auth.RecaptchaVerifier("guestRecaptcha", {
      size: "invisible",
      callback: function () {
        console.log("reCAPTCHA solved.");
      },
      "expired-callback": function () {
        say("SMS verification timed out. Please try again.");
      }
    });
  }

  firebase.auth().signInWithPhoneNumber(phone, window.guestRecaptchaVerifier)
    .then(function (confirmationResult) {
      guestPhoneConfirmation = confirmationResult;
      document.getElementById("guestOtpSection").style.display = "block";
      say("Verification code sent to your mobile number.");
    })
    .catch(function (error) {
      console.error(error);
      say("Could not send SMS: " + error.message);
    });
}

function verifyGuestOtp() {
  var otp = document.getElementById("guestOtp").value.trim();

  if (!otp) {
    say("Please enter the SMS verification code.");
    return;
  }

  if (!guestPhoneConfirmation) {
    say("Please request the SMS code first.");
    return;
  }

  guestPhoneConfirmation.confirm(otp)
    .then(function () {
      var name = document.getElementById("guestName").value.trim();
      var mobile = document.getElementById("guestMobile").value.trim();
      var purpose = document.getElementById("guestPurpose").value.trim();

      user = {
        type: "guest",
        id: "guest-" + Date.now(),
        name: name,
        mobile: mobile,
        purpose: purpose
      };

      document.getElementById("welcomeText").textContent = "Welcome, " + name;
      joinQueue("admission", purpose);
      updateDashboard();
      goTo("pageDashboard");
    })
    .catch(function (error) {
      say("Invalid or expired SMS code: " + error.message);
    });
}

function guestLogin() {
  say("Please request and verify the SMS code before joining the queue.");
}
