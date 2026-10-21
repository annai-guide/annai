// The frame Google's search suggestions are drawn in (the Gemini design, "Google Search, built in"): Google's terms ask
// them shown as Google gave them, and they are Google's HTML. The frame is sandboxed without allow-same-origin, so
// nothing in it can reach annai, and its own security policy (_headers) runs only this script and inline styles. Its
// parent sends the HTML; it says how tall it is. A suggestion opens Google in a new tab (its <base target>).
addEventListener('message', (e) => {
  if (e.source !== parent || typeof e.data?.html !== 'string') return;
  document.body.innerHTML = e.data.html;
  parent.postMessage({ height: document.documentElement.scrollHeight }, '*');
});
