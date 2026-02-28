import './polyfills.js';

export default class BatchProcessor {
    #batches = new Map;
    #queue = new Set;
    #processPromise = null;
    #processCallback;
    #batchDelay;
    #processEmpty;
    #singletonId = Symbol.for('singletonId');

    constructor(processCallback = null, batchDelay = 100, processEmpty = false) {
        this.#processCallback = processCallback;
        this.#batchDelay = batchDelay;
        this.#processEmpty = processEmpty;
    }

    async #processQueue() {
        if (this.#processPromise) {
            await this.#processPromise?.catch(() => {});
            return this.#processQueue();
        }

        while (this.#queue.size) {
            const [batch] = this.#queue;
            this.#queue.delete(batch);

            this.#processPromise = batch.promise;

            try {
                const result = {
                    items: batch.items,
                    callbackResult: null,
                };

                if (batch.items.size || this.#processEmpty) {
                    result.callbackResult = await this.#processCallback?.(batch.items, batch.id);
                }

                // batch.promise must be resolved anyway, after callback, even if there are no items to process
                batch.resolve(result);
            } catch (error) {
                batch.reject(error);
            }
        }

        this.#processPromise = null;
    }

    #addQueue(...batches) {
        for (const batch of batches) {
            clearTimeout(batch.timer);
            this.#batches.delete(batch.id);
            this.#queue.add(batch);
        }
        this.#processQueue();
    }

    add(item, id = this.#singletonId) {
        const batch = this.#batches.getOrInsertComputed(id, id => ({
            id,
            items: new Set,
            timer: null,
            ...Promise.withResolvers(),
        }));

        batch.items.add(item);

        clearTimeout(batch.timer);

        batch.timer = setTimeout(() => this.#addQueue(batch), this.#batchDelay);

        return batch.promise;
    }

    delete(item, id = this.#singletonId) {
        this.#batches.get(id)?.items.delete(item);
    }

    size(id = this.#singletonId) {
        return this.#batches.get(id)?.items.size ?? 0;
    }

    /* flush(id = this.#singletonId) {
        const batch = this.#batches.get(id);
        if (batch) {
            this.#addQueue(batch);
            return batch.promise;
        }
    }

    flushAll() {
        this.#addQueue(...this.#batches.values());
    } */
}
