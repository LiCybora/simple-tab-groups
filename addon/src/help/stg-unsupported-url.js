
import '/js/lang.js?translate-page';

const $ = document.querySelector.bind(document);
const params = new URLSearchParams(self.location.search);
const UNSUPPORTED_URL = params.get('url');

if (UNSUPPORTED_URL) {
    $('#unsupportedUrlBlock').innerText = document.title = UNSUPPORTED_URL;
    $('#copyButton').addEventListener('click', copyUrl);
    $('#closeTab').addEventListener('click', closeTab);
} else {
    closeTab();
}

async function copyUrl() {
    await navigator.clipboard.writeText(UNSUPPORTED_URL);
}

async function closeTab() {
    const tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
}
