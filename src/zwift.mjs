/* global Buffer */
import fetch from 'node-fetch';
import protobuf from 'protobufjs';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import events from 'node:events';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {XXHash32} = require('xxhash-addon');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _case = protobuf.parse.defaults.keepCase;
protobuf.parse.defaults.keepCase = true;
export const protos = protobuf.loadSync([path.join(__dirname, 'zwift.proto')]).root;
protobuf.parse.defaults.keepCase = _case;


class WorldTime extends events.EventEmitter {
    constructor() {
        super();
        // Start with assumption that Date.now() is accurate but it will be tuned
        // on each UDP connection.
        this._epoch = 1414016074335;
        this._offt = this._epoch;
    }

    now() {
        return Date.now() - this._offt;
    }

    serverNow() {
        return Date.now() + (this._epoch - this._offt);
    }

    toTime(wt) {
        return wt + this._offt;
    }

    toServerTime(wt) {
        return wt + this._epoch;
    }

    setOffset(offt) {
        const diff = offt - this._offt;
        if (Math.abs(diff) > 5000) {
            console.warn("Shifting worldTime offset:", diff);
        }
        this._offt = Math.round(offt);
        this.emit('offset', diff);
    }
}

export const worldTime = new WorldTime();


function zwiftCompatDate(date) {
    return date && (date.toISOString().slice(0, -5) + 'Z');
}


// When game lags it can send huge values.  BLE testing suggests 240 is
// their normal limit and they just drop values over this and send 1. So
// we'll emulate that behavior.
const cadenceMax = 240 * 1e6 / 60;
const halfCircle = 1e6 * Math.PI;
const pbProfilePrivacyFlags = {
    approvalRequired: 0x1,
    minor: 0x2,
    displayWeight: 0x4,
    privateMessaging: 0x8,
    defaultFitnessDataPrivacy: 0x10,
    suppressFollowerNotification: 0x20,
};
const pbProfilePrivacyFlagsInverted = {
    displayAge: 0x40,
};
const sportsEnum = Object.fromEntries(Object.entries(protos.Sport).map(([k, v]) => [v, k.toLowerCase()]));
const powerUpsEnum = Object.fromEntries(Object.entries(protos.POWERUP_TYPE)
    .map(([label, id]) => [id, label]));
powerUpsEnum[0xf] = null;  // masked
const turningEnum = {
    0: null,
    1: 'RIGHT',
    2: 'LEFT',
};
const worldCourseDescs = [
    {worldId: 1, courseId: 6, name: 'Watopia'},
    {worldId: 2, courseId: 2, name: 'Richmond'},
    {worldId: 3, courseId: 7, name: 'London'},
    {worldId: 4, courseId: 8, name: 'New York'},
    {worldId: 5, courseId: 9, name: 'Innsbruck'},
    {worldId: 6, courseId: 10, name: 'Bologna'},
    {worldId: 7, courseId: 11, name: 'Yorkshire'},
    {worldId: 8, courseId: 12, name: 'Crit City'},
    {worldId: 9, courseId: 13, name: 'Makuri Islands'},
    {worldId: 10, courseId: 14, name: 'France'},
    {worldId: 11, courseId: 15, name: 'Paris'},
    {worldId: 12, courseId: 16, name: 'Gravel Mountain'},
];
export const courseToWorldIds = Object.fromEntries(worldCourseDescs.map(x => [x.courseId, x.worldId]));
export const worldToCourseIds = Object.fromEntries(worldCourseDescs.map(x => [x.worldId, x.courseId]));
export const courseToNames = Object.fromEntries(worldCourseDescs.map(x => [x.courseId, x.name]));
export const worldToNames = Object.fromEntries(worldCourseDescs.map(x => [x.worldId, x.name]));


function decodeGroupEventUserRegistered(buf) {
    return {
        athleteId: buf.readUInt32LE(8),
        subgroupId: buf.readUInt32LE(16),
        unknownFlags1: buf.readUInt32LE(20),
        unknownFlags2: buf.readUInt32LE(24),
        unknownFlags3: buf.readUInt32LE(28),
        worldTime: buf.readDoubleLE(32),
    };
}


function decodeNotableMoment(buf) {
    console.devWarn("Figure this out (notable momment):", buf.toString('hex'));
    return {};
}


const binaryWorldUpdatePayloads = {
    groupEventUserRegistered: decodeGroupEventUserRegistered,
    notableMoment: decodeNotableMoment,
};


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export function decodePlayerStateFlags1(bits) {
    return {
        powerMeter: !!(bits & 0b1),
        companionApp: !!(bits & 0b10),
        reverse: !(bits & 0b100),  // It's actually a forward bit
        uTurn: !!(bits & 0b1000),
        _b4_15: bits >>> 4 & 0xfff,
        auxCourseId: bits >>> 16 & 0xff,
        rideons: bits >>> 24,
    };
}


export function encodePlayerStateFlags1(props) {
    let bits = 0;
    bits |= props.rideons & 0xff;
    bits <<= 8;
    bits |= props.auxCourseId & 0xff;
    bits <<= 12;
    bits |= props._b4_15 & 0xfff;
    bits <<= 1;
    bits |= props.uTurn;
    bits <<= 1;
    bits |= !props.reverse;
    bits <<= 1;
    bits |= props.companionApp;
    bits <<= 1;
    bits |= props.powerMeter;
    return bits;
}


export function decodePlayerStateFlags2(bits) {
    return {
        activePowerUp: powerUpsEnum[bits & 0xf],
        turning: turningEnum[bits >>> 4 & 0x3],
        turnChoice: bits >>> 6 & 0x3,
        roadId: bits >>> 8 & 0xffff,
        _rem: bits >>> 24,
    };
}


export function encodePlayerStateFlags2(props) {
    let bits = 0;
    bits |= props._rem & 0xff;
    bits <<= 16;
    bits |= props.roadId & 0xffff;
    bits <<= 2;
    bits |= props.turnChoice & 0x3;
    bits <<= 2;
    bits |= {
        RIGHT: 1,
        LEFT: 2,
    }[props.turning] || 0;
    bits <<= 4;
    let powerUping = 0xf;
    if (props.activePowerUp) {
        powerUping = protos.POWERUP_TYPE[props.activePowerUp];
    }
    bits |= powerUping & 0xf;
    return bits;
}


export function processPlayerStateMessage(msg) {
    const flags1 = decodePlayerStateFlags1(msg._flags1);
    const flags2 = decodePlayerStateFlags2(msg._flags2);
    const wt = msg._worldTime.toNumber();
    const latency = worldTime.now() - wt;
    const adjRoadLoc = msg.roadLocation - 5000;  // It's 5,000 -> 1,005,000
    return {
        ...msg,
        ...flags1,
        ...flags2,
        worldTime: wt,
        latency,
        progress: (msg._progress >> 8 & 0xff) / 0xff,
        workoutZone: (msg._progress & 0xF) || null,
        kj: msg._mwHours / 1000 / (1000 / 3600),
        heading: (((msg._heading + halfCircle) / (2 * halfCircle)) * 360) % 360,  // degrees
        speed: msg._speed / 1e6,  // km/h
        joinTime: msg._joinTime.toNumber(),
        sport: sportsEnum[msg.sport],
        cadence: (msg._cadenceUHz && msg._cadenceUHz < cadenceMax) ?
            Math.round(msg._cadenceUHz / 1e6 * 60) : 0,  // rpm
        eventDistance: msg._eventDistance / 100,  // meters
        roadCompletion: flags1.reverse ? 1e6 - adjRoadLoc : adjRoadLoc,
    };
}


function seedToBuffer(num) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(num);
    return buf;
}


export class ZwiftAPI {
    async authenticate(username, password, options={}) {
        if (options.host) {
            this.host = options.host;
        }
        const r = await this.fetch('/auth/realms/zwift/protocol/openid-connect/token', {
            host: this.host || 'secure.zwift.com',
            noAuth: true,
            method: 'POST',
            ok: [200, 401],
            accept: 'json',
            body: new URLSearchParams({
                client_id: 'Zwift Game Client',
                grant_type: 'password',
                password,
                username,
            })
        });
        const resp = await r.json();
        if (r.status === 401) {
            throw new Error(resp.error_description || 'Login failed');
        }
        this.username = username;
        this._authToken = resp;
        console.debug("Zwift auth token acquired");
        this._schedRefresh(this._authToken.expires_in * 1000 / 2);
        this.profile = await this.getProfile('me');
    }

    async _refreshToken() {
        if (!this._authToken) {
            console.warn("No auth token to refresh");
            return false;
        }
        const r = await this.fetch('/auth/realms/zwift/protocol/openid-connect/token', {
            host: this.host || 'secure.zwift.com',
            noAuth: true,
            method: 'POST',
            accept: 'json',
            body: new URLSearchParams({
                client_id: 'Zwift Game Client',
                grant_type: 'refresh_token',
                refresh_token: this._authToken.refresh_token,
            })
        });
        const resp = await r.json();
        this._authToken = resp;
        console.debug("Zwift auth token refreshed");
        this._schedRefresh(this._authToken.expires_in * 1000 / 2);
    }

    _schedRefresh(delay) {
        clearTimeout(this._nextRefresh);
        console.debug(`Refresh Zwift token in: ${delay / 1000 | 0}s`);
        this._nextRefresh = setTimeout(this._refreshToken.bind(this), Math.min(0x7fffffff, delay));
    }

    isAuthenticated() {
        return !!(this._authToken && this._authToken.access_token);
    }

    async fetch(urn, options={}, headers={}) {
        headers = headers || {};
        if (!options.noAuth) {
            if (!this.isAuthenticated()) {
                throw new TypeError('Auth token not set');
            }
            headers['Authorization'] = `Bearer ${this._authToken.access_token}`;
        }
        if (options.json) {
            options.body = JSON.stringify(options.json);
            headers['Content-Type'] = 'application/json';
        }
        if (options.pb) {
            options.body = options.pb.finish();
            headers['Content-Type'] = 'application/x-protobuf-lite; version=2.0';
        }
        if (options.accept) {
            headers['Accept'] = {
                json: 'application/json',
                protobuf: 'application/x-protobuf-lite',
            }[options.accept];
        }
        if (options.apiVersion) {
            headers['Zwift-Api-Version'] = options.apiVersion;
        }
        const host = options.host || this.host || `us-or-rly101.zwift.com`;
        const q = options.query ? ('?' + ((options.query instanceof URLSearchParams) ?
            options.query : new URLSearchParams(options.query))) : '';
        const timeout = options.timeout !== undefined ? options.timeout : 30000;
        const abort = new AbortController();
        const to = timeout && setTimeout(() => abort.abort(), timeout);
        let r;
        try {
            r = await fetch(`https://${host}/${urn.replace(/^\//, '')}${q}`, {
                signal: abort.signal,
                headers: {
                    'Platform': 'OSX',
                    'Source': 'Game Client',
                    'User-Agent': 'CNL/3.24.1 (macOS 12 Monterey; Darwin Kernel 21.6.0) zwift/1.0.105233 curl/7.78.0-DEV',
                    ...headers,
                },
                ...options,
            });
        } finally {
            if (to) {
                clearTimeout(to);
            }
        }
        if (!r.ok && (!options.ok || !options.ok.includes(r.status))) {
            const msg = await r.text();
            const e = new Error(`Zwift HTTP Error: [${r.status}]: ${msg}`);
            e.status = r.status;
            throw e;
        }
        return r;
    }

    async fetchPaged(urn, options={}, headers) {
        const results = [];
        let start = options.start || 0;
        let pages = 0;
        const pageLimit = options.pageLimit == null ? 10 : options.pageLimit;
        const query = options.query || new URLSearchParams();
        const limit = options.limit || 100;
        query.set('limit', limit);
        while (true) {
            query.set('start', start);
            const page = await this.fetchJSON(urn, {query, ...options}, headers);
            for (const x of page) {
                results.push(x);
            }
            if (options.onPage && page.length) {
                if (await options.onPage(page) === false) {
                    break;
                }
            }
            if (page.length < limit || (pageLimit && ++pages >= pageLimit)) {
                break;
            }
            start = results.length;
        }
        return results;
    }

    async fetchJSON(urn, options, headers) {
        const r = await this.fetch(urn, {accept: 'json', ...options}, headers);
        return await r.json();
    }

    async fetchPB(urn, options, headers) {
        const r = await this.fetch(urn, {accept: 'protobuf', ...options}, headers);
        const ProtoBuf = protos.get(options.protobuf);
        const data = Buffer.from(await r.arrayBuffer());
        if (options.debug) {
            console.dev('PB API DEBUG', urn, data.toString('hex'));
        }
        return ProtoBuf.decode(data);
    }

    async getHashSeeds(options) {
        const data = (await this.fetchPB('/relay/worlds/hash-seeds', {
            protobuf: 'HashSeeds',
            ...options
        }));
        return Array.from(data.seeds).map(x => ({
            expiresWorldTime: x.expiryDate.toNumber(),
            nonce: seedToBuffer(x.nonce),
            seed: seedToBuffer(x.seed),
            sig: x.nonce ^ x.seed,
        }));
    }

    async getProfile(id, options) {
        try {
            return await this.fetchJSON(`/api/profiles/${id}`, options);
        } catch(e) {
            if (e.status === 404) {
                return;
            }
            throw e;
        }
    }

    async getProfiles(ids, options) {
        const unordered = (await this.fetchPB('/api/profiles', {
            query: new URLSearchParams(ids.map(id => ['id', id])),
            protobuf: 'PlayerProfiles',
            ...options,
        })).profiles;
        // Reorder and make results similar to getProfile
        const m = new Map(unordered.map(x => [x.id.toNumber(), x.toJSON()]));
        return ids.map(_id => {
            const id = +_id;
            const x = m.get(id);
            if (!x) {
                console.debug('Missing profile:', id);
                return;
            }
            x.id = id;
            x.privacy = {
                defaultActivityPrivacy: x.default_activity_privacy,
            };
            for (const [k, flag] of Object.entries(pbProfilePrivacyFlags)) {
                x.privacy[k] = !!(+x.privacy_bits & flag);
            }
            for (const [k, flag] of Object.entries(pbProfilePrivacyFlagsInverted)) {
                x.privacy[k] = !(+x.privacy_bits & flag);
            }
            x.powerSourceModel === (x._powerType === 'METER') ? 'Power Meter' : undefined;
            return x;
        });
    }

    async getActivities(id) {
        try {
            return await this.fetchJSON(`/api/profiles/${id}/activities`);
        } catch(e) {
            if (e.status === 404) {
                return;
            }
            throw e;
        }
    }

    async getPlayerState(id) {
        let pb;
        try {
            pb = await this.fetchPB(`/relay/worlds/1/players/${id}`, {protobuf: 'PlayerState'});
        } catch(e) {
            if (e.status === 404) {
                return;
            }
            throw e;
        }
        const state = processPlayerStateMessage(pb);
        if (state.activePowerUp === 'NINJA' && state.athleteId !== this.profile.id) {
            return;
        }
        return state;
    }

    convSegmentResult(x) {
        const ret = {
            ...x.toJSON(),
            worldTime: x._worldTime.toNumber(),
            finishTime: x.finishTime && new Date(x.finishTime),
            segmentId: x._unsignedSegmentId.toSigned().toString()
        };
        delete ret._worldTime;
        delete ret._unsignedSegmentId;
        return ret;
    }

    async getLiveSegmentLeaders() {
        const data = await this.fetchPB(`/live-segment-results-service/leaders`,
            {protobuf: 'SegmentResults'});
        return data.results.filter(x => +x.id).map(this.convSegmentResult);
    }

    async getLiveSegmentLeaderboard(segmentId) {
        const data = await this.fetchPB(`/live-segment-results-service/leaderboard/${segmentId}`,
            {protobuf: 'SegmentResults'});
        return data.results.map(this.convSegmentResult);
    }

    async getSegmentResults(segmentId, options={}) {
        const query = {
            world_id: 1,
            segment_id: segmentId,
        };
        if (options.athleteId) {
            query.player_id = options.athleteId;
        }
        if (options.from) {
            query.from = zwiftCompatDate(options.from);
        }
        if (options.to) {
            query.to = zwiftCompatDate(options.to);
        }
        if (options.best) {
            query['only-best'] = 'true';
        }
        const data = (await this.fetchPB('/api/segment-results', {query, protobuf: 'SegmentResults'})).results;
        data.sort((a, b) => a.elapsed - b.elapsed);
        return data;
    }

    async getGameInfo() {
        return await this.fetchJSON(`/api/game_info`, {apiVersion: '2.6'});
    }

    async searchProfiles(searchText, options={}) {
        return await this.fetchPaged('/api/search/profiles', {
            method: 'POST',
            json: {query: searchText},
            ...options
        });
    }

    async getFollowing(athleteId, options={}) {
        return await this.fetchPaged(`/api/profiles/${athleteId}/followees`, options);
    }

    async getFollowers(athleteId, options={}) {
        return await this.fetchPaged(`/api/profiles/${athleteId}/followers`, options);
    }

    async _setFollowing(them, us) {
        return await this.fetchJSON(`/api/profiles/${us}/following/${them}`, {
            method: 'POST',
            json: {
                followeeId: them,
                followerId: us,
            },
        });
    }

    async _setNotFollowing(them, us) {
        const resp = await this.fetch(`/api/profiles/${us}/following/${them}`, {method: 'DELETE'});
        if (!resp.ok) {
            throw new Error(resp.status);
        }
    }

    async _giveRideon(to, from, activity=0) {
        // activity 0 is an in-game rideon
        await this.fetchJSON(`/api/profiles/${to}/activities/${activity}/rideon`, {
            method: 'POST',
            json: {profileId: from},
        });
    }

    async getNotifications() {
        return await (await this.fetch(`/api/notifications`, {accept: 'json'})).json();
    }

    async getEventFeed(options={}) {
        // Be forewarned, this API is not stable.  It returns dups and skips entries on page boundaries.
        const urn = '/api/event-feed';
        const range = options.range || (2 * 3600 * 1000);
        const from = +options.from || (worldTime.serverNow() - range);
        const to = +options.to || (worldTime.serverNow() + range);
        const pageLimit = options.pageLimit ? options.pageLimit : 10;
        const limit = options.limit || 50;
        const query = {from, to, limit};
        const ids = new Set();
        const results = [];
        let pages = 0;
        let done;
        while (!done) {
            const page = await this.fetchJSON(urn, {query});
            for (const x of page.data) {
                if (new Date(x.event.eventStart) >= to) {
                    done = true;
                } else if (!ids.has(x.event.id)) {
                    results.push(x.event);
                    ids.add(x.event.id);
                }
            }
            if (page.data.length < limit || ++pages >= pageLimit) {
                break;
            }
            query.cursor = page.cursor;
        }
        return results;
    }

    async getPrivateEventFeed(options={}) {
        // This endpoint is also unreliable and the from/to don't seem to do much.
        // Sometimes it returns all meetups, and sometimes just recent ones if any.
        const range = options.range || (1 * 3600 * 1000);
        const start_date = +options.from || (worldTime.serverNow() - range);
        const end_date = +options.to || (worldTime.serverNow() + range);
        const query = {start_date, end_date};
        return await this.fetchJSON('/api/private_event/feed', {query});
    }

    async getEvent(id) {
        return await this.fetchJSON(`/api/events/${id}`);
    }

    async getPrivateEvent(id) {
        return await this.fetchJSON(`/api/private_event/${id}`);
    }

    async getEventSubgroupResults(id) {
        let start = 0;
        const limit = 50;  // 50 is max, but the endpoint is wicked fast
        const results = [];
        while (true) {
            const data = await this.fetchJSON(`/api/race-results/entries`, {
                query: {
                    event_subgroup_id: id,
                    start,
                    limit,
                },
            });
            for (const x of data.entries) {
                x.profileData.male = x.profileData.gender === 'MALE';
                results.push(x);
            }
            if (data.entries.length < limit) {
                break;
            }
            start += data.entries.length;
        }
        return results;
    }

    async getEventSubgroupEntrants(id) {
        const entrants = [];
        const limit = 100;
        let start = 0;
        // XXX signed_up seems to be more inclusive but sometimes a user is only in registered
        // I don't know the difference but I can't stand the idea of hitting both.
        while (true) {
            const data = await this.fetchJSON(`/api/events/subgroups/entrants/${id}`, {
                query: {
                    type: 'all',
                    participation: 'signed_up',
                    limit,
                    start,
                }
            });
            entrants.push(...data);
            if (data.length < limit) {
                break;
            }
            start += data.length;
        }
        return entrants;
    }

    async eventSubgroupSignup(id) {
        return await this.fetchJSON(`/api/events/subgroups/signup/${id}`, {method: 'POST'});
    }

    async postWorldUpdate(attrs) {
        return await this.fetch('/relay/worlds/1/attributes', {
            method: 'POST',
            pb: protos.WorldUpdate.encode(attrs),
        });
    }

    async setInGameFields(fields) {
        const id = this.profile.id;
        const resp = await this.fetch(`/api/profiles/${id}/in-game-fields`, {
            method: 'PUT',
            pb: protos.PlayerProfile.encode({
                id,
                ...fields,
            }),
        });
        if (!resp.ok) {
            throw new Error(resp.status);
        }
        return resp;
    }
}


const deviceTypes = {
    relay: 1,
    companion: 2,
};

const channelTypes = {
    udpClient: 1,
    udpServer: 2,
    tcpClient: 3,
    tcpServer: 4,
};

const headerFlags = {
    relayId: 4,
    connId: 2,
    seqno: 1,
};


export class RelayIV {
    constructor(props={}) {
        this.seqno = 0;
        this.deviceType = 'relay';
        Object.assign(this, props);
    }

    toBuffer() {
        const ivBuf = Buffer.alloc(2 + 2 + 2 + 2 + 4); // 12
        ivBuf.writeUInt16BE(deviceTypes[this.deviceType], 2);
        ivBuf.writeUInt16BE(channelTypes[this.channelType], 4);
        ivBuf.writeUInt16BE(this.connId || 0, 6);
        ivBuf.writeUInt32BE(this.seqno || 0, 8);
        return ivBuf;
    }

    toString() {
        return `RelayIV deviceType:${this.deviceType} channelType:${this.channelType} connId:${this.connId} seqno:${this.seqno}`;
    }
}


// These are real values, not test data...
const defaultHashSeed = {
    nonce: seedToBuffer(1234),
    seed: seedToBuffer(5678),
};


class NetChannel extends events.EventEmitter {
    static getConnInc() {
        return this._connInc++ % 0xffff; // Defined by subclasses so tcp and udp each have their own counter
    }

    constructor(options) {
        super();
        this.ip = options.ip;
        this.proto = options.proto;
        this.connId = this.constructor.getConnInc();
        this.relayId = options.session.relayId;
        this.aesKey = options.session.aesKey;
        this.hashSeed = options.hashSeed;
        this._sendSeqno = 0;
        this.sendIV = new RelayIV({channelType: `${options.proto}Client`, connId: this.connId});
        this.recvIV = new RelayIV({channelType: `${options.proto}Server`, connId: this.connId});
        this.recvCount = 0;
        this.sendCount = 0;
        this.errCount = 0;
        this.timeout = options.timeout || 30000;
    }

    toString() {
        return `<NetChannel [${this.proto}] connId: ${this.connId}, relayId: ${this.relayId}, ` +
            `recv: ${this.recvCount}, send: ${this.sendCount}, ip: ${this.ip}>`;
    }

    incError() {
        this.errCount++;
        const limit = 10;
        if (this.errCount > limit) {
            console.error("Error count exceeded limit:", limit);
            this.shutdown();
        }
    }

    decrypt(data) {
        const iv = this.recvIV;
        const flags = data.readUint8(0);
        let headerOfft = 1;
        if (flags & headerFlags.relayId) {
            const relayId = data.readUInt32BE(headerOfft);
            if (relayId !== this.relayId) {
                console.error("Unexpected relayId:", relayId, this.relayId);
                throw new Error("Bad Relay ID");
            }
            headerOfft += 4;
        }
        if (flags & headerFlags.connId) {
            iv.connId = data.readUInt16BE(headerOfft);
            headerOfft += 2;
        }
        if (flags & headerFlags.seqno) {
            iv.seqno = data.readUInt32BE(headerOfft);
            headerOfft += 4;
        }
        const ivBuf = iv.toBuffer();
        const decipher = crypto.createDecipheriv('aes-128-gcm', this.aesKey, ivBuf, {authTagLength: 4});
        decipher.setAAD(data.subarray(0, headerOfft));
        decipher.setAuthTag(data.subarray(-4));
        const plain = Buffer.concat([decipher.update(data.subarray(headerOfft, -4)), decipher.final()]);
        iv.seqno++;
        return plain;
    }

    encrypt(aad, data) {
        const cipher = crypto.createCipheriv('aes-128-gcm', this.aesKey, this.sendIV.toBuffer(),
            {authTagLength: 4});
        cipher.setAAD(aad);
        const dataBuf = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
        this.sendIV.seqno++;
        return dataBuf;
    }

    encodeHeader(options={}) {
        const iv = this.sendIV;
        let flags = 0;
        let headerOfft = 1;
        const header = Buffer.alloc(1 + 4 + 2 + 4);
        // We are only required to send relayId and connId when values change.
        if (options.hello) {
            flags |= headerFlags.relayId;
            header.writeUInt32BE(this.relayId, headerOfft);
            headerOfft += 4;
        }
        if (options.hello && iv.connId !== undefined) {
            flags |= headerFlags.connId;
            header.writeUInt16BE(iv.connId, headerOfft);
            headerOfft += 2;
        }
        if ((options.hello && iv.seqno) || options.forceSeq) {
            flags |= headerFlags.seqno;
            header.writeUInt32BE(iv.seqno || 0, headerOfft);
            headerOfft += 4;
        }
        header.writeUInt8(flags, 0);
        return header.subarray(0, headerOfft);
    }

    establish() {
        if (!this._shutdownTimeout) {
            // We're scheduled for shutdown, don't enable watchdog..
            this._enableWatchdog();
        }
        this.active = true;
    }

    shutdown() {
        this._disableWatchdog();
        if (this.active !== false) {
            this.active = false;
            queueMicrotask(() => this.emit('shutdown', this));
        }
    }

    schedShutdown(time) {
        this._disableWatchdog();
        if (!this._shutdownTimeout) {
            this._shutdownTimeout = setTimeout(this.shutdown.bind(this), time);
        }
    }

    cancelShutdown() {
        clearTimeout(this._shutdownTimeout);
        this._shutdownTimeout = null;
        this._enableWatchdog();
    }

    _enableWatchdog() {
        if (!this._watchdogLoop) {
            this._watchdogLoop = setInterval(this._checkWatchdog.bind(this), this.timeout / 2);
        }
        this.tickleWatchdog();
    }

    _disableWatchdog() {
        if (this._watchdogLoop) {
            clearInterval(this._watchdogLoop);
            this._watchdogLoop = null;
        }
    }

    _checkWatchdog() {
        const elapsed = Date.now() - this._watchdogTS;
        if (elapsed > this.timeout) {
            this.tickleWatchdog();
            this.emit('timeout', this, elapsed);
        }
    }

    tickleWatchdog() {
        this._watchdogTS = Date.now();
    }

    makeDataPBAndBuffer(props) {
        const seqno = this._sendSeqno++;
        const pb = protos.ClientToServer.fromObject({seqno, ...props});
        return [pb, protos.ClientToServer.encode(pb).finish()];
    }

    makeHashBuf(dataBuf, options={}) {
        const hashSeed = options.hello ? defaultHashSeed : this.hashSeed;
        const hash = new XXHash32(hashSeed.seed);
        hash.update(dataBuf);
        hash.update(hashSeed.nonce);
        return hash.digest();
    }
}


class TCPChannel extends NetChannel {
    static _connInc = 0;

    constructor(options) {
        super({proto: 'tcp', ...options});
        this.conn = null;
    }

    async establish() {
        this.conn = net.createConnection({
            host: this.ip,
            port: 3025,
            timeout: 31000, // XXX maybe just use watchdog
            onread: {
                buffer: Buffer.alloc(65536),
                callback: this.onTCPData.bind(this),
            }
        });
        this.conn.setKeepAlive(true, 15000);
        await new Promise((resolve, reject) => {
            this.conn.once('connect', resolve);
            this.conn.once('error', reject);
        });
        this.conn.on('close', () => this.shutdown());
        this.conn.on('timeout', () => this.shutdown());
        this.conn.on('error', () => this.shutdown());
        super.establish();
    }

    shutdown() {
        super.shutdown();
        if (this.conn) {
            this.conn.removeAllListeners();
            this.conn.destroy();
            this.conn = null;
        }
    }

    onTCPData(nread, buf) {
        try {
            this._onTCPData(nread, buf);
        } catch(e) {
            console.error("TCP recv handler error:", e);
            this.incError();
        }
    }

    _onTCPData(nread, buf) {
        this.tickleWatchdog();
        this.recvCount++;
        const data = buf.subarray(0, nread);
        for (let offt = 0; offt < data.byteLength;) {
            let size;
            if (this.pendingSize) {
                size = this.pendingSize;
            } else {
                size = data.readUInt16BE(offt);
                offt += 2;
            }
            if (data.byteLength - offt + (this.pendingBuf ? this.pendingBuf.byteLength : 0) < size) {
                const dataCopy = Buffer.from(data.subarray(offt));
                offt += dataCopy.byteLength;
                if (!this.pendingBuf) {
                    this.pendingBuf = dataCopy;
                    this.pendingSize = size;
                } else {
                    // Yet-another-short-read.
                    this.pendingBuf = Buffer.concat([this.pendingBuf, dataCopy]);
                }
            } else {
                let completeBuf;
                if (this.pendingBuf) {
                    completeBuf = Buffer.concat([
                        this.pendingBuf,
                        data.subarray(offt, (offt += size - this.pendingBuf.byteLength))
                    ]);
                    this.pendingBuf = null;
                    this.pendingSize = null;
                    if (completeBuf.byteLength !== size) {
                        throw new Error("Assertion error about complete packet size");
                    }
                } else {
                    completeBuf = data.subarray(offt, (offt += size));
                }
                const plainBuf = this.decrypt(completeBuf);
                this.emit('inPacket', protos.ServerToClient.decode(plainBuf), this);
            }
        }
    }

    async sendPacket(props, options={}) {
        const [pb, dataBuf] = this.makeDataPBAndBuffer(props);
        const headerBuf = this.encodeHeader(options);
        const magic = Buffer.from([0x01, options.hello ? 0 : 1]);
        const hashBuf = this.makeHashBuf(dataBuf, options);
        const plainBuf = Buffer.concat([magic, dataBuf, hashBuf]);
        const cipherBuf = this.encrypt(headerBuf, plainBuf);
        const sizeBuf = Buffer.alloc(2);
        sizeBuf.writeUInt16BE(headerBuf.byteLength + cipherBuf.byteLength);
        const wireBuf = Buffer.concat([sizeBuf, headerBuf, cipherBuf]);
        await new Promise(resolve => this.conn.write(wireBuf, resolve));
        this.sendCount++;
        this.emit('outPacket', pb);
        return pb;
    }
}


class InactiveChannelError extends Error {}


class UDPChannel extends NetChannel {
    static _connInc = 0;

    constructor(options) {
        super({proto: 'udp', ...options});
        this.athleteId = options.athleteId;
        this.courseId = options.courseId;
        this.sock = null;
        this.isDirect = options.isDirect;
    }

    toString() {
        const world = this.courseId ? `${courseToNames[this.courseId]} (${this.courseId})` : 'UNATTACHED';
        return `<UDPChannel [${this.isDirect ? 'DIRECT' : 'LB'}] ${world}, ` +
            `connId: ${this.connId}, relayId: ${this.relayId}, recv: ${this.recvCount}, ip: ${this.ip}>`;
    }

    async establish() {
        this.sock = dgram.createSocket('udp4');
        this.sock.on('message', this.onUDPData.bind(this));
        this.sock.on('close', () => this.shutdown());
        this.sock.on('error', () => this.shutdown());
        await new Promise((resolve, reject) =>
            this.sock.connect(3024, this.ip, e => void (e ? reject(e) : resolve())));
        let syncStamps = new Map();
        let complete = false;
        const offsets = [];
        const syncComplete = new Promise(resolve => {
            const onPacket = packet => {
                const now = Date.now();
                const sent = syncStamps.get(packet.ackSeqno);
                const latency = (now - sent) / 2;
                const offt = now - packet._worldTime.toNumber() + latency;
                offsets.push({latency, offt});
                if (offsets.length === 5) {
                    // SNTP ...
                    offsets.sort((a, b) => a.latency - b.latency);
                    const mean = offsets.reduce((a, x) => a + x.latency, 0) / offsets.length;
                    const variance = offsets.map(x => (mean - x.latency) ** 2);
                    const stddev = Math.sqrt(variance.reduce((a, x) => a + x, 0) / variance.length);
                    const median = offsets[offsets.length / 2 | 0].latency;
                    const validOffsets = offsets.filter(x => Math.abs(x.latency - median) < stddev);
                    const meanOffset = validOffsets.reduce((a, x) => a + x.offt, 0) / validOffsets.length;
                    worldTime.setOffset(meanOffset);
                    this.off('inPacket', onPacket);
                    complete = true;
                    resolve();
                }
            };
            this.on('inPacket', onPacket);
        });
        for (let i = 0; i < 20 && !complete; i++) {
            // Send hankshake packets with `hello` option (full IV in AAD).  Even if they
            // are dropped the AES decrypt and IV state machine setup will succeed and pave the
            // way for sends that only require `seqno`, even with packet loss on this socket.
            //
            // The primary goal is to inform the servers we are here and ready for data,
            // but if our clock is too far off they will ignore us, so we need to sync our
            // worldTime offset too.  Some research on common game timer sync methods
            // suggests SNTP should be fine here.
            const ts = Date.now();
            const {seqno} = await this.sendPacket({
                athleteId: this.athleteId,
                realm: 1,
                _worldTime: 0,
            }, {hello: true});
            syncStamps.set(seqno, ts);
            await Promise.race([sleep(50 * i), syncComplete]);
        }
        if (!complete) {
            console.error("Timeout waiting for handshake sync:", this.toString());
            this.shutdown();
            return;
        }
        super.establish();
    }

    shutdown() {
        super.shutdown();
        if (this.sock) {
            this.sock.removeAllListeners();
            this.sock.close();
            this.sock = null;
        }
    }

    onUDPData(buf) {
        this.tickleWatchdog();
        this.recvCount++;
        const stc = protos.ServerToClient.decode(this.decrypt(buf));
        this.emit('inPacket', stc, this);
    }

    async sendPacket(props, options={}) {
        if (this.active === false) {
            throw new InactiveChannelError();
        }
        const [pb, dataBuf] = this.makeDataPBAndBuffer(props);
        const prefixBuf = options.dfPrefix ? Buffer.from([0xdf]) : Buffer.alloc(0);
        const headerBuf = this.encodeHeader({forceSeq: true, ...options});
        const hashBuf = this.makeHashBuf(dataBuf, options);
        const plainBuf = Buffer.concat([prefixBuf, dataBuf, hashBuf]);
        const cipherBuf = this.encrypt(headerBuf, plainBuf);
        const wireBuf = Buffer.concat([headerBuf, cipherBuf]);
        await new Promise((resolve, reject) =>
            this.sock.send(wireBuf, e => void (e ? reject(e) : resolve())));
        this.sendCount++;
        this.emit('outPacket', pb);
        return pb;
    }

    async sendPlayerState(state) {
        const _worldTime = worldTime.now();
        await this.sendPacket({
            athleteId: this.athleteId,
            realm: 1,
            _worldTime,
            state: {
                athleteId: this.athleteId,
                _worldTime,
                justWatching: true,
                x: 0,
                y: 0,
                altitude: 0,
                courseId: this.courseId,
                ...state,
            }
        }, {dfPrefix: true});
    }
}


export class GameMonitor extends events.EventEmitter {

    _stateRefreshDelayMin = 3000;
    _sessionRestartSlack = 300 * 1000;

    constructor(options={}) {
        super();
        this.api = options.zwiftMonitorAPI;
        this.athleteId = this.api.profile.id;
        this.randomWatch = options.randomWatch;
        this.gameAthleteId = options.gameAthleteId;
        this.watchingAthleteId = null;
        this.courseId = null;
        this._udpChannels = [];
        this._udpServerPools = new Map();
        this._starting = false;
        this._stopping = false;
        this._errCount = 0;
        this.connectingTS = 0;
        this.connectingCount = 0;
        this._session = null;
        this._setWatchingWorldTime = 0;
        this._lastGameStateUpdated = 0;
        this._lastWatchingStateUpdated = 0;
        this._stateRefreshDelay = this._stateRefreshDelayMin;
        worldTime.on('offset', diff => {
            const dev = Math.abs(diff);
            if (dev > 200) {
                // Otherwise we could be stuck watching the wrong athlete.
                this._setWatchingWorldTime = 0;
                if (dev > 5000) {
                    // Uses worldTime for expiration.
                    this._schedHashSeedsRefresh();
                }
            }
        });
        setInterval(() => console.info(this.toString()), 30000);
    }

    toString() {
        const tcpCh = (this._session && this._session.tcpChannel) ?
            this._session.tcpChannel.toString() :
            'none';
        const pad = '    ';
        const lgs = this._lastGameStateUpdated ? (Date.now() - this._lastGameStateUpdated | 0) : '- ';
        const lws = this._lastWatchingStateUpdated ? (Date.now() - this._lastWatchingStateUpdated | 0) : '- ';
        return `GameMonitor [game-id: ${this.gameAthleteId}, monitor-id: ${this.athleteId}]\n${pad}` + [
            `course-id:            ${this.courseId}`,
            `watching-id:          ${this.watchingAthleteId}`,
            `connect-duration:     ${(Date.now() - this.connectingTS) / 1000 | 0}s`,
            `connect-count:        ${this.connectingCount}`,
            `last-game-state:      ${lgs}ms ago`,
            `last-watching-state:  ${lws}ms ago`,
            `state-refresh-delay:  ${this._stateRefreshDelay | 0}ms`,
            `tcp-channel:`,        `${pad}${tcpCh}`,
            `udp-channels:`,       `${pad}${this._udpChannels.map(x => x.toString()).join(`\n${pad}${pad}`)}`,
        ].join('\n    ');
    }

    async login() {
        const aesKey = crypto.randomBytes(16);
        const login = await this.api.fetchPB('/api/users/login', {
            method: 'POST',
            pb: protos.LoginRequest.encode({aesKey}),
            protobuf: 'LoginResponse',
        });
        const expiresMonotonic = Date.now() + (login.expiration * 60 * 1000);
        await sleep(1000); // No joke this is required (100ms works about 50% of the time)
        return {
            aesKey,
            relayId: login.relaySessionId,
            tcpServers: login.session.tcpConfig.servers,
            expiresMonotonic,
        };
    }

    async getRandomAthleteId() {
        const inWorld = (await this.api.fetchJSON('/relay/worlds/1')).friendsInWorld;
        return inWorld[0].playerId;
    }

    async initPlayerState() {
        if (this.randomWatch) {
            this.gameAthleteId = await this.getRandomAthleteId();
        }
        const s = await this.api.getPlayerState(this.gameAthleteId);
        this.setCourse(s ? s.courseId : null);
        if (s) {
            this.setWatching(s.watchingAthleteId);
            if (s.watchingAthleteId === this.gameAthleteId) {
                // Optimize first connect when watching self (common) by allowing
                // setUDPChannel to use best UDP server immediately..
                this._setWatchingState(s);
            }
        } else {
            this.setWatching(this.gameAthleteId);
        }
    }

    async initHashSeeds() {
        this._hashSeeds = await this.api.getHashSeeds();
    }

    _schedHashSeedsRefresh(delay) {
        clearTimeout(this._refreshHashSeedsTimeout);
        if (this._stopping || (!delay && !this._hashSeeds.length)) {
            return;
        }
        if (!delay) {
            const lastHashExpires = this._hashSeeds.at(-1).expiresWorldTime;
            delay = (lastHashExpires - worldTime.now()) / 2;
        }
        console.info(`Next hash seeds refresh: ${delay / 1000 | 0}s`);
        this._refreshHashSeedsTimeout = setTimeout(this._refreshHashSeeds.bind(this), delay);
    }

    async _refreshHashSeeds() {
        if (this._stopping) {
            return;
        }
        const id = this._refreshHashSeedsTimeout;
        console.info("Refreshing hash seeds...");
        let delayFallback = 30000;
        try {
            this._hashSeeds = await this.api.getHashSeeds();
            delayFallback = null;
        } finally {
            if (!this._stopping && id === this._refreshHashSeedsTimeout) {
                this._schedHashSeedsRefresh(delayFallback);
            }
        }
    }

    start() {
        if (this._starting) {
            throw new TypeError('invalid state');
        }
        this._starting = true;
        console.info("Starting Zwift Game Monitor...");
        queueMicrotask(() => this.connect());
    }

    stop() {
        console.info("Stopping Zwift Game Monitor...");
        this._stopping = true;
        this.disconnect();
    }

    _setConnecting() {
        this.connectingTS = Date.now();
        this.connectingCount++;
    }

    async connect() {
        console.info("Connecting to Zwift relay servers...");
        try {
            await this._connect();
        } catch(e) {
            console.error('Connection attempt failed:', e);
            this._schedConnectRetry();
        }
    }

    async _connect() {
        this._setConnecting();
        const session = await this.login();
        await this.initHashSeeds();
        await this.initPlayerState();
        await this.establishTCPChannel(session);
        await this.activateSession(session);
        this._schedHashSeedsRefresh();
        this._refreshStatesTimeout = setTimeout(() => this._refreshStates(), this._stateRefreshDelay);
        this._playerStateInterval = setInterval(this.broadcastPlayerState.bind(this), 1000);
    }

    async renewSession() {
        if (!this._starting || this._stopping) {
            throw new TypeError('invalid state');
        }
        console.info("Renewing to Zwift relay session...");
        try {
            await this._renewSession();
        } catch(e) {
            console.error('Renew session attempt failed:', e);
            this._schedConnectRetry();
        }
    }

    async _renewSession() {
        this._setConnecting();
        const session = await this.login();
        await this.establishTCPChannel(session);
        await this.activateSession(session);
    }

    disconnect() {
        clearInterval(this._playerStateInterval);
        clearTimeout(this._sessionTimeout);
        clearTimeout(this._refreshHashSeedsTimeout);
        clearTimeout(this._refreshStatesTimeout);
        const channels = Array.from(this._udpChannels);
        this._udpChannels.length = 0;
        if (this._session && this._session.tcpChannel) {
            channels.push(this._session.tcpChannel);
            this._session.tcpChannel = null;
        }
        this._session = null;
        for (const ch of channels) {
            try {
                ch.shutdown();
            } catch(e) {
                console.error(e); // A little extra paranoid for now.
            }
        }
    }

    async establishTCPChannel(session) {
        const servers = session.tcpServers.filter(x => x.realm === 0 && x.courseId === 0);
        const ip = servers[0].ip;
        console.info(`Establishing TCP channel to:`, ip);
        session.tcpChannel = new TCPChannel({ip, session});
        session.tcpChannel.on('shutdown', this.onTCPChannelShutdown.bind(this));
        session.tcpChannel.on('inPacket', this.onInPacket.bind(this));
        await session.tcpChannel.establish();
    }

    makeUDPChannel(ip) {
        let isDirect = !!ip;
        if (!ip) {
            // Use a load balancer unless we have enough info for a direct server.
            ip = this._udpServerPools.get(0).servers[0].ip;
            const lws = this._lastWatchingState;
            if (lws && lws.courseId === this.courseId && worldTime.now() - lws.worldTime < 60000) {
                const best = this.findBestUDPServer(lws);
                if (best) {
                    ip = best.ip;
                    isDirect = true;
                }
            }
        }
        const hashSeed = this._hashSeeds.at(-1);
        const hashSeedRemaining = hashSeed.expiresWorldTime - worldTime.now();
        const sessionRemaining = this._session.expiresMonotonic - Date.now();
        const expiresIn = Math.min(
            hashSeedRemaining - 120 * 1000,
            sessionRemaining - this._sessionRestartSlack / 2);
        if (expiresIn < 0) {
            // Internal error
            console.error('Expired session or hash seeds:', expiresIn, hashSeedRemaining, sessionRemaining);
            throw new TypeError('Expired session or hash seeds');
        }
        const ch = new UDPChannel({
            ip,
            courseId: this.courseId,
            athleteId: this.athleteId,
            session: this._session,
            hashSeed,
            isDirect,
        });
        console.info(`Making new: ${ch} [expires in: ${expiresIn / 1000 | 0}s]`);
        const expireTimeout = setTimeout(() => ch.shutdown(), expiresIn);
        ch.on('shutdown', () => {
            console.info("Shutdown:", ch.toString());
            clearTimeout(expireTimeout);
            const i = this._udpChannels.indexOf(ch);
            if (i !== -1) {
                this._udpChannels.splice(i, 1);
                if (!this.suspended && this._session && (i === 0 || !this._udpChannels.length)) {
                    console.info("Last/primary channel shutdown");
                    this.setUDPChannel();
                }
            }
        });
        ch.on('inPacket', this.onInPacket.bind(this));
        ch.on('timeout', () => {
            console.warn("Data watchdog timeout triggered:", ch.toString());
            ch.shutdown();
        });
        return ch;
    }

    onTCPChannelShutdown(ch) {
        console.info("TCP channel shutdown:", ch.toString());
        if (this._session && this._session.tcpChannel === ch && !this._stopping) {
            this._schedConnectRetry();
        }
    }

    _schedConnectRetry() {
        clearTimeout(this._connectRetryTimeout);
        this.disconnect();
        const backoffCount = Math.max(this.connectingCount, this._errCount);
        const delay = Math.max(1000, (backoffCount * 1000) - (Date.now() - this.connectingTS));
        console.warn(`Next connect retry: ${delay / 1000 | 0}s`);
        this._connectRetryTimeout = setTimeout(this.connect.bind(this), delay);
    }

    async activateSession(session) {
        const udpServersPending = this._udpServerPools.size ||
            new Promise(resolve => this.once('udpServerPoolsUpdated', resolve));
        // This packet causes Zwift to close any other TCP connections for this athlete.
        // Also any UDP channels for those relay sessions will stop flowing.
        console.info("Activating session with:", session.tcpChannel.toString());
        await session.tcpChannel.sendPacket({
            athleteId: this.athleteId,
            _worldTime: 0,
            largWaTime: 0,
        }, {hello: true});
        if (udpServersPending) {
            await udpServersPending;
        }
        clearTimeout(this._sessionTimeout);
        this._session = session;
        const renewDelay = session.expiresMonotonic - Date.now() - this._sessionRestartSlack;
        console.info(`Session renewal scheduled for: ${renewDelay / 1000 | 0}s`);
        this._sessionTimeout = setTimeout(this.renewSession.bind(this), renewDelay);
        if (!this.suspended && this.courseId) {
            this.setUDPChannel();
        } else {
            console.warn("User not in game: waiting for activity...");
            this.suspend();
        }
    }

    incErrorCount() {
        this._errCount++;
        if (this._errCount % 10 === 0) {
            console.warn('Error count too high:', this._errCount);
            this._schedConnectRetry();
        }
    }

    async broadcastPlayerState() {
        if (this.suspended || this._stopping) {
            return;
        }
        for (const ch of this._udpChannels) {
            if (ch.active) {
                try {
                    await ch.sendPlayerState({watchingAthleteId: this.watchingAthleteId});
                    break;
                } catch(e) {
                    if (!(e instanceof InactiveChannelError)) {
                        console.error('SendPlayerState error:', e);
                        this.incErrorCount();
                    }
                }
            }
        }
    }

    suspend() {
        if (this.suspended) {
            return;
        }
        console.info("Suspending game monitor...");
        this.suspended = true;
        for (const x of this._udpChannels) {
            x.schedShutdown(30000);
        }
    }

    resume() {
        if (!this.suspended) {
            return;
        }
        this.suspended = false;
        if (this._stopping) {
            return;
        }
        console.info("Resuming game monitor...");
        if (this.courseId && !this._udpChannels.length) {
            this.setUDPChannel();
        }
    }

    async _refreshStates() {
        if (this._stopping) {
            return;
        }
        const id = this._refreshStatesTimeout;
        try {
            await this._refreshGameState();
            if (this.gameAthleteId !== this.watchingAthleteId) {
                await this._refreshWatchingState();
            }
            this._stateRefreshDelay = Math.max(this._stateRefreshDelayMin, this._stateRefreshDelay * 0.999);
        } catch(e) {
            this._stateRefreshDelay *= 1.15;
            if (e.status !== 429) {
                console.error("Refresh states error:", e);
            }
        }
        if (!this._stopping && id === this._refreshStatesTimeout) {
            this._refreshStatesTimeout = setTimeout(() => this._refreshStates(), this._stateRefreshDelay);
        }
    }

    async _refreshGameState() {
        const age = Date.now() - this._lastGameStateUpdated;
        if (age < this._stateRefreshDelay * 0.95) {
            // Optimized out by data stream
            return;
        }
        const state = await this.api.getPlayerState(this.gameAthleteId);
        if (!state) {
            if (!this.suspended && age > 15 * 1000) {
                // Stop harassing the UDP channel..
                this.suspend();
                if (this.randomWatch) {
                    this.gameAthleteId = await this.getRandomAthleteId();
                }
            }
        } else {
            // The stats proc works better with these being recently available.
            const stc = protos.ServerToClient.fromObject({
                athleteId: this.athleteId,
                _worldTime: state._worldTime,
            });
            stc.playerStates = [state];  // Assign after so our extensions work.
            this.emit('inPacket', stc);
            this._updateGameState(state);
            if (state.athleteId === this.watchingAthleteId) {
                this._updateWatchingState(state);
            }
        }
    }

    async _refreshWatchingState() {
        if (this.suspended || this._stopping ||
            Date.now() - this._lastWatchingStateUpdated < this._stateRefreshDelay * 0.95) {
            return;
        }
        console.warn("Fallback to API fetch of watching state:", this.watchingAthleteId);
        const state = await this.api.getPlayerState(this.watchingAthleteId);
        if (!state) {
            return;
        }
        // The stats proc works better with these being recently available.
        const stc = protos.ServerToClient.fromObject({
            athleteId: this.athleteId,
            _worldTime: state._worldTime,
        });
        stc.playerStates = [state];  // Assign after so our extensions work.
        this.emit('inPacket', stc);
        this._updateWatchingState(state);
    }

    setWatching(athleteId) {
        this._setWatchingWorldTime = worldTime.now();
        if (athleteId === this.watchingAthleteId) {
            return;
        }
        this.watchingAthleteId = athleteId;
        if (this.randomWatch) {
            this.gameAthleteId = athleteId;
        }
        this.emit("watching-athlete", athleteId);
    }

    _isChannelReusable(ch) {
        return !!(
            ch.active !== false &&
            ch.isDirect &&
            ch.courseId === this.courseId &&
            ch.hashSeed.expiresWorldTime - worldTime.now() > 60000 &&
            ch.relayId === this._session.relayId
        );
    }

    setUDPChannel(ip) {
        const reuseIndex = this._udpChannels.findIndex(x =>
            ip && ip === x.ip && this._isChannelReusable(x));
        if (reuseIndex === 0) {
            console.error("Redundant call to setUDPChannel");
            return;
        }
        const legacyCh = this._udpChannels[0];
        if (legacyCh) {
            if (this._isChannelReusable(legacyCh)) {
                legacyCh.schedShutdown(60000);
            } else {
                console.debug("Removing:", legacyCh.toString());
                queueMicrotask(() => legacyCh.shutdown());
            }
        }
        let ch;
        if (reuseIndex !== -1) {
            ch = this._udpChannels.splice(reuseIndex, 1)[0];
            ch.cancelShutdown();
            console.debug("Switching to:", ch.toString());
        } else {
            ch = this.makeUDPChannel(ip);
            queueMicrotask(() => this.establishUDPChannel(ch));
        }
        this._udpChannels.unshift(ch);
    }

    async establishUDPChannel(ch) {
        try {
            await ch.establish();
            await ch.sendPlayerState({watchingAthleteId: this.watchingAthleteId});
        } catch(e) {
            if (e instanceof InactiveChannelError) {
                console.warn("Channel became inactive during establish:", ch.toString(), e);
                return;
            }
            console.error('Error during UDP establish:', e);
            ch.shutdown();
            this.incErrorCount();
        }
        console.info(`Established:`, ch.toString());
    }


    onInPacket(pb, ch) {
        if (pb.multipleLogins) {
            console.error("Multiple logins detected!");
            this.emit('multiple-logins');
            this.stop();
            return;
        }
        if (pb.udpConfigVOD) {
            for (const x of pb.udpConfigVOD.pools) {
                this._udpServerPools.set(x.courseId, x);
            }
            queueMicrotask(() => this.emit('udpServerPoolsUpdated', this._udpServerPools));
        }
        for (let i = 0; i < pb.worldUpdates.length; i++) {
            const x = pb.worldUpdates[i];
            x.payloadType = protos.WorldUpdatePayloadType[x._payloadType];
            if (!x.payloadType) {
                console.warn("No enum type for:", x._payloadType);
            } else if (x.payloadType[0] !== '_') {
                const payloadProto = protos.get(x.payloadType);
                if (payloadProto) {
                    x.payload = protos.get(x.payloadType).decode(x._payload);
                } else {
                    const handler = binaryWorldUpdatePayloads[x.payloadType];
                    if (!handler) {
                        console.warn("No protobuf for:", x.payloadType, x._payload.toString('hex'));
                    } else {
                        x.payload = handler(x._payload, x.payloadType);
                    }
                }
            }
        }
        const dropList = [];
        for (let i = 0; i < pb.playerStates.length; i++) {
            const state = pb.playerStates[i] = processPlayerStateMessage(pb.playerStates[i]);
            if (state.athleteId === this.gameAthleteId) {
                queueMicrotask(() => this._updateGameState(state));
            } else if (state.activePowerUp === 'NINJA') {
                dropList.unshift(i);
            }
            if (state.athleteId === this.watchingAthleteId) {
                queueMicrotask(() => this._updateWatchingState(state));
            }
        }
        if (dropList.length) {
            for (const i of dropList) {
                pb.playerStates.splice(i, 1);
            }
        }
        queueMicrotask(() => this.emit('inPacket', pb));
    }

    _updateGameState(state) {
        if (this._lastGameState && this._lastGameState.worldTime >= state.worldTime) {
            return;
        }
        this._lastGameState = state;
        this._lastGameStateUpdated = Date.now();
        if (this._stopping) {
            return;
        }
        if (this.suspended) {
            this.resume();
        }
        if (state.watchingAthleteId !== this.watchingAthleteId &&
            state.worldTime > this._setWatchingWorldTime) {
            this.setWatching(state.watchingAthleteId);
        }
        if (state.courseId !== this.courseId) {
            this.setCourse(state.courseId);
        }
    }

    setCourse(courseId) {
        this.courseId = courseId;
        if (courseId) {
            console.info(`Moving to ${courseToNames[courseId]}, courseId: ${courseId}`);
            //this.api.setInGameFields({worldId: courseToWorldIds[courseId]});  // bg ok
            if (this._session) {
                this.setUDPChannel();
            }
        }
    }

    _setWatchingState(state) {
        const lws = this._lastWatchingState;
        if (lws && lws.worldTime >= state.worldTime) {
            // Dedup & filter stale
            return false;
        }
        if (state.courseId !== this.courseId) {
            console.warn('Ignoring incongruent courseId for watching state:',
                state.courseId, this.courseId);
            return false;
        }
        this._lastWatchingState = state;
        this._lastWatchingStateUpdated = Date.now();
        const age = lws ? state.worldTime - lws.worldTime : 0;
        const connectTime = Date.now() - this.connectingTS;
        const active = state._speed || state.power || state._cadenceUHz;
        if (age > 3000 && connectTime > 30000 && active) {
            console.warn(`Slow watching state update: ${age}ms`, state);
        }
    }

    _updateWatchingState(state) {
        const isValid = this._setWatchingState(state) !== false;
        if (!isValid || !this._session) {
            return;
        }
        const curCh = this._udpChannels[0];
        if (curCh) {
            const best = this.findBestUDPServer(state);
            if (best && (best.ip !== curCh.ip || !curCh.isDirect)) {
                this.setUDPChannel(best.ip);
            }
        } else {
            console.info("Recovering UDP channel...");
            this.setUDPChannel();
        }
    }

    findBestUDPServer({x, y, courseId}) {
        if (!this._udpServerPools.has(courseId)) {
            return;
        }
        const pool = this._udpServerPools.get(courseId);
        if (pool.useFirstInBounds) {
            return pool.servers.find(server => x <= server.xBound && y <= server.yBound);
        } else {
            let closestServer;
            let closestDelta = Infinity;
            for (const server of pool.servers) {
                const xDelta = server.xBound - x;
                const yDelta = server.yBound - y;
                // Can simplify the sqrt out since we only need the winner
                const delta = xDelta * xDelta + yDelta * yDelta;
                if (delta < closestDelta) {
                    closestDelta = delta;
                    closestServer = server;
                }
            }
            return closestServer;
        }
    }
}


export class GameConnectionServer extends net.Server {
    constructor({ip, zwiftAPI}) {
        super();
        this.ip = ip;
        this.api = zwiftAPI;
        this._socket = null;
        this._msgSize = null;
        this._msgOfft = 0;
        this._msgBuf = null;
        this._seqno = 1;
        this._cmdSeqno = 1;
        this.athleteId = zwiftAPI.profile.id;
        this.on('connection', this.onConnection.bind(this));
        this.on('error', this.onError.bind(this));
        this.listenDone = new Promise(resolve => this.listen({address: this.ip, port: 0}, resolve));
        this._state = 'init';
        const gct = protos.GameToCompanionCommandType;
        this._commandHandlers = {
            [gct.CLEAR_POWER_UP]: this.onUnhandledCommand,
            [gct.SET_POWER_UP]: this.onPowerupSetCommand,
            [gct.ACTIVATE_POWER_UP]: this.onPowerupActivateCommand,
            [gct.CUSTOMIZE_ACTION_BUTTON]: this.onCustomActionButtonCommand,
            [gct.SEND_IMAGE]: this.onUnhandledCommand,
            [gct.SOCIAL_PLAYER_ACTION]: this.onSocialPlayerActionCommand,
            [gct.DONT_USE_MOBILE_ALERT]: this.onUnhandledCommand,
            [gct.BLEPERIPHERAL_REQUEST]: this.onUnhandledCommand,
            [gct.PAIRING_STATUS]: this.onIgnoringCommand,
            [gct.MOBILE_ALERT_CANCEL]: this.onUnhandledCommand,
            [gct.DEFAULT_ACTIVITY_NAME]: this.onUnhandledCommand,
            [gct.MOBILE_ALERT]: this.onUnhandledCommand,
            [gct.PACKET]: this.onPacketCommand,
        };
        const gpt = protos.GamePacketType;
        this._gamePacketHandlers = {
            [gpt.SPORTS_DATA_REQUEST]: this.onUnhandledPacket,
            [gpt.SPORTS_DATA_RESPONSE]: this.onUnhandledPacket,
            [gpt.GAME_SESSION_INFO]: this.onUnhandledPacket,
            [gpt.GAME_SESSION_INFO]: this.onUnhandledPacket,
            [gpt.MAPPING_DATA]: this.onIgnoringPacket,
            [gpt.INTERSECTION_AHEAD]: this.onUnhandledPacket,
            [gpt.PLAYER_INFO]: this.onUnhandledPacket,
            [gpt.RIDE_ON_BOMB_REQUEST]: this.onUnhandledPacket,
            [gpt.RIDE_ON_BOMB_RESPONSE]: this.onUnhandledPacket,
            [gpt.EFFECT_REQUEST]: this.onUnhandledPacket,
            [gpt.WORKOUT_INFO]: this.onUnhandledPacket,
            [gpt.WORKOUT_STATE]: this.onUnhandledPacket,
            [gpt.PLAYER_FITNESS_INFO]: this.onUnhandledPacket,
            [gpt.WORKOUT_ACTION_REQUEST]: this.onUnhandledPacket,
            [gpt.CLIENT_ACTION]: this.onUnhandledPacket,
            [gpt.MEETUP_STATE]: this.onUnhandledPacket,
            [gpt.SEGMENT_RESULT_ADD]: this.onIgnoringPacket,
            [gpt.SEGMENT_RESULT_REMOVE]: this.onIgnoringPacket,
            [gpt.SEGMENT_RESULT_NEW_LEADER]: this.onIgnoringPacket,
            [gpt.PLAYER_ACTIVE_SEGMENTS]: this.onUnhandledPacket,
            [gpt.PLAYER_STOPWATCH_SEGMENT]: this.onUnhandledPacket,
            [gpt.BOOST_MODE_STATE]: this.onUnhandledPacket,
            [gpt.GAME_ACTION]: this.onUnhandledPacket,
        };
    }

    onPacketCommand(command) {
        const gp = command.gamePacket;
        const handler = this._gamePacketHandlers[gp.type];
        if (!handler) {
            console.error("Unexpected packet type:", gp.type, gp);
            return;
        }
        handler.call(this, gp, command);
    }

    onUnhandledCommand(command, gtc, buf) {
        console.debug('Unhandled command', command);
        console.debug(buf.toString('hex'));
        console.debug(JSON.stringify(command.toJSON(), null, 2));
    }

    onIgnoringCommand() {}

    onPowerupSetCommand(command) {
        this.emit('powerup-set', command);
    }

    onPowerupActivateCommand(command) {
        // NOTE this is fired on connection establish when we don't have a powerup.
        // Effectively clearing the powerup for UI purposes.
        this.emit('powerup-activate', command);
    }

    onCustomActionButtonCommand(command) {
        if (command.customActionSubCommand === 23) {
            return;
        }
        const info = {button: command.customActionButton};
        if (info.button === 'HUD') {
            info.state = command.customActionSubCommand === 1080 ? false : true;
        }
        console.info("Custom action!!!", info, command.toJSON());
        this.emit('custom-action-button', info, command);
    }

    onSocialPlayerActionCommand(command) {
        const sa = command.socialAction;
        if (sa.type === protos.SocialPlayerActionType.TEXT_MESSAGE) {
            this.emit('chat', sa, command);
        } else if (sa.type === protos.SocialPlayerActionType.RIDE_ON) {
            this.emit('rideon', sa, command);
        } else if (sa.type === protos.SocialPlayerActionType.FLAG) {
            this.emit('flag', sa, command);
        }
    }


    onUnhandledPacket(packet) {
        console.debug('unhandled packet', packet.toJSON());
    }

    onIgnoringPacket() {}

    async start() {
        try {
            await this._start();
        } catch(e) {
            this._state = 'error';
            this._error = e;
            throw e;
        }
    }

    async _start() {
        await this.listenDone;
        this._state = 'ready';
        const {port} = this.address();
        console.info("Registering game connnection server:", this.ip, port);
        this.port = port;
        await this.api.fetch('/relay/profiles/me/phone', {
            method: 'PUT',
            json: {
                phoneAddress: this.ip,
                port,
                protocol: 'TCP',
            }
        });
        this._state = 'waiting';
    }

    async changeCamera() {
        await this.sendCommands({type: 'CHANGE_CAMERA_ANGLE'});
    }

    async elbow() {
        await this.sendCommands({type: 'ELBOW_FLICK'});
    }

    async wave() {
        await this.sendCommands({type: 'WAVE'});
    }

    async powerup() {
        await this.sendCommands({type: 'ACTIVATE_POWER_UP'});
    }

    async say(what) {
        const type = {
            rideon: 'RIDE_ON',
            bell: 'BELL',
            hammertime: 'HAMMER_TIME',
            toast: 'TOAST',
            nice: 'NICE',
            bringit: 'BRING_IT',
        }[what];
        if (!type) {
            throw new TypeError(`Invalid say type: ${type}`);
        }
        await this.sendCommands({type});
    }

    async ringBell() {
        await this.sendCommands({type: 'BELL'});
    }

    async endRide() {
        await this.sendCommands({type: 'DONE_RIDING'});
    }

    async takePicture() {
        await this.sendCommands({type: 'TAKE_SCREENSHOT'});
    }

    async enableHUD(en=true) {
        await this._hud(en);
    }

    async disableHUD(en=false) {
        await this._hud(en);
    }

    async _hud(en=true) {
        await this.sendCommands({
            type: 'CUSTOM_ACTION',
            subCommand: en ? 1080 : 1081,
        });
    }

    async toggleGraphs() {
        await this.sendCommands({
            type: 'CUSTOM_ACTION',
            subCommand: 1060,
        });
    }

    async turnLeft() {
        await this.sendCommands({
            type: 'CUSTOM_ACTION',
            subCommand: 1010,
        });
    }

    async goStraight() {
        await this.sendCommands({
            type: 'CUSTOM_ACTION',
            subCommand: 1011,
        });
    }

    async turnRight() {
        await this.sendCommands({
            type: 'CUSTOM_ACTION',
            subCommand: 1012,
        });
    }

    async reverse() {
        await this.sendCommands({type: 'U_TURN'});
    }

    async chatMessage(message, options={}) {
        const p = this.api.profile;
        await this.sendCommands({
            type: 'SOCIAL_PLAYER_ACTION',
            socialAction: {
                athleteId: p.id,
                spaType: protos.SocialPlayerActionType.TEXT_MESSAGE,
                firstName: p.firstName,
                lastName: p.lastName,
                avatar: p.imageSrcLarge || p.imageSrc,
                countryCode: p.countryCode,
                msgType: protos.MessageGroupType.GLOBAL, // XXX if we're in an event use that mode
                toAthleteId: options.to || 0,
                message,
            }
        });
    }

    async watch(id) {
        await this.sendCommands({
            type: 'FAN_VIEW',
            subject: id,
        });
        this.emit('watch-command', id);
    }

    async gamePacket(gamePacket) {
        await this.sendCommands({
            type: 'PHONE_TO_GAME_PACKET',
            gamePacket,
        });
    }

    async join(id) {
        await this.sendCommands({
            type: 'JOIN_ANOTHER_PLAYER',
            subject: id,
        });
    }

    async teleportHome() {
        await this.sendCommands({type: 'TELEPORT_TO_START'});
    }

    async sendCommands(...commands) {
        return await this._send({
            commands: commands.map(x => {
                const type = typeof x.type === 'number' ? x.type :
                    protos.CompanionToGameCommandType[x.type];
                if (!type) {
                    throw new TypeError(`Invalid command type: ${x.type}`);
                }
                return {
                    seqno: this._cmdSeqno++,
                    ...x,
                    type,
                };
            })
        });
    }

    async _send(o) {
        const seqno = this._seqno++;
        const payload = {
            athleteId: this.athleteId,
            seqno,
            ...o,
        };
        console.debug('sneding', JSON.stringify(payload, null, 2));
        const pb = protos.CompanionToGame.encode(payload).finish();
        const size = Buffer.alloc(4);
        size.writeUInt32BE(pb.byteLength);
        this._socket.write(size);
        await new Promise(resolve => {
            this._socket.write(pb, resolve);
        });
        return seqno;
    }

    async onConnection(socket) {
        console.info('Game connection established from:', socket.remoteAddress);
        this._socket = socket;
        this._state = 'connected';
        this._error = null;
        socket.on('data', this.onData.bind(this));
        socket.on('end', this.onSocketEnd.bind(this));
        socket.on('error', this.onSocketError.bind(this));
        this.emit('status', this.getStatus());
        //await this.sendCommands({
        //    type: 'PAIRING_AS',
        //    athleteId: this.athleteId,
        //});
    }

    getStatus() {
        const connected = !!this._socket;
        return {
            connected,
            port: this.port,
            state: this._state,
            error: this._state === 'error' ? this._error.message : undefined,
        };
    }

    onError(e) {
        console.error('Game connection server error:', e);
        this._socket = null;
        this._state = 'error';
        this._error = e;
        this.emit('status', this.getStatus());
    }

    onData(buf) {
        if (!this._msgBuf) {
            this._msgSize = buf.readUint32BE(0);
            this._msgOfft = 0;
            this._msgBuf = Buffer.alloc(this._msgSize);
            buf = buf.slice(4);
        }
        const end = this._msgSize - this._msgOfft;
        buf.copy(this._msgBuf, this._msgOfft, 0, end);
        this._msgOfft += Math.min(end, buf.byteLength);
        if (this._msgOfft === this._msgSize) {
            this.onMessage();
            if (end < buf.byteLength) {
                this.onData(buf.slice(end));
            }
        }
    }

    onMessage() {
        const buf = this._msgBuf;
        this._msgBuf = null;
        //console.debug(buf.toString('hex'));
        try {
            const gtc = protos.GameToCompanion.decode(buf);
            if (gtc.playerState) {
                queueMicrotask(() => this.emit('outgoing-player-state', gtc.playerState));
            }
            for (const x of gtc.commands) {
                const handler = this._commandHandlers[x.type];
                if (!handler) {
                    console.error("Invalid command type:", x.type, x);
                } else {
                    queueMicrotask(() => handler.call(this, x, gtc, /*XXX*/ buf));
                }
            }
        } catch(e) {
            console.error("Invalid protobuf:", e);
        }
    }

    onSocketEnd() {
        console.info("Game connection ended");
        this._socket = null;
        this._state = 'disconnected';
        this.emit('status', this.getStatus());
    }

    onSocketError(e) {
        console.error("Game connection network error:", e);
        this._socket = null;
        this._state = 'error';
        this._error = e;
        this.emit('status', this.getStatus());
    }
}
