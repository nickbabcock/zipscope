// This script runs before the first paint, in the head of the page. It sets the
// state of the door for `door.css`: a reload of a tab with an archive, a new
// tab of a handoff and a window of a file launch do not show the questions. It
// stops the browser from navigating to a dropped file, and keeps the first file
// for the app, until the app takes the drop. It also shows one line when the
// entry module cannot run.
(function () {
  var root = document.documentElement;
  var state = history.state;
  if (
    location.hash.indexOf("#handoff=") === 0 ||
    location.search === "?launch" ||
    (state && state.zipscope === 1 && state.session && state.name)
  ) {
    root.dataset.door = "resume";
  }
  var kept;
  function guard(event) {
    event.preventDefault();
    var data = event.dataTransfer;
    if (event.type !== "drop" || kept || !data || !data.files[0]) return;
    var item = [].find.call(data.items, function (next) {
      return next.kind === "file";
    });
    kept = {
      file: data.files[0],
      handle: item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null,
    };
  }
  // The entry module marks the root. With no mark at the load of the window it
  // did not run, so the page must say why nothing works.
  addEventListener("load", function () {
    var line = document.getElementById("door-failed");
    if (line && !root.dataset.entry) line.hidden = false;
  });
  addEventListener("dragover", guard);
  addEventListener("drop", guard);
  window.zipscopeTakeDrop = function () {
    removeEventListener("dragover", guard);
    removeEventListener("drop", guard);
    delete window.zipscopeTakeDrop;
    var taken = kept;
    kept = undefined;
    return taken;
  };
})();
