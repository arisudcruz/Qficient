function goTo(pageId) {
  if (pageId === "pageAdmin" && !isAdminSignedIn()) {
    pageId = "pageAdminLogin";
  }

  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.remove("show");
  }
  document.getElementById(pageId).classList.add("show");
  document.body.setAttribute("data-page", pageId);
}

document.addEventListener("keydown", function (event) {
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    goTo("pageAdmin");
  }
});
