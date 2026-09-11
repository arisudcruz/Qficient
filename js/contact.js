document.querySelector("#pageHome form").addEventListener("submit", function (event) {
  event.preventDefault();
  say("Thanks for your comments.");
  event.target.reset();
});
