function toggleTheme() {
  var isDark = document.body.classList.toggle("dark");
  document.getElementById("themeToggle").textContent = isDark ? "☀️" : "🌙";
}

if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.body.classList.add("dark");
  document.getElementById("themeToggle").textContent = "☀️";
}

function say(text) {
  if (typeof Swal !== "undefined") {
    var lowerText = text.toLowerCase();
    var isError = lowerText.indexOf("error") !== -1 ||
      lowerText.indexOf("could not") !== -1 ||
      lowerText.indexOf("failed") !== -1;
    var isWarning = lowerText.indexOf("please") !== -1 ||
      lowerText.indexOf("already") !== -1;

    Swal.fire({
      icon: isError ? "error" : (isWarning ? "warning" : "success"),
      title: isError ? "Something went wrong" : (isWarning ? "Please check" : "Done"),
      text: text,
      confirmButtonColor: "#1D2E5B"
    });
    return;
  }

  var box = document.getElementById("message");
  box.textContent = text;
  box.style.display = "block";
  setTimeout(function () {
    box.style.display = "none";
  }, 3500);
}
