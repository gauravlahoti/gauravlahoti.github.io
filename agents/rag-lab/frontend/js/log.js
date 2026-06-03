const scroll = document.getElementById("log-scroll");
const MAX_LINES = 300;

export function log(text, cls = "") {
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = `[${timestamp()}] ${text}`;
  scroll.appendChild(line);
  // Trim
  while (scroll.children.length > MAX_LINES) {
    scroll.removeChild(scroll.firstChild);
  }
  scroll.scrollTop = scroll.scrollHeight;
}

export function clearLog() {
  scroll.innerHTML = "";
}

function timestamp() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
