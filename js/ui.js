var THEME_KEY = "qficient.theme";

function applyTheme(isDark) {
  document.body.classList.toggle("dark", isDark);
  var toggle = document.getElementById("themeToggle");
  if (toggle) toggle.textContent = isDark ? "☀️" : "🌙";
}

function toggleTheme() {
  var isDark = !document.body.classList.contains("dark");
  applyTheme(isDark);
  try { localStorage.setItem(THEME_KEY, isDark ? "dark" : "light"); } catch (e) {}
}

// Dark mode stays on after a refresh, on this device.
(function () {
  var saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (saved === "dark") applyTheme(true);
})();

// Shows a spinner on a button while its work is in progress, and keeps it from being pressed twice.
function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = !!loading;
  button.classList.toggle("is-loading", !!loading);
  if (loading) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

// Swings a notification bell once ("something new arrived"). Can be played again as soon as it has finished.
function ringBell(bell) {
  if (!bell) return;
  bell.classList.remove("bell-ring");
  void bell.offsetWidth; // restart the animation if it is still playing
  bell.classList.add("bell-ring");
  bell.addEventListener("animationend", function done(event) {
    if (event.animationName !== "bell-ring") return;
    bell.classList.remove("bell-ring");
    bell.removeEventListener("animationend", done);
  });
}

// For failures whose wording say() can't recognise as one. icon: "error" (default) or "warning".
function sayProblem(title, text, icon) {
  if (typeof Swal === "undefined") return say(text);
  return Swal.fire({ icon: icon || "error", title: title, text: text, confirmButtonColor: "#1D2E5B" });
}

// A finished action ("Station created."): green check, "Done".
function sayDone(text) {
  if (typeof Swal === "undefined") return say(text);
  return Swal.fire({ icon: "success", title: "Done", text: text, confirmButtonColor: "#1D2E5B" });
}

// Anything that is not a success: a failure ("Could not...", "...failed", "...error") shows as an error, everything
// else ("The passwords do not match.", "No ticket is currently being served.") as a warning to check.
// Successes use sayDone(), so a problem can never show a green check.
function say(text) {
  if (typeof Swal !== "undefined") {
    var lowerText = String(text).toLowerCase();
    var isError = lowerText.indexOf("error") !== -1 ||
      lowerText.indexOf("could not") !== -1 ||
      lowerText.indexOf("failed") !== -1;

    return Swal.fire({
      icon: isError ? "error" : "warning",
      title: isError ? "Something went wrong" : "Please check",
      text: text,
      confirmButtonColor: "#1D2E5B"
    });
  }

  var box = document.getElementById("message");
  box.textContent = text;
  box.style.display = "block";
  setTimeout(function () {
    box.style.display = "none";
  }, 3500);
  return Promise.resolve();
}
