// Landing page: "Access Queue With Microsoft Account" opens a small Sign In card; its button starts the
// Microsoft sign-in (login() in auth.js).
function openSignInCard() {
  document.getElementById("lpSignInBackdrop").hidden = false;
  document.getElementById("lpSignIn").hidden = false;
  document.getElementById("lpSignInBtn").focus();
}

function closeSignInCard() {
  var card = document.getElementById("lpSignIn");
  if (!card || card.hidden) return;

  card.hidden = true;
  document.getElementById("lpSignInBackdrop").hidden = true;
}

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeSignInCard();
});
