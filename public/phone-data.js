
window.addEventListener('load', () => {
  init();
});

async function init() {
  try {
    const response = await fetch('/get-phone-data');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    document.querySelector('.master').innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
  } catch (error) {
    console.error('Failed to fetch map data:', error);
  }
}

