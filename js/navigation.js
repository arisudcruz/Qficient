function goTo(pageId) {
  if ((pageId === "pageAdmin" || pageId === "pageTvBoard") && !isAdminSignedIn()) {
    pageId = "pageAdminLogin";
  }

  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.remove("show");
  }
  document.getElementById(pageId).classList.add("show");
  document.body.setAttribute("data-page", pageId);
  if (pageId !== "pageHome" && typeof closeSignInCard === "function") closeSignInCard();
  if (typeof startTvBoard === "function") {
    if (pageId === "pageTvBoard") startTvBoard();
    else stopTvBoard();
  }
  if (typeof routerAfterGoTo === "function") routerAfterGoTo(pageId);
}

document.addEventListener("keydown", function (event) {
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    goTo("pageAdmin");
  }
});
