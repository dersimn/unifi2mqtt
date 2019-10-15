#!/usr/bin/env node

/* eslint-disable camelcase */

const pkg = require('./package.json');
const log = require('yalm');
const config = require('yargs')
    .env('UNIFI2MQTT')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('mqtt-url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('unifi-host', 'unifi hostname or address')
    .describe('unifi-port', 'unifi port')
    .describe('unifi-user', 'unifi user')
    .describe('unifi-password', 'unifi password')
    .describe('unifi-site', 'allow ssl connections with invalid certs')
    .describe('insecure', 'unifi site')
    .alias({
        h: 'help',
        n: 'name',
        u: 'mqtt-url',
        v: 'verbosity',
        a: 'unifi-host',
        p: 'unifi-port',
        c: 'unifi-user',
        s: 'unifi-password',
        w: 'unifi-site',
        k: 'insecure'
    })
    .default({
        'name': 'unifi',
        'mqtt-url': 'mqtt://127.0.0.1',
        'unifi-host': '127.0.0.1',
        'unifi-port': 8443,
        'unifi-user': 'admin',
        'unifi-site': 'default'
    })
    .demand('unifi-password')
    .env()
    .version()
    .help('help')
    .argv;

const Unifi = require('ubnt-unifi');
const MqttSmarthome = require('mqtt-smarthome-connect');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

let mqttConnected;
let unifiConnected = false;
let retainedClientsTimeout;
let numClients = {};
const retainedClients = {};
const idWifi = {};
const dataWifi = {};
const idDevice = {};
const dataDevice = {};

log.info('mqtt trying to connect', config.mqttUrl);

const mqtt = new MqttSmarthome(config.mqttUrl, {
    logger: log,
    will: {topic: config.name + '/maintenance/online', payload: 'false', retain: true}
});
mqtt.connect();

mqtt.on('connect', () => {
    log.info('mqtt connected', config.mqttUrl);
    mqtt.publish(config.name + '/maintenance/online', true, {retain: true});
    mqtt.publish(config.name + '/maintenance/controller/online', unifiConnected, {retain: true});
});

mqtt.on('close', () => {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.mqttUrl);
    }
});

mqtt.on('error', err => {
    log.error('mqtt', err);
});

function unifiConnect(connected) {
    if (unifiConnected !== connected) {
        unifiConnected = connected;
        mqtt.publish(config.name + '/maintenance/controller/online', unifiConnected, {retain: true});
        if (unifiConnected) {
            log.info('unifi connected');
            getWifiNetworks()
                .then(getDevices)
                .then(getClients);
        } else {
            log.info('unifi disconnected');
        }
    }
}

log.info('trying to connect https://' + config.unifiHost + ':' + config.unifiPort);
const unifi = new Unifi({
    host: config.unifiHost,
    port: config.unifiPort,
    username: config.unifiUser,
    password: config.unifiPassword,
    site: config.unifiSite,
    insecure: config.insecure
});

log.info('mqtt subscribe', config.name + '/set/#');
mqtt.subscribe(config.name + '/set/#', (topic, val) => {
    const parts = topic.split('/');

    if (parts[1] === 'set' && parts[2] === 'device' && parts[4] === 'led') {
        // Set device led override mode
        if (val === 'on' || val === true || ((typeof val === 'number') && val)) {
            val = 'on';
        } else if (val === 'off' || val === false || ((typeof val === 'number') && !val)) {
            val = 'off';
        } else {
            val = 'default';
        }
        if (idDevice[parts[3]]) {
            log.debug('unifi > rest/device/' + idDevice[parts[3]], {led_override: val});
            unifi.put('rest/device/' + idDevice[parts[3]], {led_override: val}).then(getDevices);
        } else {
            log.warn('unknown device', parts[3]);
        }
    } else if (parts[1] === 'set' && parts[2] === 'wifi' && parts[4] === 'enabled') {
        // Set wireless network enable/disable
        if (idWifi[parts[3]]) {
            log.debug('unifi > upd/wlanconf/' + idWifi[parts[3]], {enabled: Boolean(val)});
            unifi.post('upd/wlanconf/' + idWifi[parts[3]], {enabled: Boolean(val)}).then(() => {
                setTimeout(getWifiNetworks, 5000);
            });
        } else {
            log.warn('unknown wireless network', parts[3]);
        }
    }
});

log.info('mqtt subscribe', config.name + '/status/wifi/+/client/+');
mqtt.subscribe(config.name + '/status/wifi/+/client/+', (topic, val) => {
    const parts = topic.split('/');

    if (parts[1] === 'status' && parts[2] === 'wifi' && parts[4] === 'client') {
        // Retained client status
        clearTimeout(retainedClientsTimeout);
        retainedClientsTimeout = setTimeout(clientsReceived, 2000);
        try {
            const {val} = JSON.parse(payload);
            if (val) {
                if (retainedClients[parts[3]]) {
                    retainedClients[parts[3]].push(parts[5]);
                } else {
                    retainedClients[parts[3]] = [parts[5]];
                }
            }
        } catch (err) {
            log.error(topic, payload, err);
        }
    }
});
retainedClientsTimeout = setTimeout(clientsReceived, 2000);

function clientsReceived() {
    log.info('retained clients received');
    log.info('mqtt unsubscribe', config.name + '/status/wifi/+/client/+');
    mqtt.unsubscribe(config.name + '/status/wifi/+/client/+');
    mqttConnected = true;
}

function getWifiNetworks() {
    return new Promise(resolve => {
        log.debug('unifi > rest/wlanconf');
        unifi.get('rest/wlanconf').then(res => {
            res.data.forEach(wifi => {
                dataWifi[wifi._id] = wifi;
                idWifi[wifi.name] = wifi._id;
                mqtt.publish(config.name + '/status/wifi/' + wifi.name + '/enabled', {val: wifi.enabled}, {retain: true});
            });
            log.debug('unifi got', res.data.length, 'wifi networks');
            resolve();
        });
    });
}

function getDevices() {
    return new Promise(resolve => {
        log.debug('unifi > stat/device');
        unifi.get('stat/device').then(res => {
            res.data.forEach(dev => {
                dataDevice[dev._id] = dev;
                idDevice[dev.name] = dev._id;
                mqtt.publish(config.name + '/status/device/' + dev.name + '/led', {val: dev.led_override}, {retain: true});
            });
            log.debug('unifi got', res.data.length, 'devices');
            resolve();
        });
    });
}

function getClients() {
    if (!mqttConnected) {
        setTimeout(getClients, 1000);
        return;
    }
    numClients = {};
    log.info('unifi > stat/sta');
    unifi.get('stat/sta').then(clients => {
        clients.data.forEach(client => {
            if (numClients[client.essid]) {
                numClients[client.essid] += 1;
            } else {
                numClients[client.essid] = 1;
            }
            mqtt.publish([config.name, 'status', 'wifi', client.essid, 'client', client.hostname].join('/'), {val: true, mac: client.mac, ts: (new Date()).getTime()}, {retain: true});
            if (retainedClients[client.essid]) {
                const index = retainedClients[client.essid].indexOf(client.hostname);
                if (index > -1) {
                    retainedClients[client.essid].splice(index, 1);
                }
            }
        });
        Object.keys(retainedClients).forEach(essid => {
            retainedClients[essid].forEach(hostname => {
                mqtt.publish([config.name, 'status', 'wifi', essid, 'client', hostname].join('/'), {val: false, ts: (new Date()).getTime()}, {retain: true});
            });
        });
        wifiInfoPub();
    });
}

unifi.on('ctrl.connect', () => {
    unifiConnect(true);
});

unifi.on('ctrl.disconnect', () => {
    unifiConnect(false);
});

unifi.on('ctrl.error', err => {
    log.error(err.message);
});

unifi.on('*.disconnected', data => {
    log.debug('unifi <', data);
    if (numClients[data.ssid]) {
        numClients[data.ssid] -= 1;
    } else {
        numClients[data.ssid] = 0;
    }
    wifiInfoPub();
    mqtt.publish([config.name, 'status', 'wifi', data.ssid, 'client', data.hostname].join('/'), {val: false, mac: data.user, ts: data.time}, {retain: true});
});

unifi.on('*.connected', data => {
    log.debug('unifi <', data);
    if (numClients[data.ssid]) {
        numClients[data.ssid] += 1;
    } else {
        numClients[data.ssid] = 1;
    }
    wifiInfoPub();
    mqtt.publish([config.name, 'status', 'wifi', data.ssid, 'client', data.hostname].join('/'), {val: true, mac: data.user, ts: data.time}, {retain: true});
});

unifi.on('*.roam', data => {
    log.debug('unifi <', data);
});

unifi.on('*.roam_radio', data => {
    log.debug('unifi <', data);
});

unifi.on('ap.detect_rogue_ap', data => {
    log.debug('unifi <', data);
});

unifi.on('ad.update_available', data => {
    log.debug('unifi <', data);
});

function wifiInfoPub() {
    let sum = 0;
    const ts = (new Date()).getTime();
    Object.keys(idWifi).forEach(ssid => {
        numClients[ssid] = numClients[ssid] || 0;
        sum += numClients[ssid];
        mqtt.publish([config.name, 'status', 'wifi', ssid, 'clientCount'].join('/'), {val: numClients[ssid], ts}, {retain: true});
        mqtt.publish([config.name, 'status', 'wifi', ssid, 'enabled'].join('/'), {val: dataWifi[idWifi[ssid]].enabled, ts}, {retain: true});
    });
    mqtt.publish([config.name, 'status', 'clientCount'].join('/'), {val: sum, ts}, {retain: true});
}
