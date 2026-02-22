import {
    ANY_ACTION,
    actionsSet,
    normalizeMessage,
    addActionHandler,
    removeHandlers,
    dispatchActionHandlers,
} from './channel-utils.js';

export {ANY_ACTION} from './channel-utils.js';

export const CHANNEL_NAME = new URL(import.meta.url).searchParams.get('channel') || 'stg';

const handlersByAction = new Map;
const messageErrorHandlers = new Set;

const channel = new BroadcastChannel(CHANNEL_NAME);

channel.addEventListener('message', handleMessage, false);
channel.addEventListener('messageerror', handleMessageError, false);

function handleMessage(event) {
    dispatchMessage(event.data, event);
}

function handleMessageError(event) {
    if (!messageErrorHandlers.size) {
        console.error(BroadcastChannel.name, CHANNEL_NAME, 'error', event, 'remote');
        return;
    }

    for (const func of messageErrorHandlers) {
        try {
            func(event, 'remote');
        } catch (error) {
            console.error(error, CHANNEL_NAME, 'event:', event);
        }
    }
}

function dispatchMessage(data, event) {
    dispatchActionHandlers(
        handlersByAction,
        data,
        handler => {
            try {
                handler.func(data, event);
            } catch (error) {
                console.error(error, CHANNEL_NAME, 'data:', data, 'event:', event);
            }
        }
    );
}

export function on(actions, func) {
    actions = actionsSet(actions);

    for (const action of actions) {
        addActionHandler(
            handlersByAction,
            action,
            {func},
            handler => handler.func === func
        );
    }

    return () => off(func, actions);
}

export function off(func = null, actions = ANY_ACTION) {
    return removeHandlers(handlersByAction, func, actions);
}

export function offActions(actions = null) {
    return off(null, actions);
}

export function onMessageError(func) {
    messageErrorHandlers.add(func);
    return () => offMessageError(func);
}

export function offMessageError(func) {
    return messageErrorHandlers.delete(func);
}

export function send(action, {localOnly = false, includeSelf = true} = {}) {
    const message = normalizeMessage(action);

    if (!localOnly) {
        channel.postMessage(message);
    }

    if (includeSelf) {
        dispatchMessage(message, null);
    }

    return message;
}
