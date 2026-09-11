function toggleTheme() {
  var isDark = document.body.classList.toggle("dark");
  document.getElementById("themeToggle").textContent = isDark ? "☀️" : "🌙";
}

if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.body.classList.add("dark");
  document.getElementById("themeToggle").textContent = "☀️";
}

function say(text) {
  var box = document.getElementById("message");
  box.textContent = text;
  box.style.display = "block";
  setTimeout(function () {
    box.style.display = "none";
  }, 3500);
}
