
import '/js/prefixed-storage.js';
import {objectToNativeError} from '/js/logger.js';
import * as Constants from '/js/constants.js';
import * as Utils from '/js/utils.js';
import * as Messages from '/js/messages.js';
import * as Cloud from '/js/sync/cloud/cloud.js?context-mixin'; // context-mixin - for unique Broadcast listeners scope. Because on this page Cloud.off() has been called in beforeDestroy() and without context-mixin it will remove listeners into Options page

const MODULE_NAME = 'sync-cloud.mixin';
// const logger = new Logger(MODULE_NAME, [Utils.getNameFromPath(location.href)]);

const storage = localStorage.create(Constants.MODULES.CLOUD);

const {sendMessageModule} = Messages.connectToBackground(MODULE_NAME);

export default {
    data() {
        return {
            syncCloudLastUpdateAgo: null,

            syncCloudInProgress: false,
            syncCloudProgress: 0,
            syncCloudErrorMessage: '',
        };
    },
    created() {
        this.syncCloudUpdateInfo();

        Cloud.onSyncUiRequest();

        Cloud.on(['sync-start', 'sync-progress', 'sync-end', 'sync-error', 'sync-finish'], () => {
            this.syncCloudInProgress = true; // any action means that progress is being made
            clearTimeout(this.syncCloudUpdateInfoTimer);
            clearTimeout(this.syncCloudProgressTimer);
            clearTimeout(this.syncCloudInProgressTimer);
        });

        Cloud.on('sync-start', () => {
            this.syncCloudErrorMessage = '';
        });

        Cloud.on('sync-progress', ({progress}) => {
            this.syncCloudProgress = progress;
        });

        Cloud.on('sync-end', () => {
            // nothing to do
        });

        Cloud.on('sync-error', e => {
            this.syncCloudErrorMessage = String(objectToNativeError(e));
        });

        Cloud.on('sync-finish', ({ok}) => {
            this.syncCloudProgressTimer = setTimeout(() => {
                this.syncCloudProgress = 0;
            }, ok ? 600 : 5000);

            this.syncCloudInProgressTimer = setTimeout(() => {
                this.syncCloudInProgress = false;
            }, 500);

            this.syncCloudUpdateInfo();
        });
    },
    beforeDestroy() {
        Cloud.off();
        clearTimeout(this.syncCloudUpdateInfoTimer);
    },
    methods: {
        async syncCloud(trust, revision) {
            return await sendMessageModule('BG.cloudSync', {trust, revision});
        },
        syncCloudUpdateInfo() {
            if (storage.lastUpdate) {
                this.syncCloudLastUpdateAgo = Utils.relativeTime(storage.lastUpdate);
            }

            this.syncCloudErrorMessage = storage.lastError || '';

            this.syncCloudUpdateInfoTimer = setTimeout(() => this.syncCloudUpdateInfo(), 30_000);
        },
    },
}
