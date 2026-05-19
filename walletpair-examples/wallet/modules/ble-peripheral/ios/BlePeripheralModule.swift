import ExpoModulesCore
import CoreBluetooth

public class BlePeripheralModule: Module, CBPeripheralManagerDelegate {

  private var peripheralManager: CBPeripheralManager?
  private var service: CBMutableService?
  private var writeCharacteristic: CBMutableCharacteristic?
  private var notifyCharacteristic: CBMutableCharacteristic?
  private var subscribedCentral: CBCentral?
  private var pendingStart: ((Error?) -> Void)?

  // Store UUIDs for matching
  private var writeCharUUID: CBUUID?
  private var notifyCharUUID: CBUUID?

  public func definition() -> ModuleDefinition {
    Name("BlePeripheral")

    Events("onWrite", "onSubscribe", "onUnsubscribe", "onConnect", "onDisconnect")

    AsyncFunction("start") { (svcUuid: String, writeUuid: String, notifyUuid: String, name: String, promise: Promise) in
      // Stop any previous instance
      self.stopInternal()

      self.writeCharUUID = CBUUID(string: writeUuid)
      self.notifyCharUUID = CBUUID(string: notifyUuid)

      // Build GATT service
      let writeCh = CBMutableCharacteristic(
        type: CBUUID(string: writeUuid),
        properties: [.write, .writeWithoutResponse],
        value: nil,
        permissions: [.writeable]
      )
      self.writeCharacteristic = writeCh

      let notifyCh = CBMutableCharacteristic(
        type: CBUUID(string: notifyUuid),
        properties: [.notify, .read],
        value: nil,
        permissions: [.readable]
      )
      self.notifyCharacteristic = notifyCh

      let svc = CBMutableService(type: CBUUID(string: svcUuid), primary: true)
      svc.characteristics = [writeCh, notifyCh]
      self.service = svc

      // Store promise to resolve when advertising starts
      self.pendingStart = { error in
        if let error = error {
          promise.reject("BLE_ERROR", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }

      // Create peripheral manager (triggers delegate callback when ready)
      self.peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    }

    AsyncFunction("stop") { () in
      self.stopInternal()
    }

    AsyncFunction("sendNotification") { (base64Data: String) in
      guard let manager = self.peripheralManager,
            let characteristic = self.notifyCharacteristic,
            let central = self.subscribedCentral,
            let data = Data(base64Encoded: base64Data) else {
        return
      }
      manager.updateValue(data, for: characteristic, onSubscribedCentrals: [central])
    }
  }

  private func stopInternal() {
    if let manager = peripheralManager {
      if manager.isAdvertising {
        manager.stopAdvertising()
      }
      if let svc = service {
        manager.removeAllServices()
      }
    }
    peripheralManager?.delegate = nil
    peripheralManager = nil
    service = nil
    writeCharacteristic = nil
    notifyCharacteristic = nil
    subscribedCentral = nil
    pendingStart = nil
  }

  // MARK: - CBPeripheralManagerDelegate

  public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    if peripheral.state == .poweredOn {
      // Add service
      if let svc = self.service {
        peripheral.add(svc)
      }
    } else {
      let stateStr: String
      switch peripheral.state {
      case .unauthorized: stateStr = "unauthorized"
      case .unsupported: stateStr = "unsupported"
      case .poweredOff: stateStr = "powered off"
      default: stateStr = "unknown (\(peripheral.state.rawValue))"
      }
      let error = NSError(domain: "BlePeripheral", code: -1, userInfo: [
        NSLocalizedDescriptionKey: "Bluetooth is \(stateStr)"
      ])
      pendingStart?(error)
      pendingStart = nil
    }
  }

  public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error = error {
      pendingStart?(error)
      pendingStart = nil
      return
    }
    // Service added, start advertising with device name
    peripheral.startAdvertising([
      CBAdvertisementDataLocalNameKey: "WalletPair",
      CBAdvertisementDataServiceUUIDsKey: [service.uuid]
    ])
  }

  public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    pendingStart?(error)
    pendingStart = nil
    if error == nil {
      NSLog("[BlePeripheral] Advertising started")
    } else {
      NSLog("[BlePeripheral] Advertising failed: \(error!.localizedDescription)")
    }
  }

  public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    NSLog("[BlePeripheral] Central subscribed to \(characteristic.uuid)")
    if characteristic.uuid == notifyCharUUID {
      subscribedCentral = central
      sendEvent("onSubscribe", [
        "characteristicUuid": characteristic.uuid.uuidString
      ])
    }
  }

  public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    NSLog("[BlePeripheral] Central unsubscribed from \(characteristic.uuid)")
    if characteristic.uuid == notifyCharUUID {
      subscribedCentral = nil
      sendEvent("onUnsubscribe", [
        "characteristicUuid": characteristic.uuid.uuidString
      ])
    }
  }

  public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    for request in requests {
      // Always respond success
      peripheral.respond(to: request, withResult: .success)

      if let value = request.value {
        NSLog("[BlePeripheral] Write received on \(request.characteristic.uuid), \(value.count) bytes")
        sendEvent("onWrite", [
          "characteristicUuid": request.characteristic.uuid.uuidString,
          "value": value.base64EncodedString()
        ])
      }
    }
  }

  public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    request.value = notifyCharacteristic?.value ?? Data()
    peripheral.respond(to: request, withResult: .success)
  }
}
