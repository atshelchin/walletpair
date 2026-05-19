import ExpoModulesCore
import CoreBluetooth

public class BlePeripheralModule: Module {
  private var delegate: PeripheralDelegate?

  public func definition() -> ModuleDefinition {
    Name("BlePeripheral")

    Events("onWrite", "onSubscribe", "onUnsubscribe", "onConnect", "onDisconnect", "onMtuChanged")

    AsyncFunction("start") { (svcUuid: String, writeUuid: String, notifyUuid: String, name: String, promise: Promise) in
      self.delegate?.stop()
      let d = PeripheralDelegate(module: self, svcUuid: svcUuid, writeUuid: writeUuid, notifyUuid: notifyUuid, name: name)
      self.delegate = d
      d.start(promise: promise)
    }

    AsyncFunction("stop") {
      self.delegate?.stop()
      self.delegate = nil
    }

    AsyncFunction("sendNotification") { (base64Data: String) in
      self.delegate?.enqueueNotification(base64Data: base64Data)
    }

    // Batch send — all frames in one native call, avoids N JS↔Native round-trips
    AsyncFunction("sendBatch") { (base64Frames: [String]) in
      self.delegate?.enqueueBatch(base64Frames: base64Frames)
    }
  }

  func emit(_ name: String, _ body: [String: Any]) {
    sendEvent(name, body)
  }
}

private class PeripheralDelegate: NSObject, CBPeripheralManagerDelegate {
  private weak var module: BlePeripheralModule?
  private var manager: CBPeripheralManager?
  private var notifyChar: CBMutableCharacteristic?
  private var subscribedCentral: CBCentral?
  private var pendingPromise: Promise?
  private var sendQueue: [Data] = []

  private let svcUuid: CBUUID
  private let writeUuid: CBUUID
  private let notifyUuid: CBUUID
  private let deviceName: String

  init(module: BlePeripheralModule, svcUuid: String, writeUuid: String, notifyUuid: String, name: String) {
    self.module = module
    self.svcUuid = CBUUID(string: svcUuid)
    self.writeUuid = CBUUID(string: writeUuid)
    self.notifyUuid = CBUUID(string: notifyUuid)
    self.deviceName = name
    super.init()
  }

  func start(promise: Promise) {
    self.pendingPromise = promise
    self.manager = CBPeripheralManager(delegate: self, queue: nil)
  }

  func stop() {
    if let m = manager {
      if m.isAdvertising { m.stopAdvertising() }
      m.removeAllServices()
    }
    manager?.delegate = nil
    manager = nil
    subscribedCentral = nil
    pendingPromise = nil
    sendQueue.removeAll()
  }

  func enqueueNotification(base64Data: String) {
    guard let data = Data(base64Encoded: base64Data) else { return }
    sendQueue.append(data)
    drainQueue()
  }

  func enqueueBatch(base64Frames: [String]) {
    for b64 in base64Frames {
      if let data = Data(base64Encoded: b64) {
        sendQueue.append(data)
      }
    }
    drainQueue()
  }

  private func drainQueue() {
    guard let m = manager, let ch = notifyChar, let central = subscribedCentral else { return }
    while !sendQueue.isEmpty {
      let data = sendQueue.first!
      let ok = m.updateValue(data, for: ch, onSubscribedCentrals: [central])
      if ok {
        sendQueue.removeFirst()
      } else {
        // Queue full — peripheralManagerIsReady will resume
        return
      }
    }
  }

  // MARK: - CBPeripheralManagerDelegate

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    guard peripheral.state == .poweredOn else {
      let msg: String
      switch peripheral.state {
      case .unauthorized: msg = "unauthorized"
      case .unsupported: msg = "unsupported"
      case .poweredOff: msg = "powered off"
      default: msg = "unavailable (\(peripheral.state.rawValue))"
      }
      pendingPromise?.reject("BLE_ERROR", "Bluetooth is \(msg)")
      pendingPromise = nil
      return
    }

    let writeCh = CBMutableCharacteristic(
      type: writeUuid, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
    let notifyCh = CBMutableCharacteristic(
      type: notifyUuid, properties: [.notify, .read], value: nil, permissions: [.readable])
    self.notifyChar = notifyCh

    let svc = CBMutableService(type: svcUuid, primary: true)
    svc.characteristics = [writeCh, notifyCh]

    peripheral.add(svc)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error = error {
      pendingPromise?.reject("BLE_ERROR", error.localizedDescription)
      pendingPromise = nil
      return
    }
    peripheral.startAdvertising([
      CBAdvertisementDataLocalNameKey: deviceName,
      CBAdvertisementDataServiceUUIDsKey: [svcUuid]
    ])
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error = error {
      pendingPromise?.reject("BLE_ERROR", error.localizedDescription)
    } else {
      pendingPromise?.resolve(nil)
    }
    pendingPromise = nil
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    if characteristic.uuid == notifyUuid {
      subscribedCentral = central
      // Report MTU: central.maximumUpdateValueLength is the max bytes per notification
      let mtu = central.maximumUpdateValueLength
      module?.emit("onSubscribe", ["characteristicUuid": characteristic.uuid.uuidString.lowercased()])
      module?.emit("onMtuChanged", ["mtu": mtu])
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    if characteristic.uuid == notifyUuid {
      subscribedCentral = nil
      module?.emit("onUnsubscribe", ["characteristicUuid": characteristic.uuid.uuidString.lowercased()])
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    for request in requests {
      peripheral.respond(to: request, withResult: .success)
      if let value = request.value {
        module?.emit("onWrite", [
          "characteristicUuid": request.characteristic.uuid.uuidString.lowercased(),
          "value": value.base64EncodedString()
        ])
      }
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    request.value = notifyChar?.value ?? Data()
    peripheral.respond(to: request, withResult: .success)
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    drainQueue()
  }
}
