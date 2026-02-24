
import Listeners from '/js/listeners.js\
?tabs.onActivated\
&tabs.onCreated\
&tabs.onUpdated=[{"properties":["title","status","favIconUrl","hidden","pinned","discarded","audible"]}]\
&tabs.onRemoved\
&tabs.onMoved\
&tabs.onDetached\
&tabs.onAttached\
&storage.local.onChanged\
';
import './prefixed-storage.js';
import Logger from './logger.js';
import backgroundSelf from './background.js';
import Notification from './notification.js';
import BatchProcessor from './batch-processor.js';
import * as Broadcast from './broadcast.js';
import * as TabsBroadcast from './broadcast.js?channel=tabs';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import * as Extensions from './extensions.js';
import * as Groups from './groups.js';
import * as Windows from './windows.js';
import * as ConstantsBrowser from './constants-browser.js';
import * as Storage from './storage.js';

const logger = new Logger('Tabs');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const options = await Storage.get(['showTabsWithThumbnailsInManageGroups', 'colorScheme']);

export function addListeners(options) {
    Listeners.tabs.onActivated.add(onActivated, options);
    Listeners.tabs.onCreated.add(onCreated, options);
    Listeners.tabs.onUpdated.add(onUpdated, options);
    Listeners.tabs.onRemoved.add(onRemoved, options);
    Listeners.tabs.onMoved.add(onMoved, options);
    Listeners.tabs.onDetached.add(onDetached, options);
    Listeners.tabs.onAttached.add(onAttached, options);
    Listeners.storage.local.onChanged.add(onStorageChanged, options);
}

export function removeEvents() {
    Listeners.tabs.onActivated.remove(onActivated);
    Listeners.tabs.onCreated.remove(onCreated);
    Listeners.tabs.onUpdated.remove(onUpdated);
    Listeners.tabs.onRemoved.remove(onRemoved);
    Listeners.tabs.onMoved.remove(onMoved);
    Listeners.tabs.onDetached.remove(onDetached);
    Listeners.tabs.onAttached.remove(onAttached);
    Listeners.storage.local.onChanged.remove(onStorageChanged);
}

// listeners
export const {on, off} = TabsBroadcast;

function send(action, data) {
    TabsBroadcast.send({action, ...data}, {
        includeSelf: false,
    });
}

function onActivated({tabId, windowId, previousTabId = null}) {
    if (
        skip.tracking.has(tabId) ||
        skip.tracking.has(previousTabId) ||
        skip.removed.has(tabId) ||
        skip.removed.has(previousTabId)
    ) {
        return;
    }

    logger.log('onActivated', {tabId, windowId, previousTabId})

    send('updated', {
        tabId: tabId,
        changeInfo: {active: true},
    });

    if (previousTabId) {
        send('updated', {
            tabId: previousTabId,
            changeInfo: {active: false},
        });
    }
}

const updatedBatch = new BatchProcessor(async (groupId) => {
    logger.log('updatedBatch', groupId);

    if (groupId === 'unsync') {
        const windows = await Windows.load(true, true, options.showTabsWithThumbnailsInManageGroups);
        send('updated.all', {
            windows,
        });
    } else {
        const {group} = await Groups.load(groupId, true, true, options.showTabsWithThumbnailsInManageGroups);
        send('updated.group', {
            groupId,
            tabs: group.tabs,
        });
    }
});

const skip = {
    created: new Set(),
    tracking: new Set(),
    removed: new Set(),
};

export function skipTracking(tabs, accum = new Set) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.add(id);
        accum.add(id);
    }

    return accum;
}

export function continueTracking(tabs, accum = null) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.delete(id);
        accum?.delete(id);
    }
}

export function isSkippedTracking(tab) {
    return skip.tracking.has(extractId(tab));
}

export function clearSkipTracking() { // TODO remove/refactor
    return skip.tracking.clear();
}

async function onCreated(tab) {
    await Utils.wait(50);

    if (skip.created.has(tab.id)) {
        return;
    }

    delete tab.groupId; // TODO tmp

    logger.log('onCreated', tab);

    Cache.setTab(tab);

    if (isPinned(tab)) {
        logger.log('onCreated 🛑 skip pinned tab', tab.id);
        return;
    }

    await Cache.setTabGroup(tab.id, null, tab.windowId)
        .catch(logger.onCatch("onCreated can't set group", false));

    Cache.applyTabSession(tab);

    updatedBatch.add(tab.groupId || 'unsync', tab.id);
}

async function onUpdated(tabId, changeInfo, tab) {
    if (skip.removed.has(tab.id)) {
        return;
    }

    if (skip.tracking.has(tab.id)) {
        Cache.setTab(tab);
        return;
    }

    delete tab.groupId; // TODO tmp

    const log = logger.start('onUpdated', tabId, changeInfo);

    changeInfo = Cache.getRealTabStateChanged(tab);

    Cache.setTab(tab);

    if (!changeInfo) {
        log.stop('🛑 changeInfo keys was not changed');
        return;
    }

    if (isPinned(tab) && !Object.hasOwn(changeInfo, 'pinned')) {
        log.stop('🛑 tab is pinned');
        return;
    }

    if (changeInfo.favIconUrl) {
        await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
            .catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
    }

    if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
        if (changeInfo.pinned || changeInfo.hidden) {
            changeInfo.pinned && log.log('remove group for pinned tab', tab.id);
            changeInfo.hidden && log.log('remove group for hidden tab', tab.id);

            await Cache.removeTabGroup(tab.id).catch(() => {});
        } else if (changeInfo.pinned === false) {
            log.log('tab is unpinned', tab.id);

            await Cache.setTabGroup(tab.id, null, tab.windowId)
                .catch(log.onCatch(["can't set group to tab, !pinned", tab.id], false));
        } else if (changeInfo.hidden === false) {
            log.log('tab is showing', tab.id);

            Cache.applyTabSession(tab);

            if (tab.groupId) {
                log.log('call applyGroup for tab', tab.id, 'groupId', tab.groupId);
                await self.applyGroup(tab.windowId, tab.groupId, tab.id) // TODO
                    .catch(log.onCatch(["can't applyGroup", tab.groupId], false));
            } else {
                log.log('call setTabGroup for tab', tab.id);
                await Cache.setTabGroup(tab.id, null, tab.windowId)
                    .catch(log.onCatch(["can't set group to tab, !hidden", tab.id], false));
            }
        }

        log.stop();
        return;
    }

    send('updated', {
        tabId: tab.id,
        changeInfo,
    });

    if (options.showTabsWithThumbnailsInManageGroups && isLoaded(changeInfo)) {
        await updateThumbnail(tab.id);
    }

    log.stop();
}

function onRemoved(tabId, {isWindowClosing, windowId}) {
    const silent = skip.removed.has(tabId);

    skip.removed.add(tabId); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758

    const groupId = Cache.getTabGroup(tabId);

    updatedBatch.delete(groupId || 'unsync', tabId);

    if (silent) {
        Cache.removeTab(tabId);
        return;
    }

    logger.log('onRemoved', tabId, {isWindowClosing, windowId, groupId});

    if (isWindowClosing) {
        Broadcast.send({
            action: 'add-restore-tab-on-removed-window',
            tabId,
        });
    } else {
        Cache.removeTab(tabId);
        if (groupId) {
            send('removed', {
                tabId,
                groupId,
            });
        } else {
            send('removed.unsync', {
                tabId,
            });
        }
    }
}

function onMoved(tabId) {
    if (
        skip.tracking.has(tabId) ||
        skip.removed.has(tabId)
    ) {
        return;
    }

    const groupId = Cache.getTabGroup(tabId);

    logger.log('onMoved', {tabId, groupId});

    updatedBatch.add(groupId || 'unsync', tabId);

    /*
    if (Cache.getTabGroup(tabId)) {
        clearTimeout(openerTabTimer);
        openerTabTimer = setTimeout(() => Tabs.get().catch(() => {}), 500); // load visible tabs of current window for set openerTabId
    } */
}

async function onDetached(tabId, {oldWindowId}) { // notice: called before onAttached
    if (
        skip.tracking.has(tabId) ||
        skip.removed.has(tabId)
    ) {
        return;
    }

    const groupId = Cache.getWindowGroup(oldWindowId);

    logger.log('onDetached', {tabId, oldWindowId, groupId});

    updatedBatch.add(groupId || 'unsync', tabId);
}

async function onAttached(tabId, {newWindowId}) { // called when tabs.move()
    if (
        skip.tracking.has(tabId) ||
        skip.removed.has(tabId)
    ) {
        return;
    }

    const log = logger.start('onAttached', {tabId, newWindowId});

    await Cache.setTabGroup(tabId, null, newWindowId)
        .catch(log.onCatch("can't set group"));

    const groupId = Cache.getTabGroup(tabId);

    log.log('attached tab groupId', groupId);

    updatedBatch.add(groupId || 'unsync', tabId);

    log.stop();
}

function onStorageChanged(changes) {
    if (Storage.isChangedBooleanKey('showTabsWithThumbnailsInManageGroups', changes)) {
        options.showTabsWithThumbnailsInManageGroups = changes.showTabsWithThumbnailsInManageGroups.newValue;
    }
    if (Storage.isChangedStringKey('colorScheme', changes)) {
        options.colorScheme = changes.colorScheme.newValue;
    }
}

// methods
export async function create({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, favIconUrl, thumbnail}, skipCreated = false) {
    if (!Constants.IS_BACKGROUND_PAGE) {
        throw Error('is not background');
    }

    const tab = {};

    if (url) {
        if (Utils.isUrlAllowToCreate(url)) {
            if (url.startsWith('moz-extension')) {
                const uuid = Extensions.extractUUID(url);

                if (Utils.isUUID(uuid)) {
                    tab.url = url;
                } else {
                    tab.url = Constants.PAGES.HELP.UNSUPPORTED_URL + '#' + url;
                }
            } else {
                tab.url = url;
            }
        } else if (url !== 'about:newtab') {
            tab.url = Constants.PAGES.HELP.UNSUPPORTED_URL + '#' + url;
        }
    }

    tab.active = !!active;

    if (pinned) {
        tab.pinned = true;
    }

    if (!tab.active && !tab.pinned && tab.url && !tab.url.startsWith('about:')) {
        tab.discarded = true;
    }

    if (tab.discarded && title) {
        tab.title = title;
    }

    if (Number.isSafeInteger(index) && index >= 0) {
        tab.index = index;
    }

    windowId = Cache.getWindowId(groupId) || windowId;

    if (Number.isSafeInteger(windowId) && windowId >= 1) {
        tab.windowId = windowId;
    }

    if (Number.isSafeInteger(openerTabId) && openerTabId >= 1) {
        tab.openerTabId = openerTabId;
    }

    tab.cookieStoreId = cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;

    tab.cookieStoreId = getNewTabContainer(tab, {newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen});

    if (tab.cookieStoreId === Constants.TEMPORARY_CONTAINER) {
        tab.cookieStoreId = (await Containers.createTemporary()).cookieStoreId;
    } else {
        tab.cookieStoreId = Containers.get(tab.cookieStoreId).cookieStoreId;
    }

    const newTab = await browser.tabs.create(tab);

    if (skipCreated === true) {
        skip.created.add(newTab.id);
    }

    delete newTab.groupId; // TODO temp

    await Cache.setTabSession(newTab, {groupId, favIconUrl, thumbnail});

    logger.log('create', newTab);

    return newTab;
}

export async function createMultiple(tabs, tryRestoreOpeners = false, hideTabs = true) {
    const log = logger.start('createMultiple', {tryRestoreOpeners, hideTabs}, tabs.map(tab => Utils.extractKeys(tab, [
        'id',
        'cookieStoreId',
        'openerTabId',
        'groupId',
    ])));

    if (!tabs.length) {
        log.stop('no tabs');
        return [];
    }

    const oldNewTabIds = {};

    let newTabs = [];

    for (const tab of tabs) {
        delete tab.active;
        delete tab.index;
        delete tab.windowId;
    }

    if (tryRestoreOpeners && Extensions.hasTreeTabs() && tabs.some(tab => tab.openerTabId)) {
        log.log('tryRestoreOpeners');
        for (const tab of tabs) {
            if (tab.id && tab.openerTabId) {
                tab.openerTabId = oldNewTabIds[tab.openerTabId];
            }

            const newTab = await create(tab, true);

            if (tab.id) {
                oldNewTabIds[tab.id] = newTab.id;
            }

            newTabs.push(newTab);
        }
    } else {
        log.log('creating tabs');
        tabs.forEach(tab => delete tab.openerTabId);
        newTabs = await Promise.all(tabs.map(tab => create(tab, true)));
    }

    newTabs = await moveNative(newTabs, {
        index: -1,
    });

    if (hideTabs) {
        const tabsToHide = newTabs.filter(tab => !tab.pinned && tab.groupId && !Cache.getWindowId(tab.groupId));

        log.log('hide tabs length:', tabsToHide.length);

        await hide(tabsToHide, true);
    }

    log.stop();

    return newTabs;
}

export async function createUrlOnce(url) {
    let [tab] = await browser.tabs.query({
        url: url.includes('#') ? url.slice(0, url.indexOf('#')) : url,
        hidden: false,
    });

    if (tab) {
        const updateProperties = {
            active: true,
        };

        if (tab.url !== url) {
            updateProperties.url = url;
        }

        [tab] = await tabsAction({action: 'update'}, tab, updateProperties);
    }

    tab ??= await browser.tabs.create({
        url,
        active: true,
    });

    return tab;
}

export async function setActive(tabId = null, tabs = []) {
    const log = logger.start('setActive', tabId, 'from tabs:', tabs.map(extractId));

    let tabToActive = null;

    if (tabId) {
        tabToActive = tabs.find(tab => tab.id === tabId) || {
            id: tabId,
        };
    } else if (tabs.length) { // find lastAccessed tab
        let maxLastAccessed = Math.max(...tabs.map(tab => tab.lastAccessed));

        tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
    }

    if (tabToActive) {
        tabs.forEach(tab => tab.active = tab.id === tabToActive.id);

        await browser.tabs.update(tabToActive.id, {
            active: true,
        }).catch(log.onCatch(tabToActive.id));
    }

    log.stop();
    return tabToActive;
}

export async function getActive(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const [activeTab] = await get(windowId, null, null, {
        active: true,
    });

    return activeTab;
}

export async function getHighlightedIds(windowId = browser.windows.WINDOW_ID_CURRENT, clickedTab = null, pinned = false) {
    let tabs = await get(windowId, pinned, false, {
        highlighted: true,
    });

    if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) { // if clicked tab not in selected tabs - add it
        tabs.push(clickedTab);

        if (2 === tabs.length) {
            tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true); // exclude active tab if need to move another tab
        }
    }

    return tabs.map(extractId);
}

export async function get(
        windowId = browser.windows.WINDOW_ID_CURRENT,
        pinned = false,
        hidden = false,
        otherProps = {},
        includeFavIconUrl = false,
        includeThumbnail = false
    ) {
    const query = {
        windowId,
        pinned,
        hidden,
        windowType: browser.windows.WindowType.NORMAL,
        ...otherProps,
    };

    for (const key in query) {
        if (query[key] == null) {
            delete query[key];
        }
    }

    const log = logger.start('get', query);

    let tabs = await browser.tabs.query(query);

    tabs = tabs.filter(tab => !skip.removed.has(tab.id)); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758

    tabs.forEach(tab => delete tab.groupId); // TODO temp

    if (!query.pinned) {
        tabs = await Promise.all(
            tabs.map(tab => Cache.loadTabSession(normalizeUrl(tab), includeFavIconUrl, includeThumbnail))
        );
    }

    tabs = tabs.filter(Boolean);

    log.stop('found tabs count:', tabs.length);
    return tabs;
}

export async function getOne(tabId) {
    try {
        if (skip.removed.has(tabId)) { // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
            return null;
        }

        const tab = await browser.tabs.get(tabId);
        delete tab.groupId; // TODO temp
        return normalizeUrl(tab);
    } catch {
        return null;
    }
}

export async function getList(tabIds, includeFavIconUrl, includeThumbnail) {
    const tabs = await Promise.all(tabIds.map(tabId => {
        return getOne(tabId).then(tab => Cache.loadTabSession(tab, includeFavIconUrl, includeThumbnail));
    }));

    return tabs.filter(Boolean);
}

export async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const log = logger.start('createTempActiveTab', {windowId, createPinnedTab, newTabUrl});

    let pinnedTabs = await get(windowId, true, null);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(Utils.getLastActiveTab(pinnedTabs).id);
            log.stop('setActive pinned');
        } else log.stop('pinned is active');
    } else {
        const tempTab = await create({
            url: createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab'),
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        }, true);
        log.stop('created temp tab', tempTab);
        return tempTab;
    }
}

export async function add(groupId, cookieStoreId, url, title) {
    const log = logger.start('add', {groupId, cookieStoreId, url, title});

    const windowId = Cache.getWindowId(groupId);

    let {group} = await Groups.load(groupId, !windowId);

    const tab = await create({
        url,
        title,
        cookieStoreId,
        index: windowId ? null : group.tabs.pop()?.index + 1,
        // windowId, // windowId will get from Cache.getWindowId into create function
        ...Groups.getNewTabParams(group),
    }, true);

    if (!windowId) {
        await hide(tab, true);
    }

    ({group} = await Groups.load(groupId, true, true, options.showTabsWithThumbnailsInManageGroups));
    send('updated.group', {
        groupId,
        tabs: group.tabs,
    });

    log.stop(tab);
    return tab;
}

export async function updateThumbnail(tabId) {
    const log = logger.start('updateThumbnail', {tabId});

    const tab = await getOne(tabId);

    if (!tab) {
        log.stop('!tab');
        return;
    }

    if (!isLoaded(tab)) {
        log.stop('tab is loading');
        return;
    }

    if (tab.discarded) {
        reload(tab.id);
        log.stop('tab is discarded, reloading');
        return;
    }

    try {
        const thumbnailBase64 = await browser.tabs.captureTab(tab.id, {
            format: browser.extensionTypes.ImageFormat.JPEG,
            quality: 25,
        });

        const thumbnail = await new Promise((resolve, reject) => {
            const img = new Image();

            img.onload = () => {
                resolve(Utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false, 'image/jpeg', 0.7));
            };

            img.onerror = img.onabort = reject;

            img.src = thumbnailBase64;
        });

        await Cache.setTabThumbnail(tab.id, thumbnail);

        send('updated', {
            tabId: tab.id,
            changeInfo: {thumbnail},
        });

        log.stop('success');
    } catch (e) {
        log.stopWarn('cant create thumbnail', e);
    }
}

export async function move(tabIds, groupId, params = {}) {
    const log = logger.start('move', {tabIds, groupId, params});

    let tabs = await getList(tabIds.slice());

    if (tabs.length) {
        tabIds = tabs.map(extractId);
    } else {
        log.stop('tabs are empty');
        return [];
    }

    const skippedTabs = skipTracking(tabIds);

    const tabsCantHide = new Set;
    const groupWindowId = Cache.getWindowId(groupId);
    const {group} = await Groups.load(groupId, !groupWindowId);
    const windowId = groupWindowId || (group.tabs[0]?.windowId) || await Windows.getLastFocusedNormalWindow();
    const activeTabs = [];

    log.log('vars', {groupWindowId, windowId});
    log.log('filter active');

    params.showTabAfterMovingItIntoThisGroup ??= group.showTabAfterMovingItIntoThisGroup;
    params.showOnlyActiveTabAfterMovingItIntoThisGroup ??= group.showOnlyActiveTabAfterMovingItIntoThisGroup;
    params.showNotificationAfterMovingTabIntoThisGroup ??= group.showNotificationAfterMovingTabIntoThisGroup;

    let showPinnedMessage = false;

    tabs = tabs.filter(function(tab) {
        if (tab.pinned) {
            showPinnedMessage = true;
            continueTracking([tab], skippedTabs);
            log.log('tab pinned', tab);
            return false;
        }

        if (isCanNotBeHidden(tab)) {
            tabsCantHide.add(getTitle(tab, false, 20));
            continueTracking([tab], skippedTabs);
            log.log('cant move tab', tab);
            return false;
        }

        if (tab.active && tab.groupId !== groupId) {
            activeTabs.push(tab);
        }

        return true;
    });

    log.log('active tabs', activeTabs, 'tabs to move COUNT:', tabs.length);

    if (tabs.length) {
        const excludeMovingTabs = tab => !tabs.some(t => t.id === tab.id);

        await Promise.all(activeTabs.map(async function(activeTab) {
            let allTabsInActiveTabWindow = await get(activeTab.windowId, null, null),
                tabsToActive = allTabsInActiveTabWindow.filter(tab => !tab.hidden && excludeMovingTabs(tab));

            if (tabsToActive.length) {
                log.log('set active some other');
                await setActive(undefined, tabsToActive);
            } else { // if not found other visible (include pinned) tabs in window
                let differentWindows = activeTab.windowId !== windowId,
                    otherHiddenAndVisibleTabsInActiveTabWindow = allTabsInActiveTabWindow.filter(excludeMovingTabs),
                    activeTabIsLastInSrcGroup = false,
                    activeTabIsInLoadedGroup = false,
                    activeTabNotInGroup = false;

                if (activeTab.groupId) {
                    activeTabIsLastInSrcGroup = !otherHiddenAndVisibleTabsInActiveTabWindow
                        .some(tab => tab.groupId === activeTab.groupId);

                    activeTabIsInLoadedGroup = activeTab.groupId === Cache.getWindowGroup(activeTab.windowId);
                } else {
                    activeTabNotInGroup = !Cache.getWindowGroup(activeTab.windowId);
                }

                log.log('create condition', {
                    differentWindows,
                    otherHiddenAndVisibleTabsInActiveTabWindow,
                    activeTabIsLastInSrcGroup,
                    activeTabIsInLoadedGroup,
                    activeTabNotInGroup,
                });

                if (
                    (differentWindows && !otherHiddenAndVisibleTabsInActiveTabWindow.length) ||
                    (activeTabIsLastInSrcGroup && activeTabIsInLoadedGroup) ||
                    (activeTabNotInGroup)
                ) {
                    log.log('create temp')
                    await createTempActiveTab(activeTab.windowId, false);
                }
            }
        }));
        activeTabs.length = 0; // reset active tabs

        let tabIdsToRemove = [],
            newTabParams = Groups.getNewTabParams(group);

        tabs = await Promise.all(tabs.map(async function(tab) {
            let newTabContainer = getNewTabContainer(tab, group);

            if (tab.cookieStoreId === newTabContainer) {
                if (tab.active) {
                    activeTabs.push(tab);
                }
                return tab;
            } else {
                tab.cookieStoreId = newTabContainer;
            }

            log.log('create new tab with newTabContainer', newTabContainer);

            tabIdsToRemove.push(tab.id);

            const newTab = await create({
                ...tab,
                ...Cache.getTabSession(tab.id), // apply session, because we can move tab from onBeforeTabRequest
                active: false,
                openerTabId: null,
                windowId,
                ...newTabParams,
            }, true);

            skipTracking([newTab], skippedTabs);

            if (tab.active) {
                activeTabs.push({...newTab, active: true});
            }

            return newTab;
        }));

        await remove(tabIdsToRemove, true);

        tabs = await moveNative(tabs, {
            index: params.newTabIndex ?? -1,
            windowId,
        });

        if (groupWindowId) {
            await show(tabs.filter(tab => tab.hidden));
        } else {
            await hide(tabs.filter(tab => !tab.hidden));
        }

        await Promise.all(tabs.map(tab => Cache.setTabGroup(tab.id, groupId)));

        backgroundSelf.sendMessageFromBackground('groups-updated'); // TODO

        log.log('end moving');
    }

    continueTracking(skippedTabs);

    if (showPinnedMessage) {
        log.log('notify pinnedTabsAreNotSupported');
        Notification('pinnedTabsAreNotSupported');
    }

    if (tabsCantHide.size) {
        log.log('notify thisTabsCanNotBeHidden');
        Notification(['thisTabsCanNotBeHidden', Array.from(tabsCantHide).join(', ')]);
    }

    if (!tabs.length) {
        log.stop('empty tabs');
        return [];
    }

    let [firstTab] = activeTabs.length ? activeTabs : tabs;

    if (params.showTabAfterMovingItIntoThisGroup) {
        if (params.showOnlyActiveTabAfterMovingItIntoThisGroup) {
            if (activeTabs.length) {
                log.log('applyGroup', windowId, groupId, firstTab.id)
                await backgroundSelf.applyGroup(windowId, groupId, firstTab.id);
                params.showNotificationAfterMovingTabIntoThisGroup = false;
            }
        } else {
            log.log('applyGroup 2', windowId, groupId, firstTab.id)
            await backgroundSelf.applyGroup(windowId, groupId, firstTab.id);
            params.showNotificationAfterMovingTabIntoThisGroup = false;
        }
    }

    if (!params.showNotificationAfterMovingTabIntoThisGroup) {
        log.stop(tabs, 'no notify');
        return tabs;
    }

    let message = [],
        iconUrl = null;

    if (tabs.length > 1) {
        message = ['moveMultipleTabsToGroupMessage', tabs.length];
        iconUrl = Groups.getIconUrl(group);
    } else {
        let tabTitle = getTitle(firstTab, false, 50);
        message = ['moveTabToGroupMessage', [group.title, tabTitle]];
        firstTab = normalizeFavIcon(firstTab);
        iconUrl = firstTab.favIconUrl;
    }

    Notification(message, {
        iconUrl,
        module: ['background', 'applyGroup', null, groupId, firstTab.id],
    });

    log.stop(tabs, 'with notify');
    return tabs;
}

async function filterExist(tabs, returnTabIds = false) {
    const tabIds = tabs.map(extractId);
    const log = logger.start('filterExist', tabIds, {returnTabIds});

    const lengthBefore = tabIds.length;
    const returnFunc = returnTabIds ? t => t.id : t => t;

    tabs = await Promise.all(tabs.map(tab => {
        return browser.tabs.get(extractId(tab))
            .then(returnFunc, log.onCatch(['not found tab', tab], false));
    }));
    tabs = tabs.filter(Boolean).filter(tab => !skip.removed.has(tab.id)); // BUG https://bugzilla.mozilla.org/show_bug.cgi?id=1396758
    tabs.forEach(tab => delete tab.groupId); // TODO temp

    log.assert(lengthBefore === tabs.length, 'tabs length after filter are not equal. not found tabs:',
        tabIds.filter(tabId => !tabs.some(tab => tab.id === tabId)));

    log.stop();
    return tabs;
}

export async function moveNative(tabs, moveProperties = {}) {
    let tabIds = tabs.map(extractId),
        openerTabIds = [];

    const log = logger.start('moveNative', {moveProperties}, tabIds);

    if (moveProperties.windowId) { // try fix bug when tab lose it's openerTabId after moving between windows
        tabs = await filterExist(tabIds);
        openerTabIds = tabs.map(tab => tab.openerTabId);
        tabIds = tabs.map(extractId);
    } else {
        tabIds = await filterExist(tabIds, true);
    }

    if (!tabIds.length) {
        log.stop('tabs are empty');
        return [];
    }

    let movedTabs = await browser.tabs.move(tabIds, moveProperties).catch(log.onCatch(['move', tabIds])),
        movedTabsObj = Utils.arrayToObj(movedTabs, 'id'),
        movedTabIdsSet = new Set(tabIds);

    log.stop(tabIds);
    return tabs
        .map(function(tab, index) {
            if (!movedTabIdsSet.has(tab.id)) {
                return;
            }

            if (moveProperties.windowId) {
                tab.windowId = moveProperties.windowId;
                // Tabs moved across windows always lose their openerTabId even
                // if it is also moved to the same window together, thus we need
                // to restore it manually.
                // https://github.com/piroor/treestyletab/issues/2546#issuecomment-733488187
                if (openerTabIds[index] > 0) {
                    tab.openerTabId = openerTabIds[index];
                    browser.tabs.update(tab.id, {
                        openerTabId: tab.openerTabId,
                    }).catch(() => {});
                }
            }

            if (movedTabsObj[tab.id]) {
                tab.index = movedTabsObj[tab.id].index;
            }

            return tab;
        })
        .filter(Boolean);
}

const tabsActionSchema = new Map([
    ['get', {sendOneByOne: true, processGroupId: true}], // TODO refactor to use it
    ['discard', {sendArray: true, sendOneByOne: true}],
    ['show', {sendArray: true, sendOneByOne: true}],
    ['hide', {sendArray: true, sendOneByOne: true}],
    ['remove', {sendArray: true, sendOneByOne: true}],
    ['update', {sendOneByOne: true, processGroupId: true}],
    ['reload', {sendOneByOne: true}],
    ['move', {sendArray: true, processGroupId: true}], // TODO refactor to use it
]);

async function tabsAction({action, skipTrackingFlag = false, silentRemove = false}, tabs, ...funcArgs) {
    const schema = tabsActionSchema.get(action);

    if (!schema) {
        throw Error(`invalid action: ${action}`);
    }

    if (!tabs) {
        throw Error(`invalid tabs`);
    }

    tabs = Array.isArray(tabs) ? tabs : [tabs];

    if (!tabs.length) {
        return;
    }

    const tabIds = tabs.map(extractId);
    const log = logger.start(`tabsAction`, {skipTrackingFlag, silentRemove}, `browser.tabs.${action}(`,tabIds,...funcArgs,')');

    if (action === 'remove') {
        skipTrackingFlag = true;

        if (silentRemove) {
            tabIds.forEach(tabId => skip.removed.add(tabId));
        }
    }

    if (skipTrackingFlag) {
        skipTracking(tabIds); // TODO
    }

    let result = [];

    async function sendOneByOne() {
        const settled = await Promise.allSettled(tabIds.map(tabId => {
            return browser.tabs[action](tabId, ...funcArgs);
        }));

        for (const [index, {status, value, reason}] of settled.entries()) {
            if (status === 'fulfilled') {
                result.push(value || tabIds[index]);
            } else {
                log.warn(action, 'was rejected for tab:', tabs[index], 'reason:', reason);
            }
        }
    }

    if (schema.sendArray) {
        try {
            result = await browser.tabs[action](tabIds, ...funcArgs);
            result ||= tabIds;
        } catch (e) {
            if (schema.sendOneByOne) {
                log.logError(`fail ${action} tabs as array of ids, doing it one by one`, e);
                await sendOneByOne();
            } else {
                log.throwError(`fail ${action} tabs`, e);
            }
        }
    } else if (schema.sendOneByOne) {
        await sendOneByOne();
    } else {
        log.throwError('invalid schema config');
    }

    if (skipTrackingFlag) {
        continueTracking(tabIds);
    }

    if (schema.processGroupId) {
        result.forEach(tab => delete tab.groupId); // TODO tmp
    }

    log.stop(result.map(extractId), ')');

    return result;
}

export async function show(tabs, skipTrackingFlag = false) {
    return await tabsAction({action: 'show', skipTrackingFlag}, tabs);
}

export async function hide(tabs, skipTrackingFlag = false) {
    return await tabsAction({action: 'hide', skipTrackingFlag}, tabs);
}

export async function discard(tabs, skipTrackingFlag = false) {
    return await tabsAction({action: 'discard', skipTrackingFlag}, tabs);
}

export async function reload(tabs, bypassCache = false) {
    return await tabsAction({action: 'reload'}, tabs, {bypassCache});
}

export async function setMute(tabs, muted) {
    logger.log('setMute', {muted});

    tabs = await getList(tabs.map(extractId), false, false);
    muted = Boolean(muted);

    tabs = tabs.filter(tab => muted ? tab.audible : tab.mutedInfo.muted);

    return await tabsAction({action: 'update'}, tabs, {muted});
}

export async function remove(tabs, silentRemove = false) {
    return await tabsAction({action: 'remove', silentRemove}, tabs);
}

export async function sendMessage(tabId, message) {
    message.colorScheme = options.colorScheme;
    return browser.tabs.sendMessage(tabId, message).catch(() => {});
}

export function prepareForSave(tabs, ...prepareArgs) {
    return tabs.map(tab => prepareForSaveTab(tab, ...prepareArgs));
}

export function prepareForSaveTab(
        {id, url, title, cookieStoreId, favIconUrl, openerTabId, groupId, thumbnail, lastAccessed},
        includeGroupId = false,
        includeFavIconUrl = false,
        includeThumbnail = false,
        includeId = true,
        includeLastAccessed = true
    ) {
    const tab = {url};

    if (includeId && id) {
        tab.id = id;

        if (openerTabId) {
            tab.openerTabId = openerTabId;
        }
    }

    if (title) {
        tab.title = title;
    }

    if (!Containers.isDefault(cookieStoreId)) {
        tab.cookieStoreId = Containers.isTemporary(cookieStoreId) ? Constants.TEMPORARY_CONTAINER : cookieStoreId;
    }

    if (includeGroupId && groupId) {
        tab.groupId = groupId;
    }

    if (includeFavIconUrl && favIconUrl?.startsWith('data:')) {
        tab.favIconUrl = favIconUrl;
    }

    if (includeThumbnail && thumbnail) {
        tab.thumbnail = thumbnail;
    }

    if (includeLastAccessed && lastAccessed) {
        tab.lastAccessed = lastAccessed;
    }

    return tab;
}

export function getNewTabContainer(
        {url, cookieStoreId, status},
        {newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID, ifDifferentContainerReOpen, excludeContainersForReOpen = []}
    ) {

    if (cookieStoreId === newTabContainer || Containers.isTemporary(cookieStoreId)) {
        return cookieStoreId;
    }

    if (url && !url.startsWith('http') && !url.startsWith('ftp') && status !== browser.tabs.TabStatus.LOADING) {
        return Constants.DEFAULT_COOKIE_STORE_ID;
    }

    if (ifDifferentContainerReOpen) {
        return excludeContainersForReOpen.includes(cookieStoreId) ? cookieStoreId : newTabContainer;
    }

    return Containers.isDefault(cookieStoreId) ? newTabContainer : cookieStoreId;
}

export function getTitle({id, index, title, url, discarded, windowId, lastAccessed}, withUrl = false, sliceLength = 0, withActiveTab = false) {
    title = title || url || 'about:blank';

    if (withUrl && url && title !== url) {
        title += '\n' + url;
    }

    if (withActiveTab && id) {
        title = (discarded ? Constants.DISCARDED_SYMBOL : Constants.ACTIVE_SYMBOL) + ' ' + title;
    }

    if (mainStorage.enableDebug && id) {
        let lastDate = new Date(lastAccessed);

        if (lastDate.getTime()) {
            lastDate = `(${lastDate.getMinutes()}:${lastDate.getSeconds()}.${lastDate.getMilliseconds()})`;
        } else {
            lastDate = '';
        }

        title = `@${windowId}:#${id}:i${index} ${lastDate} ${title}`;
    }

    return sliceLength ? Utils.sliceText(title, sliceLength) : title;
}

// const restrictedDomainsRegExp = /^https?:\/\/(.+\.)?(mozilla\.(net|org|com)|firefox\.com)\//;
const restrictedDomains = new Set('accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,addons.mozilla.org,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com'.split(','));

export function isCanSendMessage({url}) {
    if (url === 'about:blank') {
        return true;
    }

    if (url.startsWith('about:') || url.startsWith('moz-extension')) {
        return false;
    }

    try {
        return !restrictedDomains.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

export function extractId(tab) {
    return tab.id || tab;
}

export function isPinned(tab) {
    return tab.pinned === true;
}

function isCanBeHidden(tab) {
    return !isPinned(tab) && tab.sharingState && !tab.sharingState.screen && !tab.sharingState.camera && !tab.sharingState.microphone;
}

export function isCanNotBeHidden(tab) {
    return !isCanBeHidden(tab);
}

export function isLoaded(tab) {
    return tab.status === browser.tabs.TabStatus.COMPLETE;
}

export function isLoading(tab) {
    return tab.status === browser.tabs.TabStatus.LOADING;
}

export function normalizeUrl(tab) {
    tab.url = Utils.normalizeUrl(tab.url);
    return tab;
}

export function normalizeFavIcon(tab) {
    if (!Utils.isAvailableFavIconUrl(tab.favIconUrl)) {
        tab.favIconUrl = ConstantsBrowser.DEFAULT_FAVICON;
    }

    return tab;
}
