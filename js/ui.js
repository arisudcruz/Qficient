function toggleTheme() {
  var isDark = document.body.classList.toggle("dark");
  document.getElementById("themeToggle").textContent = isDark ? "☀️" : "🌙";
}

// Shows a spinner on a button while its work is in progress, and keeps it from being pressed twice.
function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = !!loading;
  button.classList.toggle("is-loading", !!loading);
  if (loading) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function say(text) {
  if (typeof Swal !== "undefined") {
    var lowerText = text.toLowerCase();
    var isError = lowerText.indexOf("error") !== -1 ||
      lowerText.indexOf("could not") !== -1 ||
      lowerText.indexOf("failed") !== -1;
    var isWarning = lowerText.indexOf("please") !== -1 ||
      lowerText.indexOf("already") !== -1;

    return Swal.fire({
      icon: isError ? "error" : (isWarning ? "warning" : "success"),
      title: isError ? "Something went wrong" : (isWarning ? "Please check" : "Done"),
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
