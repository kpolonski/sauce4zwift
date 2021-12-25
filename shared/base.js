/* global */

let isNode;
try {
    module, global, require;
    isNode = true;
} catch(e) {
    isNode = false;
}

(function(ns) {
    'use strict';

    const pendingAsyncExports = [];

    function buildPath(path) {
        let offt = ns;
        for (const x of path) {
            if (!offt[x]) {
                offt[x] = {};
            }
            offt = offt[x];
        }
        return offt;
    }

    ns.ns = function(ns, callback, options={}) {
        const offt = buildPath(ns.split('.'));
        const assignments = callback && callback(offt);
        if (assignments instanceof Promise) {
            assignments.then(x => Object.assign(offt, x));
            if (options.hasAsyncExports) {
                pendingAsyncExports.push(assignments);
            }
        } else if (assignments) {
            Object.assign(offt, assignments);
        }
        return offt;
    };


    const _maxTimeout = 0x7fffffff;  // `setTimeout` max valid value.
    ns.sleep = async function(ms) {
        while (ms > _maxTimeout) {
            // Support sleeping longer than the javascript max setTimeout...
            await new Promise(resolve => setTimeout(resolve, _maxTimeout));
            ms -= _maxTimeout;
        }
        return await new Promise(resolve => setTimeout(resolve, ms));
    };


    /* Only use for non-async callbacks */
    ns.debounced = function(scheduler, callback) {
        let nextPending;
        const wrap = function() {
            const waiting = !!nextPending;
            nextPending = [this, arguments];
            if (waiting) {
                return;
            }
            scheduler(() => {
                try {
                    callback.apply(...nextPending);
                } finally {
                    nextPending = null;
                }
            });
        };
        if (callback.name) {
            Object.defineProperty(wrap, 'name', {value: `sauce.debounced[${callback.name}]`});
        }
        return wrap;
    };


    ns.formatInputDate = function(ts) {
        // Return a input[type="date"] compliant value from a ms timestamp.
        return ts ? (new Date(ts)).toISOString().split('T')[0] : '';
    };


    ns.blobToArrayBuffer = async function(blob) {
        const reader = new FileReader();
        const done = new Promise((resolve, reject) => {
            reader.addEventListener('load', resolve);
            reader.addEventListener('error', () => reject(new Error('invalid blob')));
        });
        reader.readAsArrayBuffer(blob);
        await done;
        return reader.result;
    };


    ns.LRUCache = class LRUCache extends Map {
        constructor(capacity) {
            super();
            this._capacity = capacity;
            this._head = null;
            this._tail = null;
        }

        get(key) {
            const entry = super.get(key);
            if (entry === undefined) {
                return;
            }
            if (entry.next !== null) {
                this._moveToHead(entry);
            }
            return entry.value;
        }

        set(key, value) {
            let entry = super.get(key);
            if (!entry) {
                entry = {key, value, next: null};
                if (!this.size) {
                    this._head = (this._tail = entry);
                } else if (this.size === this._capacity) {
                    this.delete(this._tail.key);
                    this._tail = this._tail.next;
                }
                super.set(key, entry);
            }
            this._moveToHead(entry);
        }

        _moveToHead(entry) {
            if (this._tail === entry && entry.next !== null) {
                this._tail = entry.next;
            }
            entry.next = null;
            if (this._head !== entry) {
                this._head.next = entry;
                this._head = entry;
            }
        }

        clear() {
            this._head = null;
            this._tail = null;
            super.clear();
        }
    };
})(isNode ? this : (this.sauce = {}));