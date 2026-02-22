export const ANY_ACTION = '*';
export const ANY_ORIGIN = '*';

// value: String, Array, Set
export function listSet(value, map = v => v) {
    return new Set((value instanceof Set ? Array.from(value) : [value]).flat(Infinity).map(map).filter(Boolean));
}

export function actionsSet(actions) {
    actions = listSet(actions);

    if (!actions.size || actions.has(ANY_ACTION)) {
        actions.clear();
        actions.add(ANY_ACTION);
    }

    return actions;
}

export function normalizeMessage(message) {
    return message && typeof message === 'object' ? message : {action: message};
}

export function addActionHandler(handlersByAction, action, item, isDuplicate = null) {
    action = String(action);
    const handlers = handlersByAction.get(action) ?? new Set;

    for (const handler of handlers) {
        if (isDuplicate?.(handler, item) ?? handler === item) {
            return false;
        }
    }

    handlers.add(item);
    handlersByAction.set(action, handlers);

    return true;
}

export function removeActionHandler(handlersByAction, action, handler) {
    const handlers = handlersByAction.get(action) ?? new Set;
    const deleted = handlers.delete(handler);

    if (handlers.size === 0) {
        handlersByAction.delete(action);
    }

    return deleted;
}

export function removeHandlers(handlersByAction, func, actions, matchHandler = null) {
    actions = actionsSet(actions);

    if (actions.has(ANY_ACTION)) {
        actions = new Set(handlersByAction.keys());
    }

    let removedCount = 0;

    for (const action of actions) {
        for (const handler of handlersByAction.get(action) ?? new Set) {
            if (func && func !== handler.func) {
                continue;
            }

            if (matchHandler != null && !matchHandler(handler)) {
                continue;
            }

            if (removeActionHandler(handlersByAction, action, handler)) {
                removedCount++;
            }
        }
    }

    return removedCount;
}

export function dispatchActionHandlers(handlersByAction, data, handleCandidate) {
    const action = data?.action ? String(data.action) : null;
    const candidates = new Set;

    for (const handler of handlersByAction.get(action) ?? new Set) {
        candidates.add(handler);
    }

    for (const handler of handlersByAction.get(ANY_ACTION) ?? new Set) {
        candidates.add(handler);
    }

    for (const handler of candidates) {
        handleCandidate(handler);
    }
}
