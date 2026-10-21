// Google's search suggestions, set as given: see grounding.html.
if (self.origin === 'null') {
  addEventListener('message', (e) => {
    if (e.source !== parent || e.origin !== location.origin || typeof e.data?.html !== 'string') return;
    document.body.innerHTML = e.data.html;
    parent.postMessage({ height: document.documentElement.scrollHeight }, '*');
  });
}
