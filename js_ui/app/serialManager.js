import _ from 'lodash'
import { observable } from 'mobx'
import SerialPort from 'serialport'
import childProcess from 'child_process'
import SerialReader from './serial_reader'
import SerialWriter from './serial_writer'
import SerialCodes from './serial_codes'
import { metaStore } from './store'

class SerialManager {
  @observable ports = []
  @observable portSelected
  @observable connected = false
  @observable busy = false
  currentSerialPort = null
  callbacks = {}

  constructor() {
    this.reader = new SerialReader(this._dataParsed)
    this.writer = new SerialWriter(this._rawSendData)

    this._forkWorker()

    this.refreshPorts(true)
  }

  refreshPorts = (autoconnect = false) => {
    if (!_.isBoolean(autoconnect)) autoconnect = false

    SerialPort.list((error, ports) => {
      if (error) {
        console.log('failed to get devices')
      } else {
        ports = _.map(ports, (port) => port.comName)
        ports = _.filter(ports, (port) => !port.match(/[Bb]luetooth/) && port.match(/\/dev\/cu/))
        this.ports = ports

        let defaultDevice = this._findDefaultDevice(this.ports)

        if (defaultDevice) {
          this.portSelected = defaultDevice
          if (autoconnect === true) this.connect()
        } else {
          this.portSelected = this.ports[0]
        }
      }
    })
  }

  connect = () => {
    this.busy = true
    this._forkWorker()
    this.worker.send(['connect', { port: this.portSelected }])
  }

  disconnect = () => {
    this.busy = true
    this.worker.send(['disconnect'])
  }

  send = (code, data, callback) => {
    if (!this.connected) return

    if (callback) {
      let callbackWrapper = this.callbacks[code];

      if (!callbackWrapper) {
        callbackWrapper = { handlers: [] }
        callbackWrapper.timer = setTimeout(() => {
          console.log(`request timed out: ${code}`);
        }, 1000);
        this.callbacks[code] = callbackWrapper;
      }

      callbackWrapper.handlers.push(callback);
    }

    if (code !== SerialCodes.REQUEST_GYRO_ACC)
      console.log('sending packet', code, data)

    this.writer.sendPacket(code, data)
  }

  _forkWorker() {
    this.worker = childProcess.fork('./app/serialWorker.js', { silent: false })
    this.worker.on('message', this._receivedWorkerMessage)
    this.worker.on('exit', this._workerExited)
    process.on('exit', () => this.worker.kill())
  }

  _workerExited = () => {
    this._clearCallbacks()
    this.connected = false
    this.busy = false
  }

  _isDefaultDevice(device) {
    return device.match(/usbmodem/)
  }

  _findDefaultDevice(devices) {
    return _.find(devices, (device) => this._isDefaultDevice(device))
  }

  _receivedWorkerMessage = (payload) => {
    const type = payload[0]
    const params = payload[1]

    switch(type) {
      case 'connect':
        this.connected = true
        this.busy = false
        break

      case 'data':
        this._onDataReceived(params.buffer.data)
        break

      default:
        console.log('unknown', type, params)
    }
  }

  _onDataReceived = (data) => {
    var data = new Uint8Array(data)

    data.forEach((value) => {
      this.reader.processCommand(value)
    })
  }

  _dataParsed = (code, data) => {
    if (code !== SerialCodes.REQUEST_GYRO_ACC)
      console.log('data parsed', code, data)

    switch(code) {
      case SerialCodes.REQUEST_CONFIG:
        metaStore.consoleMessage('Config data loaded')
        break
      case SerialCodes.INFO_SUCCESS:
        metaStore.consoleMessage('Controller responded with success')
        break
      case SerialCodes.INFO_FAILURE:
        metaStore.consoleMessage('Controller responded with failure')
        break
    }

    let callback = this.callbacks[code];

    if (callback) {
      _.each(callback.handlers, function(handler) {
        handler(data);
      });

      clearTimeout(callback.timer);
      this.callbacks = _.omit(this.callbacks, code);
    }
  }

  _rawSendData = (packetBuffer) => {
    if (!this.connected) {
      console.log('no ports open')
      return
    }
    const dataArray = Array.prototype.slice.call(packetBuffer)
    this.worker.send(['send', { data: dataArray }])
  }

  _clearCallbacks() {
    _.forOwn(this.callbacks, function(key, callback) {
      clearTimeout(callback.timer);
    });
    this.callbacks = {};
  }
}

const serialManager = new SerialManager()

export default serialManager