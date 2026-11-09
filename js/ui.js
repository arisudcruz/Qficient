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

/* ---------- Password fields: an eye button that shows or hides what was typed ---------- */

var PW_EYE_SVG = '<svg class="pw-eye-show" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>' +
  '<svg class="pw-eye-hide" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c6.4 0 10 8 10 8a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';

// Wraps an <input type="password"> (as HTML) with the eye button.
function passwordFieldHtml(inputHtml) {
  return '<div class="pw-field">' + inputHtml +
    '<button type="button" class="pw-eye" aria-label="Show password" aria-pressed="false" title="Show password" onclick="togglePasswordVisibility(this)">' +
      PW_EYE_SVG + '</button></div>';
}

function togglePasswordVisibility(button) {
  var input = button && button.parentNode.querySelector("input");
  if (!input) return;
  setPasswordVisible(input, input.type === "password");
  input.focus();
  var end = input.value.length;
  try { input.setSelectionRange(end, end); } catch (e) {}
}

function setPasswordVisible(input, visible) {
  input.type = visible ? "text" : "password";
  var button = input.parentNode.querySelector(".pw-eye");
  if (!button) return;
  var label = visible ? "Hide password" : "Show password";
  button.classList.toggle("is-visible", visible);
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.title = label;
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
