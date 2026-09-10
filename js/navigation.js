function goTo(pageId) {
  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.remove("show");
  }
  document.getElementById(pageId).classList.add("show");
}
