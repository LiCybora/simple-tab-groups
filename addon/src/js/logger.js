(function() {
    'use strict';

    const consoleKeys = ['log', 'info', 'warn', 'error', 'debug', 'assert'];
    const isBackgroundPage = window.location.pathname.includes('background');
    const addonUrlPrefix = browser.runtime.getURL('');

    let messages;
    if (!isBackgroundPage) {
        messages = self.Messages?.connectToBackground('Logger');
    }

    Logger.logs = [];

    function Logger(prefix, prefixes = []) {
        if (this) { // create new logger with prefix
            this.scope = null;
            this.stopMessage = null;
            this.prefixes ??= prefixes;

            if (prefix) {
                this.prefixes.push(prefix);
            }

            this.indentConfig = indentConfig;

            setLoggerFuncs.call(this);

            return this;
        } else {
            Logger.prototype.addLog.apply(new Logger, Array.from(arguments));
        }
    }

    function setLoggerFuncs() {
        consoleKeys.forEach(cKey => this[cKey] = Logger.prototype.addLog.bind(this, cKey));

        this.start = function(...startArgs) {
            let cKey = 'log';

            if (Array.isArray(startArgs[0])) {
                cKey = startArgs[0].shift();
                startArgs = [...startArgs[0], ...startArgs.slice(1)];
            }

            const uniq = getRandomInt(),
                logger = new Logger(startArgs.shift(), this.prefixes.slice());

            logger.scope = uniq;
            logger.stopMessage = `STOP ${logger.scope}`;

            logger[cKey](`START ${logger.scope}`, ...startArgs);

            logger.stop = (...args) => {
                logger.log.call(logger, logger.stopMessage, ...args);
                return args[0];
            };

            logger.stopError = (...args) => {
                logger.error.call(logger, logger.stopMessage, ...args);
                return args[0];
            };

            return logger;
        }.bind(this);

        this.create = this.start; // alias

        this.onCatch = function(message, throwError = true) {
            return (error) => {
                if (typeof message === 'string') {
                    message = `Catch error on: ${message}`;
                } else if (Array.isArray(message)) {
                    message.unshift(`Catch error on:`);
                }

                error ??= typeof message === 'object' ? new Error(stringify(message)) : new Error(message);

                let args = [...[message].flat(), normalizeError(error)];

                if (throwError && this.stopMessage) {
                    args.unshift(this.stopMessage);
                }

                this.error(...args);

                if (throwError) {
                    throw error;
                }

                // !ни в коем случае не делай ретурн !!! повлияет на tabs.filter(Boolean)
            }
        }.bind(this);

        this.onError = function(...args) {
            return this.onCatch(...args);
        }.bind(this);

        this.throwError = function(message, error) {
            return this.onError(message, true)(error);
        }.bind(this);

        this.runError = function(message, error) {
            return this.onError(message, false)(error);
        }.bind(this);

        return this;
    }

    Logger.prototype.addLog = function(cKey, ...args) {
        if (!Array.isArray(this.prefixes)) {
            return console.error('invalid logger scope');
        }

        if (cKey === 'assert' && args[0]) {
            return;
        }

        const argsToLog = [this.prefixes.join('.'), ...args];

        if (this.scope && !args.some(l => l?.includes?.(this.scope))) {
            argsToLog.push(`SCOPE ${this.scope}`);
        }

        const log = {
            [`console.${cKey}`]: clone(argsToLog),
            time: (new Date).toISOString(),
            stack: getStack(new Error),
        };

        if (cKey === 'error') {
            Errors.set(log);
        }

        if (isBackgroundPage) {
            Logger.logs.push(log);
            Logger.prototype.showLog.call(this, log, {cKey, args});
        } else {
            messages?.sendMessage('save-log', {
                log,
                logger: clone(this),
                options: {
                    cKey,
                    args: clone(args),
                },
            });
        }
    }

    Logger.prototype.showLog = function(log, {cKey, args}) {
        if (self.localStorage.enableDebug || window.IS_TEMPORARY || window.BG?.IS_TEMPORARY) {
            let argsToConsole = cKey === 'assert'
                ? [args[0], this.prefixes.join('.'), ...args.slice(1)]
                : log[`console.${cKey}`].slice();

            if (!console[cKey]) {
                cKey = 'log';
            }

            if (window.IS_TEMPORARY || !isBackgroundPage) {
                argsToConsole.push('(' + log.stack.slice(0, 2).join(' ◁ ') + ')');
            }

            let consoleIndent = getIndent.call(this.indentConfig, argsToConsole);

            if (consoleIndent.length) {
                argsToConsole.splice((cKey === 'assert' ? 1 : 0), 0, consoleIndent);
            }

            console[cKey].call(console, ...argsToConsole);
        }
    }

    const indentConfig = {
        indentSymbol: '   ',
        startSymbol: '▷', // 🔻⚡️
        stopSymbol: '◁', // 🔺⭕️
        index: 0,
        indexByKey: {},
        regExp: /(START|STOP|SCOPE) (\d+)/,
    };

    function getIndent(args) {
        let action, key,
            indentCount = this.index;

        let argIndex = args.findIndex(arg => {
            [, action, key] = this.regExp.exec(arg) || [];
            return action;
        });

        if (action === 'START') {
            indentCount = this.indexByKey[key] = this.index++;

            args[argIndex] = this.startSymbol;
        } else if (action === 'STOP') {
            indentCount = this.indexByKey[key];

            if (this.index > 0) {
                this.index--;
            }

            args[argIndex] = this.stopSymbol;
        } else if (action === 'SCOPE') {
            indentCount = this.indexByKey[key];
            args.splice(argIndex, 1);
        }

        return this.indentSymbol.repeat(indentCount);
    };

    const Errors = {
        get(clearAfter) {
            let errorLogs = JSON.parse(window.localStorage.errorLogs || null) || [];

            if (clearAfter) {
                delete window.localStorage.errorLogs;
            }

            return errorLogs;
        },
        set(error) {
            let errorLogs = this.get();

            errorLogs.push(error);

            window.localStorage.errorLogs = JSON.stringify(errorLogs.slice(-50));
        },
    };

    Logger.getErrors = Errors.get.bind(Errors);

    Logger.clearLogs = () => {
        Logger.logs = Logger.logs.slice(-150);
        Logger.getErrors(true);
    };

    function normalizeError(event) {
        let nativeError = event.error || event;

        if (
            !nativeError ||
            !String(nativeError?.name).toLowerCase().includes('error') ||
            nativeError.fileName === 'undefined' ||
            !nativeError.stack?.length
        ) {
            let {stack = ''} = nativeError;
            nativeError = new Error(nativeErrorToObj(nativeError));
            if (!stack.length) {
                nativeError.stack = stack + `\nFORCE STACK\n` + nativeError.stack;
            }
        }

        return {
            time: (new Date).toISOString(),
            ...nativeErrorToObj(nativeError),
            stack: getStack(nativeError),
        };
    }

    Logger.nativeErrorToObj = nativeErrorToObj;
    function nativeErrorToObj(nativeError) {
        return {
            message: nativeError.message,
            fileName: nativeError.fileName?.replace(addonUrlPrefix, ''),
            lineNumber: nativeError.lineNumber,
            columnNumber: nativeError.columnNumber,
            stack: getStack(nativeError).join('\n'),
            arguments: nativeError.arguments,
        };
    }

    function errorEventHandler(event) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();

        window.localStorage.enableDebug ??= 2;

        if (this instanceof Logger) {
            this.runError(String(event), event);
        } else if (self.logger) {
            self.logger.runError(String(event), event);
        } else {
            console.error(event.message, event)
        }

        // if (false !== data.showNotification) {
            showErrorNotificationMessage();
        // }
    }

    function showErrorNotificationMessage() {
        if (isBackgroundPage) {
            onMessage('show-error-notification');
        } else {
            messages?.sendMessage('show-error-notification');
        }
    }

    const DELETE_LOG_STARTS_WITH = [
        'Logger',
        'normalizeError',
        'setLoggerFuncs',
        'sendMessage',
        'sendExternalMessage',
    ];

    const UNNECESSARY_LOG_STRINGS = [
        addonUrlPrefix,
        'async*',
        '../node_modules/vue-loader/lib/index.js??vue-loader-options!./popup/Popup.vue?vue&type=script&lang=js&',
        '../node_modules/vue-loader/lib/index.js??vue-loader-options!./manage/Manage.vue?vue&type=script&lang=js&',
        '../node_modules/vue-loader/lib/index.js??vue-loader-options!./options/Options.vue?vue&type=script&lang=js&',
    ];

    function getStack(e, start = 0, to = 50) {
        return UNNECESSARY_LOG_STRINGS
            .reduce((str, strToDel) => str.replaceAll(strToDel, ''), e.stack)
            .trim()
            .split('\n')
            .filter(Boolean)
            .filter(str => !DELETE_LOG_STARTS_WITH.some(unlogStr => str.startsWith(unlogStr)))
            .slice(start, to);
    }

    function getRandomInt(min = 1, max = Number.MAX_SAFE_INTEGER) {
        const randomBuffer = new Uint32Array(1);

        window.crypto.getRandomValues(randomBuffer);

        let randomNumber = randomBuffer[0] / (0xffffffff + 1);

        min = Math.ceil(min);
        max = Math.floor(max);

        return Math.floor(randomNumber * (max - min + 1)) + min;
    }

    function clone(obj) {
        return JSON.parse(stringify(obj));
    }

    function stringify(obj) {
        return JSON.stringify(obj, getCircularReplacer());
    }

    function getCircularReplacer() {
        const seen = new WeakSet();

        return (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return;
                }

                seen.add(value);
            }

            return value;
        };
    }


    self.Logger = Logger;

    self.errorEventHandler = errorEventHandler;
    self.addEventListener('error', self.errorEventHandler);
    self.addEventListener('unhandledrejection', e => self.errorEventHandler(e.reason));

})();
