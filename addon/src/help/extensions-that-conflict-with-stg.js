
import './translate-help-pages.js';

import * as Constants from '/js/constants.js';

const $ = window.document.querySelector.bind(window.document);

function createExtensionBlock(ext) {
    let block = document.createElement('div');

    block.classList.add('block-content');

    let img = document.createElement('img');
    // img.addEventListener('error', () => img.remove())
    // img.src = Management.getExtensionIcon(ext); // can't have permission to read other addon icon :((
    img.src = '/icons/extension-generic.svg';

    let text = document.createElement('span');
    text.innerText = ext.name;

    block.appendChild(img);
    block.appendChild(text);

    return block;
}

async function showConflictedExtensions() {
    let addons = await browser.management.getAll(),
        conflictedExtensions = addons.filter(addon => Constants.CONFLICTED_EXTENSIONS.includes(addon.id)),
        $enabledExt = $('#enabled-conflicted-extensions'),
        $disabledExt = $('#disabled-conflicted-extensions');

    if (!conflictedExtensions.some(ext => ext.enabled)) {
        let {id} = await browser.tabs.getCurrent();

        browser.tabs.remove(id);
        return;
    }

    $enabledExt.textContent = $disabledExt.textContent = '';

    conflictedExtensions.forEach(ext => {
        if (ext.enabled) {
            $enabledExt.appendChild(createExtensionBlock(ext));
        } else {
            $disabledExt.appendChild(createExtensionBlock(ext));
        }
    });
}

function init() {
    browser.management.onEnabled.addListener(showConflictedExtensions);
    browser.management.onDisabled.addListener(showConflictedExtensions);
    browser.management.onInstalled.addListener(showConflictedExtensions);
    browser.management.onUninstalled.addListener(showConflictedExtensions);

    showConflictedExtensions();

    window.addEventListener('unload', function() {
        browser.management.onEnabled.removeListener(showConflictedExtensions);
        browser.management.onDisabled.removeListener(showConflictedExtensions);
        browser.management.onInstalled.removeListener(showConflictedExtensions);
        browser.management.onUninstalled.removeListener(showConflictedExtensions);
    });
}

init();
