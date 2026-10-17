fetch('/nodus/copy.json').then(response => {
  if (!response.ok) throw new Error('Copy unavailable');
  return response.json();
}).then(copy => {
  for (const element of document.querySelectorAll('[data-copy]')) {
    const value = copy[element.dataset.copy];
    if (typeof value === 'string') element.textContent = value;
  }
}).catch(() => { /* The HTML includes readable defaults when offline. */ });
