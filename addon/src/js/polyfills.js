
Map.prototype.getOrInsert ??= function(key, defaultValue) { // TODO remove at FF 144+
    if (!this.has(key)) {
        this.set(key, defaultValue);
    }
    return this.get(key);
};

Map.prototype.getOrInsertComputed ??= function(key, callback) { // TODO remove at FF 144+
    if (!this.has(key)) {
        this.set(key, callback(key));
    }
    return this.get(key);
};
