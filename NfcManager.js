'use strict';
import {
  Platform
} from 'react-native'
import ByteParser from './ByteParser'
import NdefParser from './NdefParser'
import Ndef from './ndef-lib'
import {NativeNfcManager, NfcManagerEmitter} from './NativeNfcManager'

const DEFAULT_REGISTER_TAG_EVENT_OPTIONS = {
  alertMessage: 'Please tap NFC tags',
  invalidateAfterFirstRead: false,
  isReaderModeEnabled: false,
  readerModeFlags: 0,
};

const NfcEvents = {
  DiscoverTag: 'NfcManagerDiscoverTag',
  SessionClosed: 'NfcManagerSessionClosed',
  StateChanged: 'NfcManagerStateChanged',
}

const NfcTech = {
  Ndef: 'Ndef',
  NfcA: 'NfcA',
  NfcB: 'NfcB',
  NfcF: 'NfcF',
  NfcV: 'NfcV',
  IsoDep: 'IsoDep',
  MifareClassic: 'MifareClassic',
  MifareUltralight: 'MifareUltralight',
  MifareIOS: 'mifare',
}

const NfcAdapter = {
  FLAG_READER_NFC_A: 0x1,
  FLAG_READER_NFC_B: 0x2,
  FLAG_READER_NFC_F: 0x4,
  FLAG_READER_NFC_V: 0x8,
  FLAG_READER_NFC_BARCODE: 0x10,
  FLAG_READER_SKIP_NDEF_CHECK: 0x80,
  FLAG_READER_NO_PLATFORM_SOUNDS: 0x100,
};

function callNative(name, params=[]) {
  const nativeMethod = NativeNfcManager[name];

  if (!nativeMethod) {
    throw new Error(`no sucm native method: "${name}"`);
  }

  if (!Array.isArray(params)) {
    throw new Error(`params must be an array`);
  }

  const createCallback = (resolve, reject) => (err, result) => {
    if (err) {
      reject(err);
    } else {
      resolve(result);
    }
  };

  return new Promise((resolve, reject) => {
    const callback = createCallback(resolve, reject);
    const inputParams = [...params, callback];
    nativeMethod(...inputParams);
  });
}

class NfcManager {
  constructor() {
    this.cleanUpTagRegistration = false;
    this._subscribeNativeEvents();

    // legacy stuff
    this._clientTagDiscoveryListener = null;
    this._clientSessionClosedListener = null;
    this._subscription = null;
  }

  // -------------------------------------
  // public for both platforms
  // -------------------------------------
  setEventListener = (name, callback) => {
    const allNfcEvents = Object.keys(NfcEvents).map(k => NfcEvents[k]);
    if (allNfcEvents.indexOf(name) === -1) {
      throw new Error('no such event');
    }

    this._clientListeners[name] = callback;
  }

  get MIFARE_BLOCK_SIZE() { return NativeNfcManager.MIFARE_BLOCK_SIZE };
	get MIFARE_ULTRALIGHT_PAGE_SIZE() { return NativeNfcManager.MIFARE_ULTRALIGHT_PAGE_SIZE };
	get MIFARE_ULTRALIGHT_TYPE() { return NativeNfcManager.MIFARE_ULTRALIGHT_TYPE };
	get MIFARE_ULTRALIGHT_TYPE_C() { return NativeNfcManager.MIFARE_ULTRALIGHT_TYPE_C };
	get MIFARE_ULTRALIGHT_TYPE_UNKNOWN() { return NativeNfcManager.MIFARE_ULTRALIGHT_TYPE_UNKNOWN };

  start = () => callNative('start');

  isSupported = (tech = '') => callNative('isSupported', [tech]);

  registerTagEvent = (options = {}) => {
    const optionsWithDefault = {
      ...DEFAULT_REGISTER_TAG_EVENT_OPTIONS,
      ...options,
    };

    return callNative('registerTagEvent', [optionsWithDefault]);
  }

  unregisterTagEvent = () => callNative('unregisterTagEvent');

  getTag = () => callNative('getTag');

  requestTechnology = async (tech, options={}) => {
    try {
      if (typeof tech === 'string') {
        tech = [tech];
      }

      let hasNdefTech = tech.indexOf(NfcTech.Ndef) !== -1;
      let sessionAvailable = false;

      // check if required session is available
      if (Platform.OS === 'ios') {
        if (hasNdefTech) {
          sessionAvailable = await this._isSessionAvailableIOS();
        } else {
          sessionAvailable = await this._isSessionExAvailableIOS();
        }
      } else {
        sessionAvailable = await this._hasTagEventRegistrationAndroid();
      }

      // make sure we do register for tag event 
      if (!sessionAvailable) {
        if (Platform.OS === 'ios') {
          if (hasNdefTech) {
            await this.registerTagEvent(options);
          } else {
            await this._registerTagEventExIOS(options);
          }
        } else {
          await this.registerTagEvent(options);
        }

        // the tag registration is 
        this.cleanUpTagRegistration = true;
      }

      return callNative('requestTechnology', [tech]);
    } catch (ex) {
      throw ex;
    }
  }

  cancelTechnologyRequest = async () => {
    await callNative('cancelTechnologyRequest');

    if (this.cleanUpTagRegistration) {
      this.cleanUpTagRegistration = false;

      if (Platform.OS === 'ios') {
        let sessionAvailable = false;

        // because we don't know which tech currently requested
        // so we try both, and perform early return when hitting any
        sessionAvailable = await this._isSessionExAvailableIOS();
        if (sessionAvailable) {
          await this._unregisterTagEventExIOS();
          return;
        }

        sessionAvailable = await this._isSessionAvailableIOS();
        if (sessionAvailable) {
          await this.unregisterTagEvent();
          return;
        }
      } else {
        await this.unregisterTagEvent();
        return;
      }
    }
  }

  // -------------------------------------
  // public only for Android
  // -------------------------------------
  isEnabled = () => callNative('isEnabled');

  goToNfcSetting = () => callNative('goToNfcSetting');

  getLaunchTagEvent = () => callNative('getLaunchTagEvent');

  setNdefPushMessage = (bytes) => callNative('setNdefPushMessage', [bytes]);

  // -------------------------------------
  // public only for iOS
  // -------------------------------------
  setAlertMessageIOS = (alertMessage) => callNative('setAlertMessageIOS', [alertMessage]);

  invalidateSessionWithErrorIOS = (errorMessage='Error') => callNative('invalidateSessionWithError', [errorMessage]);

  // -------------------------------------
  // NfcTech.Ndef API
  // -------------------------------------
  writeNdefMessage = (bytes) => callNative('writeNdefMessage', [bytes]);

  getNdefMessage = () => callNative('getNdefMessage');

  // -------------------------------------
  // (android) NfcTech.Ndef API
  // -------------------------------------
  getCachedNdefMessageAndroid = () => callNative('getCachedNdefMessage');

  makeReadOnlyAndroid = () => callNative('makeReadOnly');

  // -------------------------------------
  // (android) tNfcTech.MifareClassic API
  // -------------------------------------
  mifareClassicAuthenticateA = (sector, key) => {
    if (!key || !Array.isArray(key) || key.length !== 6) {
      return Promise.reject('key should be an Array[6] of integers (0 - 255)');
    }

    return callNative('mifareClassicAuthenticateA', [sector, key]);
  }

  mifareClassicAuthenticateB = (sector, key) => {
    if (!key || !Array.isArray(key) || key.length !== 6) {
      return Promise.reject('key should be an Array[6] of integers (0 - 255)');
    }

    return callNative('mifareClassicAuthenticateB', [sector, key]);
  }

  mifareClassicGetBlockCountInSector = (sector) => callNative('mifareClassicGetBlockCountInSector', [sector]);

  mifareClassicGetSectorCount = () => callNative('mifareClassicGetSectorCount');

  mifareClassicSectorToBlock = (sector) => callNative('mifareClassicSectorToBlock', [sector]);

  mifareClassicReadBlock = (block) => callNative('mifareClassicReadBlock', [block]);

  mifareClassicReadSector = (sector) => callNative('mifareClassicReadSector', [sector]);

  mifareClassicWriteBlock = (block, data) => {
    if (!data || !Array.isArray(data) || data.length !== this.MIFARE_BLOCK_SIZE) {
      return Promise.reject(`data should be a non-empty Array[${this.MIFARE_BLOCK_SIZE}] of integers (0 - 255)`);
    }

    return callNative('mifareClassicWriteBlock', [block, data]);
  }

  // -------------------------------------
  // (android) NfcTech.MifareUltralight API
  // -------------------------------------
  mifareUltralightReadPages = (pageOffset) => callNative('mifareUltralightReadPages', [pageOffset]);

  mifareUltralightWritePage = (pageOffset, data) => {
    if (!data || !Array.isArray(data) || data.length !== this.MIFARE_ULTRALIGHT_PAGE_SIZE) {
      return Promise.reject(`data should be a non-empty Array[${this.MIFARE_ULTRALIGHT_PAGE_SIZE}] of integers (0 - 255)`);
    }

    return callNative('mifareUltralightWritePage', [pageOffset, data]);
  }

  // -------------------------------------
  // (android) setTimeout works for NfcA, NfcF, IsoDep, MifareClassic, MifareUltralight
  // -------------------------------------
  setTimeout = (timeout) => callNative('setTimeout', [timeout]);

  connect = (techs) => callNative('connect', [techs]);

  close = () => callNative('close');

  // -------------------------------------
  // (android) transceive works for NfcA, NfcB, NfcF, NfcV, IsoDep and MifareUltralight
  // -------------------------------------
  transceive = (bytes) => callNative('transceive', [bytes]);

  getMaxTransceiveLength = () => callNative('getMaxTransceiveLength');

  // -------------------------------------
  // (iOS) NfcTech.MifareIOS API
  // -------------------------------------
  sendMifareCommandIOS = (bytes) => callNative('sendMifareCommand', [bytes]);

  // -------------------------------------
  // (iOS) NfcTech.IsoDep API
  // -------------------------------------
  sendCommandAPDUIOS = (bytesOrApdu) => {
    if (Platform.OS !== 'ios') {
      return Promise.reject('not implemented');
    }

    if (Array.isArray(bytesOrApdu)) {
      const bytes = bytesOrApdu;
      return new Promise((resolve, reject) => {
        NativeNfcManager.sendCommandAPDUBytes(bytes, (err, response, sw1, sw2) => {
          if (err) {
            reject(err);
          } else {
            resolve({response, sw1, sw2});
          }
        });
      })
    } else {
      const apdu = bytesOrApdu;
      return new Promise((resolve, reject) => {
        NativeNfcManager.sendCommandAPDU(apdu, (err, response, sw1, sw2) => {
          if (err) {
            reject(err);
          } else {
            resolve({response, sw1, sw2});
          }
        });
      })
    }
  }

  // -------------------------------------
  // private
  // -------------------------------------
  _subscribeNativeEvents = () => {
    this._subscriptions = {}
    this._clientListeners = {};
    this._subscriptions[NfcEvents.DiscoverTag] = NfcManagerEmitter.addListener(
      NfcEvents.DiscoverTag, this._onDiscoverTag
    );

    if (Platform.OS === 'ios') {
      this._subscriptions[NfcEvents.SessionClosed] = NfcManagerEmitter.addListener(
        NfcEvents.SessionClosed, this._onSessionClosedIOS
      );
    }

    if (Platform.OS === 'android') {
      this._subscriptions[NfcEvents.StateChanged] = NfcManagerEmitter.addListener(
        NfcEvents.StateChanged, this._onStateChangedAndroid
      );
    }
  }

  _onDiscoverTag = tag => {
    const callback = this._clientListeners[NfcEvents.DiscoverTag];
    if (callback) {
      callback(tag);
    }
  }

  _onSessionClosedIOS = () => {
    const callback = this._clientListeners[NfcEvents.SessionClosed];
    if (callback) {
      callback();
    }
  }

  _onStateChangedAndroid = state => {
    const callback = this._clientListeners[NfcEvents.StateChanged];
    if (callback) {
      callback(state);
    }
  }

  // -------------------------------------
  // Android private
  // -------------------------------------
  _hasTagEventRegistrationAndroid = () => callNative('hasTagEventRegistration');

  // -------------------------------------
  // iOS private
  // -------------------------------------
  _isSessionAvailableIOS = () => callNative('isSessionAvailable');

  _isSessionExAvailableIOS = () => callNative('isSessionExAvailable');

  _registerTagEventExIOS = (options = {}) => {
    const optionsWithDefault = {
      ...DEFAULT_REGISTER_TAG_EVENT_OPTIONS,
      ...options,
    };

    return callNative('registerTagEventEx', [optionsWithDefault]);
  }

  _unregisterTagEventExIOS = () => callNative('unregisterTagEventEx');

  // -------------------------------------
  // deprecated APIs 
  // -------------------------------------
  requestNdefWrite = (bytes, {format=false, formatReadOnly=false}={}) => callNative('requestNdefWrite', [bytes, {format, formatReadOnly}]);

  cancelNdefWrite = () => callNative('cancelNdefWrite');
}

export default new NfcManager();

export {
  ByteParser,
  NdefParser,
  NfcTech,
  NfcEvents,
  NfcAdapter,
  Ndef,
}
